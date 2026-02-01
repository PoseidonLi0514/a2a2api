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

