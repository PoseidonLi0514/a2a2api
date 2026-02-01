import type { Response } from "express";

export function sendOpenAIError(res: Response, status: number, message: string, opts?: { type?: string; param?: string; code?: string }) {
  res.status(status).json({
    error: {
      message,
      type: opts?.type || "invalid_request_error",
      param: opts?.param || null,
      code: opts?.code || null,
    },
  });
}

export function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const anyErr = err as any;
  const name = String(anyErr.name || "");
  const message = String(anyErr.message || "");
  return name === "AbortError" || message.includes("aborted") || message.includes("This operation was aborted");
}
