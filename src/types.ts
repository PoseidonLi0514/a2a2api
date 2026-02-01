export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";

export type OpenAIChatMessage = {
  role: OpenAIChatRole;
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string; detail?: string } }
        | Record<string, unknown>
      >;
  name?: string;
  tool_calls?: unknown;
};

export type OpenAIChatCompletionsRequest = {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean | null;
  stream_options?: { include_usage?: boolean } | null;
  reasoning_effort?: string;
  tools?: unknown;
  tool_choice?: unknown;
};

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    audio_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
  };
};

export type OpenAIChatCompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string; refusal?: string | null; annotations?: unknown[] };
    logprobs: null;
    finish_reason: string;
  }>;
  usage?: OpenAIUsage;
  system_fingerprint?: string | null;
};

export type OpenAIChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<{ role: "assistant"; content: string }>;
    logprobs: null;
    finish_reason: string | null;
  }>;
  usage?: OpenAIUsage | null;
  system_fingerprint?: string | null;
};

export type A2ABaseAgent = {
  agent_id: string;
  name: string;
  system_prompt: string;
  created_at: string;
};

export type A2ABaseAgentsResponse = {
  agents: A2ABaseAgent[];
  pagination?: { page: number; limit: number; total: number; pages: number };
};

export type A2ABaseCreateAgentRequest = {
  name: string;
  system_prompt: string;
  description?: string;
  custom_mcps?: unknown;
  agentpress_tools?: unknown;
};

export type A2ABaseCreateThreadResponse = {
  thread_id: string;
  project_id: string;
};

export type A2ABaseStartAgentResponse = {
  agent_run_id: string;
  status: string;
};
