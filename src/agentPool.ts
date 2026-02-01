import type { ProxyConfig } from "./config.js";
import type { A2ABaseAgent } from "./types.js";
import { A2ABaseClient } from "./a2abaseClient.js";
import { agentNameFor, loadOrInitAgentsState, saveAgentsState, type AgentsStateFile, type KeyState } from "./agentsState.js";
import { AsyncMutex } from "./lock.js";
import { keyIdForApiKey } from "./crypto.js";

type Lease = { keyIndex: number; agentId: string; release: () => void };

function parseSlotFromName(keyId: string, name: string): number | null {
  const prefix = `oaiproxy__${keyId}__`;
  if (!name.startsWith(prefix)) return null;
  const suffix = name.slice(prefix.length);
  if (!/^\d\d$/.test(suffix)) return null;
  const slot = Number(suffix);
  if (!Number.isFinite(slot)) return null;
  return slot;
}

export class AgentPool {
  private state!: AgentsStateFile;
  private locksByAgentId = new Map<string, AsyncMutex>();
  private stateMutex = new AsyncMutex();

  constructor(private readonly config: ProxyConfig) {}

  async init(): Promise<void> {
    this.state = await loadOrInitAgentsState(this.config);
    // destructive sync at startup (if keys exist)
    if (this.state.keys.length > 0) {
      try {
        await this.syncAllKeys();
      } catch {
        // 启动阶段不因为同步失败而阻止服务启动（可在管理后台手动同步/修复）
      }
    }
  }

  getDefaultA2ABaseClient(): A2ABaseClient {
    const key = this.state.keys[0];
    if (!key) throw new Error("No keys configured in agents.json");
    return new A2ABaseClient(this.config.a2abaseApiUrl, key.apiKey, this.config.a2abaseTimeoutMs);
  }

  getA2ABaseClientForKey(keyIndex: number): A2ABaseClient {
    const key = this.getKeyState(keyIndex);
    return new A2ABaseClient(this.config.a2abaseApiUrl, key.apiKey, this.config.a2abaseTimeoutMs);
  }

  getStateSummary(): {
    version: number;
    maxAgents: number;
    poolSizePerKey: number;
    keys: Array<{
      label?: string;
      keyId: string;
      roundRobin: number;
      agentCount: number;
      agents: Array<{ slot: number; name: string; id: string }>;
    }>;
  } {
    return {
      version: this.state.version,
      maxAgents: this.state.maxAgents,
      poolSizePerKey: this.state.poolSizePerKey,
      keys: (this.state.keys || []).map((k) => ({
        label: k.label,
        keyId: k.keyId || "",
        roundRobin: k.roundRobin ?? 0,
        agentCount: (k.agents || []).length,
        agents: (k.agents || []).map((a) => ({ slot: a.slot, name: a.name, id: a.id })),
      })),
    };
  }

