import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type DebugSession = {
  requestId: string;
  enabled: boolean;
  log: (event: string, payload?: unknown) => void;
  close: () => void;
};

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ _unserializable: true });
  }
}

export function createDebugSession(params: { enabled: boolean; dir?: string | undefined }): DebugSession {
  const requestId = randomUUID();
  const enabled = params.enabled;

  let stream: fs.WriteStream | null = null;
  if (enabled) {
    const dir = params.dir || path.join(process.cwd(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `oaiproxy-${requestId}.log`);
    stream = fs.createWriteStream(file, { flags: "a" });
  }

  const log = (event: string, payload?: unknown) => {
    if (!enabled) return;
    const line = `${nowIso()} ${event} ${payload === undefined ? "" : safeJson(payload)}\n`;
    process.stderr.write(line);
    stream?.write(line);
  };

  const close = () => {
    stream?.end();
    stream = null;
  };

  return { requestId, enabled, log, close };
}

