import { Agent, EnvHttpProxyAgent, buildConnector, setGlobalDispatcher } from "undici";

export function configureNetworking(opts: { ipv4Only: boolean; useEnvProxy: boolean }) {
  if (opts.useEnvProxy) {
    // 让 fetch 读取 HTTP(S)_PROXY / NO_PROXY 等环境变量（默认 fetch 不会走系统代理）。
    setGlobalDispatcher(new EnvHttpProxyAgent());
    return;
  }

  if (opts.ipv4Only) {
    // 部分服务器 IPv6 不通 + Cloudflare 双栈解析会导致连接超时；强制走 IPv4。
    setGlobalDispatcher(
      new Agent({
        // undici connector 的 TS 类型要求更严格，这里仅设置 family=4 来影响底层 net.connect/dns 行为。
        connect: buildConnector({ family: 4 } as any),
      }),
    );
  }
}
