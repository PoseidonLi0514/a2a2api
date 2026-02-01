import type {
  OpenAIChatCompletionsRequest,
  OpenAIChatMessage,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIUsage,
} from "./types.js";
import { newChatCompletionId } from "./crypto.js";

export function extractTextFromMessageContent(message: OpenAIChatMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string") {
      parts.push((part as any).text);
    }
  }
  return parts.join("");
}

export function buildSystemPrompt(messages: OpenAIChatMessage[]): string {
  const sys: string[] = [];
  for (const m of messages) {
    if (m.role !== "system") continue;
    const text = extractTextFromMessageContent(m).trim();
    if (text) sys.push(text);
  }
  return sys.join("\n\n");
}

export function buildLinearizedPrompt(messages: OpenAIChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const text = extractTextFromMessageContent(m);
    if (!text) continue;
    lines.push(`[${m.role.toUpperCase()}]\n${text}`);
  }
  return lines.join("\n\n");
}

export function normalizeUsage(usage: any): OpenAIUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const prompt_tokens = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const completion_tokens = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
  const total_tokens = Number(usage.total_tokens ?? usage.totalTokens ?? prompt_tokens + completion_tokens);
  const out: OpenAIUsage = {
    prompt_tokens,
    completion_tokens,
    total_tokens,
  };

  if (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object") {
    out.prompt_tokens_details = {
      cached_tokens: Number(usage.prompt_tokens_details.cached_tokens ?? 0),
      audio_tokens: Number(usage.prompt_tokens_details.audio_tokens ?? 0),
    };
  }
  if (usage.completion_tokens_details && typeof usage.completion_tokens_details === "object") {
    out.completion_tokens_details = {
      reasoning_tokens: Number(usage.completion_tokens_details.reasoning_tokens ?? 0),
      audio_tokens: Number(usage.completion_tokens_details.audio_tokens ?? 0),
      accepted_prediction_tokens: Number(usage.completion_tokens_details.accepted_prediction_tokens ?? 0),
      rejected_prediction_tokens: Number(usage.completion_tokens_details.rejected_prediction_tokens ?? 0),
    };
  }
  return out;
}

export function newStreamEnvelope(args: { id?: string; model: string; created?: number }): { id: string; created: number; model: string } {
  return { id: args.id || newChatCompletionId(), created: args.created || Math.floor(Date.now() / 1000), model: args.model };
}

export function makeRoleChunk(env: { id: string; created: number; model: string }): OpenAIChatCompletionChunk {
  return {
    id: env.id,
    object: "chat.completion.chunk",
    created: env.created,
    model: env.model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }],
    system_fingerprint: null,
  };
}

export function makeDeltaChunk(env: { id: string; created: number; model: string }, delta: string): OpenAIChatCompletionChunk {
  return {
    id: env.id,
    object: "chat.completion.chunk",
    created: env.created,
    model: env.model,
    choices: [{ index: 0, delta: { content: delta }, logprobs: null, finish_reason: null }],
    system_fingerprint: null,
  };
}

export function makeFinishChunk(env: { id: string; created: number; model: string }, finishReason: string): OpenAIChatCompletionChunk {
  return {
    id: env.id,
    object: "chat.completion.chunk",
    created: env.created,
    model: env.model,
    choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finishReason }],
    system_fingerprint: null,
  };
}

export function makeUsageChunk(env: { id: string; created: number; model: string }, usage: OpenAIUsage): OpenAIChatCompletionChunk {
  return {
    id: env.id,
    object: "chat.completion.chunk",
    created: env.created,
    model: env.model,
    choices: [],
    usage,
    system_fingerprint: null,
  };
}

export function makeNonStreamResponse(env: { id: string; created: number; model: string }, content: string, usage?: OpenAIUsage): OpenAIChatCompletion {
  return {
    id: env.id,
    object: "chat.completion",
    created: env.created,
    model: env.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null, annotations: [] },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage,
    system_fingerprint: null,
  };
}

export function shouldIncludeUsage(req: OpenAIChatCompletionsRequest): boolean {
  if (req.stream !== true) return false;
  // Default true for streaming unless explicitly false.
  const include = req.stream_options?.include_usage;
  return include !== false;
}

export function validateChatCompletionsRequest(body: any): OpenAIChatCompletionsRequest {
  if (!body || typeof body !== "object") throw new Error("Invalid JSON body");
  if (typeof body.model !== "string" || !body.model) throw new Error("Missing 'model'");
  if (!Array.isArray(body.messages)) throw new Error("Missing 'messages'");
  return body as OpenAIChatCompletionsRequest;
}

