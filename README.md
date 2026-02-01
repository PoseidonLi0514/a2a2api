# oaiproxy

一个 Node.js 代理服务：对外提供 OpenAI **Chat Completions** 兼容接口，对内转发到 A2ABase Agents。

## 运行

```bash
cd oaiproxy
npm i
cp .env.example .env
npm run dev
```

## 管理后台（多 Key 管理）

管理页面：`/admin`

1. 打开 `http://<host>:<port>/admin`
2. 输入 `OAIPROXY_AUTH_TOKEN` 登录
3. 在「批量添加 Key」里每行粘贴一个 A2ABase API key，点击「添加并同步」

说明：
- A2ABase keys **只从本地 `oaiproxy/agents.json` 读取与保存**（不会从环境变量读取）
- agent 池按 key 单独维护，并在请求时做多 key 轮询

## 常见报错：`TypeError: fetch failed` / `ETIMEDOUT` / `ENETUNREACH`

这表示你的服务器 **连不上** `A2ABASE_API_URL`（例如 Cloudflare IPv6 不通或出网被防火墙拦截）。  
可以先试两个办法（只需要一个）：  

0) 如果你的机器需要走代理出网（你本机就是这种情况：`http_proxy/https_proxy`）：  
- 设置 `OAIPROXY_USE_ENV_PROXY=1` 让 Node `fetch` 读取 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`（见 `oaiproxy/.env.example:7`）

1) 强制走 IPv4（推荐）：
- 在环境变量里设置：`OAIPROXY_IPV4_ONLY=1`（见 `oaiproxy/.env.example:6`）

2) 调大/调小超时：
- 设置：`A2ABASE_TIMEOUT_MS=30000`（见 `oaiproxy/.env.example:10`）

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
  - 代理默认开启 A2ABase 的 `enable_thinking=true`；若请求带 `reasoning_effort`，会透传到 A2ABase（默认 `low`）

## 部署到服务器（建议 systemd）

1. 安装 Node.js 20+（你目前本地用的是 Node 22 也没问题）
2. 拉代码并安装依赖
   ```bash
   cd /opt
   git clone <your repo> a2abase
   cd a2abase/oaiproxy
   npm i
   npm run build
   ```
3. 配置环境变量（至少配置 `OAIPROXY_AUTH_TOKEN`）
   - 参考 `oaiproxy/.env.example:1`
4. 启动
   - 前台：`node dist/index.js`
   - 建议：用 systemd/pm2 保活，并用 Nginx 做 HTTPS 反向代理

### systemd 示例

- 示例文件：`oaiproxy/deploy/oaiproxy.service:1`
- 使用方式（按你的实际路径调整）：
  ```bash
  sudo cp oaiproxy/deploy/oaiproxy.service /etc/systemd/system/oaiproxy.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now oaiproxy
  sudo systemctl status oaiproxy --no-pager
  ```

启动后访问管理后台：`http://<host>:8080/admin`，登录后批量添加 A2ABase keys。

## 用 pm2 持久化运行（推荐）

1. 构建
   ```bash
   cd oaiproxy
   npm i
   npm run build
   ```
2. 配置 `.env`（至少 `OAIPROXY_AUTH_TOKEN`；若需要代理出网，设置 `OAIPROXY_USE_ENV_PROXY=1`）
3. 启动
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 status
   pm2 logs oaiproxy
   ```
4. 开机自启
   ```bash
   pm2 startup
   pm2 save
   ```
