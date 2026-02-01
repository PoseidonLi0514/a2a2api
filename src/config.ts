import fs from "node:fs/promises";
import path from "node:path";

export type ProxyConfig = {
  port: number;
  authToken: string;
  a2abaseApiUrl: string;
  maxAgents: number;
  poolSizePerKey: number;
  agentsFilePath: string;
  debug: boolean;
  debugDir?: string;
  a2abaseTimeoutMs: number;
  ipv4Only: boolean;
  useEnvProxy: boolean;
};

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid env ${name}: ${raw}`);
  return Math.floor(n);
}

export async function loadConfig(): Promise<ProxyConfig> {
  const port = parseIntEnv("PORT", 8080);
  const authToken = mustGetEnv("OAIPROXY_AUTH_TOKEN");
  const a2abaseApiUrl = (process.env["A2ABASE_API_URL"] || "https://a2abase.ai/api").replace(/\/$/, "");
  const maxAgents = parseIntEnv("OAIPROXY_MAX_AGENTS", 10);
  const poolSizePerKey = parseIntEnv("OAIPROXY_AGENT_POOL_SIZE", 8);
  const debug = (process.env["OAIPROXY_DEBUG"] || "").toLowerCase() === "1" || (process.env["NODE_ENV"] || "").toLowerCase() === "development";
  const debugDir = process.env["OAIPROXY_DEBUG_DIR"] || undefined;
  const a2abaseTimeoutMs = parseIntEnv("A2ABASE_TIMEOUT_MS", 30000);
  const ipv4Only = (process.env["OAIPROXY_IPV4_ONLY"] || "").toLowerCase() === "1";
  const hasProxyEnv = !!(
    process.env["HTTPS_PROXY"] ||
    process.env["https_proxy"] ||
    process.env["HTTP_PROXY"] ||
    process.env["http_proxy"]
  );
  const useEnvProxyRaw = (process.env["OAIPROXY_USE_ENV_PROXY"] || "").toLowerCase();
  const useEnvProxy = useEnvProxyRaw ? useEnvProxyRaw === "1" : hasProxyEnv;

  const agentsFilePath = path.join(process.cwd(), "agents.json");
  // Ensure file exists only when needed; writing handled by state layer.
  await fs.mkdir(process.cwd(), { recursive: true });

  return {
    port,
    authToken,
    a2abaseApiUrl,
    maxAgents,
    poolSizePerKey,
    agentsFilePath,
    debug,
    debugDir,
    a2abaseTimeoutMs,
    ipv4Only,
    useEnvProxy,
  };
}