  async addKeys(apiKeys: string[], labelPrefix = "key"): Promise<{ added: number; skipped: number; errors: Array<{ keyId: string; error: string }> }> {
    const clean = apiKeys.map((k) => k.trim()).filter(Boolean);
    const toSyncKeyIds: string[] = [];
    let added = 0;
    let skipped = 0;

    const release = await this.stateMutex.acquire();
    try {
      const existingIds = new Set((this.state.keys || []).map((k) => k.keyId).filter(Boolean) as string[]);
      for (const apiKey of clean) {
        const keyId = keyIdForApiKey(apiKey);
        if (existingIds.has(keyId)) {
          skipped += 1;
          continue;
        }
        this.state.keys.push({
          label: `${labelPrefix}-${this.state.keys.length + 1}`,
          apiKey,
          keyId,
          roundRobin: 0,
          agents: [],
        });
        existingIds.add(keyId);
        toSyncKeyIds.push(keyId);
        added += 1;
      }
      await saveAgentsState(this.config, this.state);
    } finally {
      release();
    }

    const errors: Array<{ keyId: string; error: string }> = [];
    for (const keyId of toSyncKeyIds) {
      const idx = this.state.keys.findIndex((k) => k.keyId === keyId);
      if (idx === -1) continue;
      try {
        await this.syncKey(idx);
      } catch (e) {
        errors.push({ keyId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    await saveAgentsState(this.config, this.state);

    return { added, skipped, errors };
  }

  async removeKeyById(keyId: string, opts?: { deleteAgents?: boolean }): Promise<boolean> {
    let removed: { apiKey: string; agents: Array<{ id: string }> } | null = null;
    const release = await this.stateMutex.acquire();
    try {
      const idx = this.state.keys.findIndex((k) => k.keyId === keyId);
      if (idx === -1) return false;
      const key = this.state.keys[idx]!;
      removed = { apiKey: key.apiKey, agents: (key.agents || []).map((a) => ({ id: a.id })) };
      this.state.keys.splice(idx, 1);
      await saveAgentsState(this.config, this.state);
    } finally {
      release();
    }

    if (removed && opts?.deleteAgents !== false) {
      const client = new A2ABaseClient(this.config.a2abaseApiUrl, removed.apiKey, this.config.a2abaseTimeoutMs);
      for (const a of removed.agents) await client.deleteAgent(a.id).catch(() => undefined);
    }
    return true;
  }

  async syncKeyById(keyId: string): Promise<boolean> {
    const idx = this.state.keys.findIndex((k) => k.keyId === keyId);
    if (idx === -1) return false;
    await this.syncKey(idx);
    await saveAgentsState(this.config, this.state);
    return true;
  }

  private getKeyState(keyIndex: number): KeyState {
    const key = this.state.keys[keyIndex];
    if (!key) throw new Error(`Invalid keyIndex: ${keyIndex}`);
    if (!key.keyId) throw new Error("Key missing keyId");
    key.agents = key.agents ?? [];
    key.roundRobin = key.roundRobin ?? 0;
    return key;
  }

  async syncAllKeys(): Promise<void> {
    // For now: sync sequentially (safer + avoids rate spikes).
    for (let i = 0; i < this.state.keys.length; i++) {
      await this.syncKey(i);
    }
    await saveAgentsState(this.config, this.state);
  }

  private async listAllAgents(client: A2ABaseClient): Promise<A2ABaseAgent[]> {
    const agents: A2ABaseAgent[] = [];
    let page = 1;
    const limit = 100;
    while (page <= 20) {
      const resp = await client.listAgents({ page, limit });
      agents.push(...(resp.agents || []));
      const pages = resp.pagination?.pages;
      if (!pages || page >= pages) break;
      page += 1;
    }
    return agents;
  }

  private sortByCreatedAtAsc(a: A2ABaseAgent, b: A2ABaseAgent): number {
    return String(a.created_at).localeCompare(String(b.created_at));
  }

  private async syncKey(keyIndex: number): Promise<void> {
    const key = this.getKeyState(keyIndex);
    const client = new A2ABaseClient(this.config.a2abaseApiUrl, key.apiKey, this.config.a2abaseTimeoutMs);

    const keyId = key.keyId!;
    const poolSize = Math.min(this.state.poolSizePerKey || this.config.poolSizePerKey, this.state.maxAgents || this.config.maxAgents);
    const expectedSlots = Array.from({ length: poolSize }, (_, i) => i + 1);
    const expectedNames = new Map<number, string>(expectedSlots.map((s) => [s, agentNameFor(keyId, s)]));

    // 后端 search 语义不保证包含匹配；这里直接全量拉取并用 name 前缀过滤，避免误判“缺 slot”导致创建失败。
    const prefixSearch = `oaiproxy__${keyId}__`;
    const allAgentsInitial = await this.listAllAgents(client);
    const remoteCandidates = allAgentsInitial.filter((a) => typeof a?.name === "string" && a.name.startsWith(prefixSearch));

    const toDelete: A2ABaseAgent[] = [];
    const bySlot = new Map<number, A2ABaseAgent[]>();
    for (const a of remoteCandidates) {
      const slot = parseSlotFromName(keyId, a.name);
      if (!slot || !expectedNames.has(slot)) {
        toDelete.push(a);
        continue;
      }
      const arr = bySlot.get(slot) || [];
      arr.push(a);
      bySlot.set(slot, arr);
    }

    // Resolve duplicates per slot (keep one, delete rest).
    const keep: A2ABaseAgent[] = [];
    for (const slot of expectedSlots) {
      const arr = bySlot.get(slot) || [];
      if (arr.length === 0) continue;
      // Keep newest (created_at desc) to reduce chance it's stale.
      arr.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      keep.push(arr[0]);
      for (let i = 1; i < arr.length; i++) toDelete.push(arr[i]);
    }

    // Delete invalid/duplicate in our namespace first.
    for (const a of toDelete) {
      await client.deleteAgent(a.agent_id).catch(() => undefined);
    }

    // Recompute global agents for destructive cleanup if needed.
    const allAgents = await this.listAllAgents(client);
    const keepIds = new Set<string>();
    for (const a of keep) keepIds.add(a.agent_id);
    // Multi-key safety: do not delete agents that are already tracked for other keys.
    for (const k of this.state.keys) {
      for (const s of k.agents || []) keepIds.add(s.id);
    }
    const remoteCount = allAgents.length;

    // Determine missing slots.
    const missingSlots = expectedSlots.filter((slot) => !keep.some((a) => parseSlotFromName(keyId, a.name) === slot));

    // If we need to create but hit maxAgents, delete oldest agents not in keep.
    let needCreate = missingSlots.length;
    if (needCreate > 0 && remoteCount + needCreate > this.state.maxAgents) {
      const deletable = allAgents.filter((a) => !keepIds.has(a.agent_id));
      deletable.sort(this.sortByCreatedAtAsc);
      while (needCreate > 0 && (await this.listAllAgents(client)).length + needCreate > this.state.maxAgents) {
        const victim = deletable.shift();
        if (!victim) break;
        await client.deleteAgent(victim.agent_id).catch(() => undefined);
      }
    }

    // Create missing slots.
    const created: A2ABaseAgent[] = [];
    for (const slot of missingSlots) {
      const name = expectedNames.get(slot)!;
      const createdAgent = await client
        .createAgent({
          name,
          system_prompt: "You are a helpful AI assistant.",
        })
        .catch((e) => {
          throw new Error(`Failed to create agent ${name}: ${(e as Error).message}`);
        });
      created.push({
        agent_id: createdAgent.agent_id,
        name: createdAgent.name,
        system_prompt: createdAgent.system_prompt,
        created_at: new Date().toISOString(),
      });
    }

    const finalAgents = [...keep, ...created];
    finalAgents.sort((a, b) => {
      const sa = parseSlotFromName(keyId, a.name) ?? 0;
      const sb = parseSlotFromName(keyId, b.name) ?? 0;
      return sa - sb;
    });

    // Update state.
    key.agents = finalAgents.map((a) => ({
      slot: parseSlotFromName(keyId, a.name)!,
      name: a.name,
      id: a.agent_id,
    }));
  }

  private async tryLeaseFromKey(keyIndex: number): Promise<Lease | null> {
    const key = this.getKeyState(keyIndex);
    if (!key.agents || key.agents.length === 0) {
      await this.syncKey(keyIndex);
      if (!key.agents || key.agents.length === 0) return null;
      await saveAgentsState(this.config, this.state);
    }

    const poolSize = key.agents.length;
    const start = key.roundRobin ?? 0;
    for (let i = 0; i < poolSize; i++) {
      const idx = (start + i) % poolSize;
      const agent = key.agents[idx]!;
      const mutex = this.locksByAgentId.get(agent.id) || new AsyncMutex();
      this.locksByAgentId.set(agent.id, mutex);
      if (mutex.isLocked) continue;
      const release = await mutex.acquire();
      key.roundRobin = (idx + 1) % poolSize;
      await saveAgentsState(this.config, this.state);
      return { keyIndex, agentId: agent.id, release };
    }
    return null;
  }

  async leaseAgentAnyKey(): Promise<Lease> {
    if (this.state.keys.length === 0) throw new Error("No A2ABase keys configured in agents.json");

    const releaseState = await this.stateMutex.acquire();
    const start = this.state.globalRoundRobin ?? 0;
    this.state.globalRoundRobin = (start + 1) % this.state.keys.length;
    await saveAgentsState(this.config, this.state);
    releaseState();

    for (let i = 0; i < this.state.keys.length; i++) {
      const idx = (start + i) % this.state.keys.length;
      try {
        const lease = await this.tryLeaseFromKey(idx);
        if (lease) return lease;
      } catch {
        // key might be invalid/out of quota; try next key
        continue;
      }
    }

    throw new Error("No free agent across all keys (too many concurrent requests)");
  }
}
