# oaiproxy

一个 Node.js 代理服务：对外提供 OpenAI **Chat Completions** 兼容接口，对内转发到 A2ABase Agents。

## 运行

```bash
cd oaiproxy
npm i
cp .env.example .env
npm run dev
```

## Debug（开发默认开启）

开发模式默认开启 debug（`OAIPROXY_DEBUG=1`）。每个请求会把关键事件与上游原始流片段写入日志，同时输出到 stderr。

- 响应头：`X-Request-Id`
- 日志文件：`oaiproxy/logs/oaiproxy-<requestId>.log`

## 重要：Agent 池同步/清理（破坏性）

启动时会同步 agent 池，并且为了满足平台 “max 10 agents” 的限制，**可能会删除账号内现存 agents**（优先删除不属于池/最旧的）。

- agent 名字不会包含明文 API key
- agent 命名：`oaiproxy__<kid>__01..08`（`<kid>` 为对 key 的单向派生）
- 明文 key 仅存在本地 `oaiproxy/agents.json`（已加入 `.gitignore`，为后续多 key 轮询做准备）

## 接口

- `POST /v1/chat/completions`
  - 支持：`model`, `messages`, `stream`, `stream_options.include_usage`（stream 默认 include_usage=true）
  - 当前阶段：忽略图片与 tool calls（后续再做）
