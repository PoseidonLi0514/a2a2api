import type { ProxyConfig } from "./config.js";
import type { A2ABaseAgent } from "./types.js";
import { A2ABaseClient } from "./a2abaseClient.js";
import { agentNameFor, loadOrInitAgentsState, saveAgentsState, type AgentsStateFile, type KeyState } from "./agentsState.js";
import { AsyncMutex } from "./lock.js";

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

  constructor(private readonly config: ProxyConfig) {}

  async init(): Promise<void> {
    this.state = await loadOrInitAgentsState(this.config);
    // destructive sync at startup
    await this.syncAllKeys();
  }

  getDefaultA2ABaseClient(): A2ABaseClient {
    const key = this.state.keys[0];
    if (!key) throw new Error("No keys configured in agents.json");
    return new A2ABaseClient(this.config.a2abaseApiUrl, key.apiKey);
  }

  getA2ABaseClientForKey(keyIndex: number): A2ABaseClient {
    const key = this.getKeyState(keyIndex);
    return new A2ABaseClient(this.config.a2abaseApiUrl, key.apiKey);
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
    const client = new A2ABaseClient(this.config.a2abaseApiUrl, key.apiKey);

    const keyId = key.keyId!;
    const poolSize = Math.min(this.state.poolSizePerKey || this.config.poolSizePerKey, this.state.maxAgents || this.config.maxAgents);
    const expectedSlots = Array.from({ length: poolSize }, (_, i) => i + 1);
    const expectedNames = new Map<number, string>(expectedSlots.map((s) => [s, agentNameFor(keyId, s)]));

    // Fetch agents by prefix (search by keyId prefix).
    const prefixSearch = `oaiproxy__${keyId}__`;
    const foundBySearch = await client.listAgents({ page: 1, limit: 100, search: prefixSearch }).catch(() => ({ agents: [] as A2ABaseAgent[] }));
    const remoteCandidates = (foundBySearch.agents || []).filter((a) => a?.name?.includes(prefixSearch));

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

  async leaseAgent(): Promise<Lease> {
    // Current phase: single key only (index 0). Multi-key selection later.
    const keyIndex = 0;
    const key = this.getKeyState(keyIndex);
    const agents = key.agents || [];
    if (agents.length === 0) {
      await this.syncAllKeys();
      if (!key.agents || key.agents.length === 0) throw new Error("No agents available after sync");
    }

    const poolSize = key.agents!.length;
    const start = key.roundRobin ?? 0;
    for (let i = 0; i < poolSize; i++) {
      const idx = (start + i) % poolSize;
      const agent = key.agents![idx];
      const mutex = this.locksByAgentId.get(agent.id) || new AsyncMutex();
      this.locksByAgentId.set(agent.id, mutex);
      if (mutex.isLocked) continue;
      const release = await mutex.acquire();
      key.roundRobin = (idx + 1) % poolSize;
      await saveAgentsState(this.config, this.state);
      return { keyIndex, agentId: agent.id, release };
    }

    throw new Error("No free agent in pool (too many concurrent requests)");
  }
}
