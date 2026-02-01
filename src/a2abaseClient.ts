import type {
  A2ABaseAgentsResponse,
  A2ABaseCreateAgentRequest,
  A2ABaseCreateThreadResponse,
  A2ABaseStartAgentResponse,
} from "./types.js";

export class A2ABaseClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Accept: "application/json",
      "X-API-Key": this.apiKey,
      ...(extra || {}),
    };
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`A2ABase HTTP ${res.status}: ${text || res.statusText}`);
    }
    return (await res.json()) as T;
  }

  async listAgents(params?: {
    page?: number;
    limit?: number;
    search?: string;
    sort_by?: string;
    sort_order?: string;
  }): Promise<A2ABaseAgentsResponse> {
    const url = new URL(`${this.baseUrl}/agents`);
    if (params?.page) url.searchParams.set("page", String(params.page));
    if (params?.limit) url.searchParams.set("limit", String(params.limit));
    if (params?.search) url.searchParams.set("search", params.search);
    if (params?.sort_by) url.searchParams.set("sort_by", params.sort_by);
    if (params?.sort_order) url.searchParams.set("sort_order", params.sort_order);

    const res = await fetch(url, { method: "GET", headers: this.headers() });
    return await this.json<A2ABaseAgentsResponse>(res);
  }

  async createAgent(req: A2ABaseCreateAgentRequest): Promise<{ agent_id: string; name: string; system_prompt: string }> {
    const res = await fetch(`${this.baseUrl}/agents`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(req),
    });
    return await this.json(res);
  }

  async updateAgent(agentId: string, req: { name?: string; system_prompt?: string }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agents/${agentId}`, {
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`A2ABase updateAgent HTTP ${res.status}: ${text || res.statusText}`);
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agents/${agentId}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`A2ABase deleteAgent HTTP ${res.status}: ${text || res.statusText}`);
    }
  }

  async createThread(): Promise<A2ABaseCreateThreadResponse> {
    const res = await fetch(`${this.baseUrl}/threads`, {
      method: "POST",
      headers: this.headers(),
    });
    return await this.json<A2ABaseCreateThreadResponse>(res);
  }

  async addMessageToThread(threadId: string, message: string): Promise<{ message_id: string }> {
    const url = new URL(`${this.baseUrl}/threads/${threadId}/messages/add`);
    url.searchParams.set("message", message);
    const res = await fetch(url, {
      method: "POST",
      // Python SDK removes Content-Type for this call.
      headers: this.headers(),
    });
    return await this.json(res);
  }

  async startAgent(threadId: string, req: { agent_id: string; model_name?: string; stream?: boolean }): Promise<A2ABaseStartAgentResponse> {
    const res = await fetch(`${this.baseUrl}/thread/${threadId}/agent/start`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(req),
    });
    return await this.json<A2ABaseStartAgentResponse>(res);
  }

  async streamAgentRun(agentRunId: string, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/agent-run/${agentRunId}/stream`, {
      method: "GET",
      headers: this.headers(),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`A2ABase streamAgentRun HTTP ${res.status}: ${text || res.statusText}`);
    }
    return res;
  }
}

