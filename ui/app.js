const STORAGE_TOKEN = "oaiproxy_admin_token";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

function getToken() {
  return localStorage.getItem(STORAGE_TOKEN) || "";
}

function setToken(token) {
  localStorage.setItem(STORAGE_TOKEN, token);
}

function clearToken() {
  localStorage.removeItem(STORAGE_TOKEN);
}

async function api(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

function maskKeyId(keyId) {
  if (!keyId) return "";
  return `${keyId.slice(0, 6)}…${keyId.slice(-4)}`;
}

function toastBox(message, kind = "") {
  return el("div", { class: `toast ${kind}`, text: message });
}

function loginView({ onDone }) {
  const input = el("input", { class: "input mono", placeholder: "输入 OAIPROXY_AUTH_TOKEN（Bearer）", type: "password", autocomplete: "off" });
  const status = el("div", { class: "muted", text: "只用于调用 /admin/api，不会上传到服务器保存。" });

  const submit = async () => {
    const token = input.value.trim();
    if (!token) return;
    setToken(token);
    try {
      await api("/admin/api/state", { method: "GET" });
      onDone();
    } catch (e) {
      clearToken();
      status.textContent = `登录失败：${e.message}`;
    }
  };

  return el("div", { class: "container" }, [
    el("div", { class: "card" }, [
      el("div", { class: "header" }, [
        el("div", {}, [
          el("div", { class: "title", text: "oaiproxy 管理后台" }),
          el("div", { class: "subtitle", text: "输入访问 oaiproxy 的管理 token，进入 Key 管理界面" }),
        ]),
      ]),
      el("div", { class: "content" }, [
        el("div", { class: "row" }, [input]),
        el("div", { class: "row", style: "margin-top:12px" }, [
          el("button", { class: "btn primary", text: "登录", onclick: submit }),
        ]),
        el("div", { style: "margin-top:12px" }, [status]),
      ]),
    ]),
  ]);
}

function keysManagerView() {
  const root = el("div", { class: "container" });
  const stateBox = el("div");
  const bulkArea = el("textarea", { class: "textarea", placeholder: "批量添加 A2ABase API Key：每行一个\n示例：pk_xxx:sk_xxx" });
  const bulkStatus = el("div");

  const refresh = async () => {
    stateBox.textContent = "";
    const data = await api("/admin/api/state", { method: "GET" });

    const header = el("div", { class: "header" }, [
      el("div", {}, [
        el("div", { class: "title", text: "Key 管理" }),
        el("div", { class: "subtitle", text: `keys=${data.keys.length} | poolSizePerKey=${data.poolSizePerKey} | maxAgents=${data.maxAgents}` }),
      ]),
      el("div", { class: "row" }, [
        el("button", {
          class: "btn",
          text: "同步全部",
          onclick: async () => {
            await api("/admin/api/sync", { method: "POST", body: JSON.stringify({}) });
            await refresh();
          },
        }),
        el("button", {
          class: "btn danger",
          text: "退出",
          onclick: () => {
            clearToken();
            location.reload();
          },
        }),
      ]),
    ]);

    const table = el("table", { class: "table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Key" }),
          el("th", { text: "Agents" }),
          el("th", { text: "操作" }),
        ]),
      ]),
      el("tbody", {}, data.keys.map((k) => renderKeyRow(k, refresh))),
    ]);

    stateBox.appendChild(el("div", { class: "card" }, [header, el("div", { class: "content" }, [table])]));
  };

  function renderKeyRow(k, refreshFn) {
    const details = el("details", {}, [
      el("summary", { class: "mono", text: `${k.label || "key"} (${maskKeyId(k.keyId)})` }),
      el("div", { style: "margin-top:10px" }, [
        el("div", { class: "pill mono", text: `keyId=${k.keyId}` }),
        el("div", { class: "pill mono", text: `rr=${k.roundRobin}` }),
        el("div", { class: "pill mono", text: `agents=${k.agentCount}` }),
        el("div", { style: "margin-top:10px" }, [
          el("table", { class: "table" }, [
            el("thead", {}, [
              el("tr", {}, [el("th", { text: "slot" }), el("th", { text: "name" }), el("th", { text: "id" })]),
            ]),
            el(
              "tbody",
              {},
              (k.agents || []).map((a) =>
                el("tr", {}, [
                  el("td", { class: "mono", text: String(a.slot) }),
                  el("td", { class: "mono", text: a.name }),
                  el("td", { class: "mono", text: a.id }),
                ]),
              ),
            ),
          ]),
        ]),
      ]),
    ]);

    const actions = el("div", { class: "key-actions" }, [
      el("button", {
        class: k.enabled ? "btn" : "btn primary",
        text: k.enabled ? "已启用" : "已禁用",
        onclick: async () => {
          await api(`/admin/api/keys/${k.keyId}/enabled`, {
            method: "POST",
            body: JSON.stringify({ enabled: !k.enabled }),
          });
          await refreshFn();
        },
      }),
      el("button", {
        class: "btn",
        text: "同步",
        onclick: async () => {
          await api(`/admin/api/keys/${k.keyId}/sync`, { method: "POST", body: JSON.stringify({}) });
          await refreshFn();
        },
      }),
      el("button", {
        class: "btn danger",
        text: "删除",
        onclick: async () => {
          const ok = confirm("确定删除该 key？会同时删除该 key 对应的 agent 池。");
          if (!ok) return;
          await api(`/admin/api/keys/${k.keyId}`, { method: "DELETE" });
          await refreshFn();
        },
      }),
    ]);

    return el("tr", { class: "key-row" }, [
      el("td", {}, [details]),
      el("td", {}, [
        el("div", { class: "row wrap" }, [
          el("span", { class: "pill mono", text: `${k.agentCount} agents` }),
          el("span", { class: `pill ${k.enabled ? "" : "warn"} mono`, text: k.enabled ? "enabled" : "disabled" }),
          k.disabledReason ? el("span", { class: "pill mono", text: `reason=${k.disabledReason}` }) : el("span"),
        ]),
      ]),
      el("td", {}, [actions]),
    ]);
  }

  const bulkCard = el("div", { class: "card" }, [
    el("div", { class: "header" }, [
      el("div", {}, [
        el("div", { class: "title", text: "批量添加 Key" }),
        el("div", { class: "subtitle", text: "每行一个 A2ABase API key（明文只会保存在本地 agents.json）" }),
      ]),
    ]),
    el("div", { class: "content" }, [
      bulkArea,
      el("div", { class: "row wrap", style: "margin-top:12px" }, [
        el("button", {
          class: "btn primary",
          text: "添加并同步",
          onclick: async () => {
            bulkStatus.textContent = "";
            const keys = bulkArea.value;
            if (!keys.trim()) return;
            const result = await api("/admin/api/keys/bulk", { method: "POST", body: JSON.stringify({ keys }) });
            bulkArea.value = "";
            const msg = `添加=${result.added}，跳过重复=${result.skipped}，错误=${(result.errors || []).length}`;
            bulkStatus.appendChild(toastBox(msg, (result.errors || []).length ? "err" : "ok"));
            if (result.errors && result.errors.length) {
              for (const e of result.errors) bulkStatus.appendChild(toastBox(`keyId=${maskKeyId(e.keyId)}: ${e.error}`, "err"));
            }
            await refresh();
          },
        }),
        el("div", { class: "spacer" }),
        el("button", { class: "btn", text: "刷新", onclick: refresh }),
      ]),
      bulkStatus,
    ]),
  ]);

  root.appendChild(el("div", { class: "grid" }, [bulkCard, stateBox]));

  refresh().catch((e) => {
    stateBox.appendChild(toastBox(`加载失败：${e.message}`, "err"));
  });
  return root;
}

async function bootstrap() {
  const app = document.getElementById("app");
  const token = getToken();
  const renderManager = () => {
    app.replaceChildren(keysManagerView());
  };

  if (token) {
    try {
      await api("/admin/api/state", { method: "GET" });
      renderManager();
      return;
    } catch {
      clearToken();
    }
  }

  app.replaceChildren(
    loginView({
      onDone: renderManager,
    }),
  );
}

bootstrap();
