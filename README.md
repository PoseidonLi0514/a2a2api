# oaiproxy

Node.js proxy that exposes an OpenAI **Chat Completions** compatible API and forwards requests to A2ABase agents.

## Run

```bash
cd oaiproxy
npm i
cp .env.example .env
npm run dev
```

## Important: agent cleanup

On startup, oaiproxy syncs an agent pool and **may delete existing agents** to satisfy the platform limit (max 10 agents).

- Agent names never include the plaintext API key.
- Agent names follow: `oaiproxy__<kid>__01..08` where `<kid>` is derived from the API key (one-way).
- Plaintext keys (for future multi-key rotation) live only in local `oaiproxy/agents.json` (gitignored).

## Endpoint

- `POST /v1/chat/completions`
  - Supports: `model`, `messages`, `stream`, `stream_options.include_usage` (defaults to true when streaming)
  - Ignores: images and tool calls (current phase)
