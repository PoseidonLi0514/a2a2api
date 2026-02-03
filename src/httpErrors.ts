import type { Response } from "express";

export function sendOpenAIError(res: Response, status: number, message: string, opts?: { type?: string; param?: string; code?: string }) {
  // 可能已经进入 SSE streaming 并发送了部分 chunk，此时再设置 status/header 会抛 ERR_HTTP_HEADERS_SENT。
  // 兼容策略：如果已发送 headers，则尽量发送 [DONE] 并直接结束连接，避免进程因异常崩溃。
  if (res.headersSent) {
    try {
      const ct = String(res.getHeader("Content-Type") || "");
      if (ct.toLowerCase().includes("text/event-stream")) {
        res.write("data: [DONE]\n\n");
      }
    } catch {
      // ignore
    }
    try {
      res.end();
    } catch {
      // ignore
    }
    return;
  }

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
