import "dotenv/config";
import express from "express";
import { loadConfig } from "./config.js";
import { AgentPool } from "./agentPool.js";
import { sendOpenAIError } from "./httpErrors.js";
import {
  buildLinearizedPrompt,
  buildSystemPrompt,
  makeDeltaChunk,
  makeFinishChunk,
  makeNonStreamResponse,
  makeRoleChunk,
  makeUsageChunk,
  newStreamEnvelope,
  normalizeUsage,
  shouldIncludeUsage,
  validateChatCompletionsRequest,
} from "./openai.js";
import { initSse, sseDone, sseSendJson } from "./sse.js";
import { parseA2ABaseStream } from "./a2abaseStream.js";

async function main() {
  const config = await loadConfig();
  const pool = new AgentPool(config);

  await pool.init();

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.use((req, res, next) => {
    const auth = req.header("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!token || token !== config.authToken) {
      return sendOpenAIError(res, 401, "Unauthorized", { code: "unauthorized" });
    }
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.post("/v1/chat/completions", async (req, res) => {
    const abort = new AbortController();
    req.on("close", () => abort.abort());

    let lease: { keyIndex: number; agentId: string; release: () => void } | undefined;
    try {
      const body = validateChatCompletionsRequest(req.body);

      const stream = body.stream === true;
      const includeUsage = shouldIncludeUsage(body);

      const systemPrompt = buildSystemPrompt(body.messages);
      const linearPrompt = buildLinearizedPrompt(body.messages);

      // Phase-1 behavior: ignore tools/images; we only use extracted text.
      const promptToSend = linearPrompt || "";
      const systemPromptToSend = systemPrompt || "You are a helpful AI assistant.";

      lease = await pool.leaseAgent();
      const client = pool.getA2ABaseClientForKey(lease.keyIndex);

      await client.updateAgent(lease.agentId, { system_prompt: systemPromptToSend });

      const thread = await client.createThread();
      await client.addMessageToThread(thread.thread_id, promptToSend);

      const started = await client.startAgent(thread.thread_id, {
        agent_id: lease.agentId,
        model_name: body.model,
        stream: true,
      });

      const env = newStreamEnvelope({ model: body.model });

      const upstreamRes = await client.streamAgentRun(started.agent_run_id, abort.signal);

      let fullText = "";
      let usageFromStatus: any | undefined;
      let usageFallback: any | undefined;
      let sawAssistant = false;

      if (stream) {
        initSse(res);
        sseSendJson(res, makeRoleChunk(env));
      }

      for await (const ev of parseA2ABaseStream(upstreamRes)) {
        if (abort.signal.aborted) break;
        const raw = ev.data;
        if (!raw || raw === "[DONE]") break;

        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }

        if (parsed?.type === "assistant") {
          let contentObj: any = parsed.content;
          if (typeof contentObj === "string") {
            try {
              contentObj = JSON.parse(contentObj);
            } catch {
              contentObj = null;
            }
          }
          const delta = typeof contentObj?.content === "string" ? contentObj.content : "";
          if (!delta) continue;
          sawAssistant = true;
          fullText += delta;
          if (stream) sseSendJson(res, makeDeltaChunk(env, delta));
          continue;
        }

        if (parsed?.type === "assistant_response_end") {
          // Upstream often provides an OpenAI-like object here (stringified).
          const rawContent = parsed.content;
          if (typeof rawContent === "string") {
            try {
              const obj = JSON.parse(rawContent);
              usageFallback = obj?.usage ?? usageFallback;
              // Also acts as a signal that assistant is done; we still wait for thread_run_end usage if available.
            } catch {
              // ignore
            }
          }
          continue;
        }

        if (parsed?.type === "status") {
          // content is a JSON string
          const rawContent = parsed.content;
          if (typeof rawContent === "string") {
            try {
              const obj = JSON.parse(rawContent);
              if (obj?.status_type === "thread_run_end" && obj?.usage) {
                usageFromStatus = obj.usage;
              }
            } catch {
              // ignore
            }
          }
          // Some status events may indicate completion.
          continue;
        }

        if (parsed?.status === "completed") break;
      }

      const usage = normalizeUsage(usageFromStatus || usageFallback);

      if (stream) {
        // If upstream never produced assistant tokens, still return a valid stream end.
        if (!sawAssistant) {
          // no-op
        }

        sseSendJson(res, makeFinishChunk(env, "stop"));
        if (includeUsage && usage) sseSendJson(res, makeUsageChunk(env, usage));
        sseDone(res);
        res.end();
        return;
      }

      res.status(200).json(makeNonStreamResponse(env, fullText, usage));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Map some common failures.
      if (msg.includes("Unauthorized")) return sendOpenAIError(res, 401, msg, { code: "unauthorized" });
      if (msg.includes("No free agent")) return sendOpenAIError(res, 429, msg, { code: "rate_limited" });
      return sendOpenAIError(res, 500, msg, { code: "internal_error" });
    } finally {
      lease?.release();
    }
  });

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[oaiproxy] listening on :${config.port}`);
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
