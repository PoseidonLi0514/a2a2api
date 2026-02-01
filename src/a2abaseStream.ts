type UpstreamEvent = { raw: string; data: string };

/**
 * Parses A2ABase upstream stream which resembles SSE "data: <json>" events.
 *
 * Notes:
 * - Upstream may include proper newlines (`\n\n`) or (as in `response.txt`) concatenate events.
 * - We therefore split by occurrences of "data: " rather than relying on newlines.
 */
export async function* parseA2ABaseStream(res: Response): AsyncGenerator<UpstreamEvent, void, unknown> {
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const first = buffer.indexOf("data:");
      if (first === -1) break;
      const next = buffer.indexOf("data:", first + 5);
      if (next === -1) break;
      const raw = buffer.slice(first, next);
      buffer = buffer.slice(next);
      const data = raw.replace(/^data:\s*/m, "").trim();
      if (data) yield { raw, data };
    }
  }

  const rest = buffer.trim();
  if (rest.includes("data:")) {
    const parts = rest.split(/(?=data:)/g);
    for (const p of parts) {
      const data = p.replace(/^data:\s*/m, "").trim();
      if (data) yield { raw: p, data };
    }
    return;
  }
  if (rest) yield { raw: rest, data: rest.replace(/^data:\s*/m, "").trim() };
}

