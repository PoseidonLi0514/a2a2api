import fs from "node:fs/promises";
import type { ProxyConfig } from "./config.js";
import { keyIdForApiKey } from "./crypto.js";

export type AgentSlot = { slot: number; name: string; id: string };

export type KeyState = {
  label?: string;
  apiKey: string; // plaintext allowed in local JSON
  keyId?: string;
  roundRobin?: number;
  agents?: AgentSlot[];
};

export type AgentsStateFile = {
  version: 1;
  maxAgents: number;
  poolSizePerKey: number;
  globalRoundRobin?: number;
  keys: KeyState[];
};

export async function loadOrInitAgentsState(config: ProxyConfig): Promise<AgentsStateFile> {
  const raw = await fs.readFile(config.agentsFilePath, "utf8").catch(() => null);
  if (raw) {
    const parsed = JSON.parse(raw) as AgentsStateFile;
    if (!parsed.keys || !Array.isArray(parsed.keys)) throw new Error("Invalid agents.json: missing keys");
    parsed.maxAgents = parsed.maxAgents || config.maxAgents;
    parsed.poolSizePerKey = parsed.poolSizePerKey || config.poolSizePerKey;
    parsed.globalRoundRobin = parsed.globalRoundRobin ?? 0;
    for (const k of parsed.keys) {
      k.keyId = k.keyId || keyIdForApiKey(k.apiKey);
      k.roundRobin = k.roundRobin ?? 0;
      k.agents = k.agents ?? [];
    }
    return parsed;
  }

  const initial: AgentsStateFile = {
    version: 1,
    maxAgents: config.maxAgents,
    poolSizePerKey: config.poolSizePerKey,
    globalRoundRobin: 0,
    keys: [],
  };
  await saveAgentsState(config, initial);
  return initial;
}

export async function saveAgentsState(config: ProxyConfig, state: AgentsStateFile): Promise<void> {
  await fs.writeFile(config.agentsFilePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function agentNameFor(keyId: string, slot: number): string {
  const nn = String(slot).padStart(2, "0");
  return `oaiproxy__${keyId}__${nn}`;
}
