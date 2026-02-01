import { createHash, randomUUID } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function keyIdForApiKey(apiKey: string): string {
  return sha256Hex(apiKey).slice(0, 12);
}

export function newChatCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

