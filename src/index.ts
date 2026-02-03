import "dotenv/config";
import express from "express";
import { loadConfig } from "./config.js";
import { AgentPool } from "./agentPool.js";
import { isAbortError, sendOpenAIError } from "./httpErrors.js";
import { createDebugSession } from "./debug.js";
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
import { configureNetworking } from "./net.js";
import { asyncHandler } from "./asyncHandler.js";

function requireAuth(authToken: string) {
  return (req: any, res: any, next: any) => {
    const auth = req.header("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!token || token !== authToken) {
      return sendOpenAIError(res, 401, "Unauthorized", { code: "unauthorized" });
    }
    next();
  };
}

function isNoCreditsError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("http 402") &&
    (m.includes("no credits available") || m.includes("billing check failed") || m.includes("add credits"))
  );
}

async function main() {
  const config = await loadConfig();
  configureNetworking({ ipv4Only: config.ipv4Only, useEnvProxy: config.useEnvProxy });
  const pool = new AgentPool(config);

  await pool.init();

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Admin UI (no auth for static assets; API requires auth and is used after login in UI)
  app.use("/admin", express.static(new URL("../ui/", import.meta.url).pathname, { index: ["index.html"] }));

  // Admin API
  app.get("/admin/api/state", requireAuth(config.authToken), (_req, res) => {
    const state = pool.getStateSummary();
    // Mask api keys: only show keyId + last 4 chars
    res.json({
      ...state,
      keys: state.keys.map((k) => ({
        ...k,
        keyId: k.keyId,
      })),
    });
  });

  app.post(
    "/admin/api/keys/bulk",
    requireAuth(config.authToken),
    asyncHandler(async (req, res) => {
    const raw = typeof req.body?.keys === "string" ? req.body.keys : "";
    const keys = raw
      .split(/\r?\n/g)
      .map((s: string) => s.trim())
      .filter(Boolean);
    const result = await pool.addKeys(keys, "key");
    res.json(result);
    }),
  );

  app.delete(
    "/admin/api/keys/:keyId",
    requireAuth(config.authToken),
    asyncHandler(async (req, res) => {
    const keyId = String(req.params.keyId || "");
    const ok = await pool.removeKeyById(keyId, { deleteAgents: true });
    res.json({ ok });
    }),
  );

  app.post(
    "/admin/api/keys/:keyId/sync",
    requireAuth(config.authToken),
    asyncHandler(async (req, res) => {
      const keyId = String(req.params.keyId || "");
      const ok = await pool.syncKeyById(keyId);
      res.json({ ok });
    }),
  );

  app.post(
    "/admin/api/keys/:keyId/enabled",
    requireAuth(config.authToken),
    asyncHandler(async (req, res) => {
      const keyId = String(req.params.keyId || "");
      const enabled = !!req.body?.enabled;
      const ok = await pool.setKeyEnabled(keyId, enabled);
      res.json({ ok });
    }),
  );

  app.post(
    "/admin/api/sync",
    requireAuth(config.authToken),
    asyncHandler(async (_req, res) => {
      await pool.syncAllKeys();
      res.json({ ok: true });
    }),
  );

  app.post("/v1/chat/completions", requireAuth(config.authToken), async (req, res) => {
    const debug = createDebugSession({ enabled: config.debug, dir: config.debugDir });
    res.setHeader("X-Request-Id", debug.requestId);

    const abort = new AbortController();
    req.on("aborted", () => abort.abort());
    res.on("close", () => abort.abort());
    res.on("finish", () => debug.close());

    try {
      const body = validateChatCompletionsRequest(req.body);

      const stream = body.stream === true;
      const includeUsage = shouldIncludeUsage(body);

      const systemPrompt = buildSystemPrompt(body.messages);
      const linearPrompt = buildLinearizedPrompt(body.messages);

      // Phase-1 behavior: ignore tools/images; we only use extracted text.
      const promptToSend = linearPrompt || "";
      const systemPromptToSend = systemPrompt || "You are a helpful AI assistant.";

      debug.log("request.in", {
        path: req.path,
        stream,
        includeUsage,
        model: body.model,
        systemPromptChars: systemPromptToSend.length,
        promptChars: promptToSend.length,
      });

      const env = newStreamEnvelope({ model: body.model });
      if (stream) {
        initSse(res);
        sseSendJson(res, makeRoleChunk(env));
      }

      const maxAttempts = Math.max(1, pool.getStateSummary().keys.length);
      let sentAnyDelta = false;
      let lastErr: unknown = undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const lease = await pool.leaseAgentAnyKey();
        try {
          const client = pool.getA2ABaseClientForKey(lease.keyIndex);

          debug.log("agent.lease", { agentId: lease.agentId, keyIndex: lease.keyIndex, attempt });
          await client.updateAgent(lease.agentId, { system_prompt: systemPromptToSend });
          debug.log("agent.update.ok", {});

          const thread = await client.createThread();
          debug.log("thread.create.ok", { threadId: thread.thread_id });
          await client.createMessage(thread.thread_id, promptToSend);
          debug.log("thread.createMessage.ok", {});

          const started = await client.startAgent(thread.thread_id, {
            agent_id: lease.agentId,
            model_name: body.model,
            enable_thinking: true,
            reasoning_effort: typeof (body as any).reasoning_effort === "string" ? (body as any).reasoning_effort : "low",
            stream: true,
          });
          debug.log("agent.start.ok", { agentRunId: started.agent_run_id, status: started.status });

          const upstreamRes = await client.streamAgentRun(started.agent_run_id, abort.signal);
          debug.log("agent.stream.open", { status: upstreamRes.status, ok: upstreamRes.ok });

          let fullText = "";
          let usageFromStatus: any | undefined;
          let usageFallback: any | undefined;

          for await (const ev of parseA2ABaseStream(upstreamRes)) {
            if (abort.signal.aborted) break;
            const raw = ev.data;
            if (!raw || raw === "[DONE]") break;

            debug.log("a2abase.sse", { data: raw.slice(0, 2000), truncated: raw.length > 2000 });

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
              const textOrDelta = typeof contentObj?.content === "string" ? contentObj.content : "";
              if (!textOrDelta) continue;

              const delta = fullText && textOrDelta.startsWith(fullText) ? textOrDelta.slice(fullText.length) : textOrDelta;
              if (!delta) continue;

              sentAnyDelta = true;
              fullText += delta;
              if (stream) sseSendJson(res, makeDeltaChunk(env, delta));
              continue;
            }

            if (parsed?.type === "assistant_response_end") {
              const rawContent = parsed.content;
              if (typeof rawContent === "string") {
                try {
                  const obj = JSON.parse(rawContent);
                  usageFallback = obj?.usage ?? usageFallback;
                } catch {
                  // ignore
                }
              }
              continue;
            }

            if (parsed?.type === "status") {
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
              continue;
            }

            if (parsed?.status === "completed") break;
          }

          const usage = normalizeUsage(usageFromStatus || usageFallback);
          debug.log("result.usage", { hasUsage: !!usage, usage });

          if (stream) {
            // 按需求：当 include_usage 时，去掉 OpenAI 标准里的 “空 delta + finish_reason” 块，
            // 直接让 usage chunk 成为最后一个 JSON 块（再跟 [DONE]）。
            if (!includeUsage) sseSendJson(res, makeFinishChunk(env, "stop"));
            if (includeUsage && usage) sseSendJson(res, makeUsageChunk(env, usage));
            sseDone(res);
            res.end();
            debug.log("response.stream.done", { bytes: fullText.length });
            return;
          }

          res.status(200).json(makeNonStreamResponse(env, fullText, usage));
          debug.log("response.json.done", { bytes: fullText.length });
          return;
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          if (isNoCreditsError(msg)) {
            debug.log("key.auto_disable", { keyIndex: lease.keyIndex, reason: "no_credits", sentAnyDelta });
            await pool.disableKeyByIndex(lease.keyIndex, "no_credits");
            if (!sentAnyDelta) continue;
          }
          throw e;
        } finally {
          lease.release();
        }
      }

      throw (lastErr instanceof Error ? lastErr : new Error("No enabled key could complete the request"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      debug.log("error", { message: msg, name: (e as any)?.name, aborted: abort.signal.aborted });
      // Map some common failures.
      if (msg.includes("Unauthorized")) return sendOpenAIError(res, 401, msg, { code: "unauthorized" });
      if (msg.includes("No free agent")) return sendOpenAIError(res, 429, msg, { code: "rate_limited" });
      if (abort.signal.aborted || isAbortError(e)) return sendOpenAIError(res, 499, "Client or upstream aborted request", { code: "request_aborted" });
      return sendOpenAIError(res, 500, msg, { code: "internal_error" });
    } finally {
      debug.close();
    }
  });

  // Error handler (Express 4 does not catch async throw by default)
  app.use((err: any, _req: any, res: any, _next: any) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: { message, code: "upstream_error" } });
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
