import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { defineTool } from "@deepseek-ai/dsh-tools";
import WebSocket, { WebSocketServer } from "ws";
import { registerFixedWorkspace } from "./fixed-workspace.mjs";

const namespace = "/avl-desktop";
const dist = new URL("../../frontend/dist/", import.meta.url);
const maxPacket = 8 * 1024 * 1024 + 1028;
const maxBuffered = 2 * maxPacket;

export const name = "avl-computer-use";
export const inject = ["tools", "webServer", "connection"];

function owner(peer) {
  return peer?.principal.kind === "owner" && !peer.signal.aborted;
}

function admit(ctx, request, peer) {
  return peer ?? ctx.connection.admit(request).peer;
}

function proxyViewer(ctx, upstream, token) {
  const accepting = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  const connections = new Set();
  ctx.effect(() => () => {
    for (const close of connections) close();
    accepting.close();
  });
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: `${namespace}/socket`,
    handler(request, socket, head, admittedPeer) {
      const peer = admit(ctx, request, admittedPeer);
      if (!owner(peer)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      accepting.handleUpgrade(request, socket, head, browser => {
        const desktop = new WebSocket(upstream, {
          headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 5000,
          maxPayload: maxPacket, perMessageDeflate: false,
        });
        const close = () => {
          connections.delete(close);
          peer.signal.removeEventListener("abort", close);
          browser.terminate();
          desktop.terminate();
        };
        const relay = (source, target) => {
          source.on("message", (data, binary) => {
            if (source === browser && target.readyState === WebSocket.CONNECTING &&
                !binary && data.toString() === '{"type":"ping"}') return;
            if (target.readyState !== WebSocket.OPEN || target.bufferedAmount > maxBuffered) return close();
            target.send(data, { binary }, error => { if (error) close(); });
          });
          source.once("close", close);
          source.once("error", close);
        };
        connections.add(close);
        peer.signal.addEventListener("abort", close, { once: true });
        relay(browser, desktop);
        relay(desktop, browser);
      });
    },
  }));
}

async function panelAsset(request, peer) {
  if (!owner(peer)) return new Response("Forbidden", { status: 403 });
  const pathname = new URL(request.url).pathname;
  const file = pathname === namespace || pathname === `${namespace}/`
    ? "index.html" : pathname.slice(namespace.length + 1);
  if (file !== "index.html" && !/^assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(file)) {
    return new Response("Not found", { status: 404 });
  }
  const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
  const body = await readFile(new URL(file, dist)).catch(() => null);
  return body === null ? new Response("Build the desktop panel first", { status: 404 }) : new Response(body, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": file === "index.html" ? "no-store" : "private, max-age=31536000, immutable",
      "content-security-policy": "default-src 'self'; img-src 'self' blob:; frame-ancestors 'self'",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function apply(ctx) {
  const configuredUrl = process.env.AVL_DESKTOP_URL;
  const token = process.env.AVL_DESKTOP_TOKEN;
  if (!configuredUrl || !token) throw new Error("AVL_DESKTOP_URL and AVL_DESKTOP_TOKEN are required");
  const desktop = new URL(configuredUrl);
  if (!["http:", "https:"].includes(desktop.protocol) || desktop.username || desktop.password) {
    throw new Error("AVL_DESKTOP_URL must be an HTTP(S) endpoint without credentials");
  }
  if (desktop.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(desktop.hostname)) {
    throw new Error("Use HTTPS for a remote desktop service");
  }
  const stepUrl = new URL("/v1/step", desktop);
  const viewUrl = new URL("/v1/view", desktop);
  viewUrl.protocol = desktop.protocol === "https:" ? "wss:" : "ws:";
  let needsObservation = false;

  const workspace = process.env.AVL_WORKSPACE;
  const alias = process.env.AVL_SSH_HOST;
  if (workspace || alias) {
    if (!workspace || !alias) throw new Error("AVL_WORKSPACE and AVL_SSH_HOST must be set together");
    ctx.inject(["connection", "workspaceRegistry", "sessionController"], fixedCtx => {
      registerFixedWorkspace(fixedCtx, workspace, alias);
    });
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix", path: namespace,
    resource: (request, peer) => panelAsset(request, admit(ctx, request, peer)),
  }));
  proxyViewer(ctx, viewUrl, token);
  ctx.effect(() => ctx.tools.register(defineTool({
    name: "remote_desktop_step",
    description: "Ask the live visual model to observe the remote desktop and apply at most one GUI action. " +
      "Describe the immediate objective. Each result reports what the model saw and the action status. " +
      "If an action outcome is unknown, call this tool with observe_only=true before proceeding.",
    parameters: {
      instruction: { type: "string", required: true, description: "Immediate GUI objective or observation request" },
      observe_only: { type: "boolean", description: "Read visual state and prevent keyboard or mouse input" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute({ instruction, observe_only = false }, execution) {
      if (needsObservation && !observe_only) throw new Error("上次输入结果未知，请先使用 observe_only=true 观察。");
      const request_id = createHash("sha256")
        .update(JSON.stringify([execution.agent?.id, execution.callId])).digest("hex");
      let response;
      try {
        response = await fetch(stepUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ instruction, observe_only, request_id }),
          signal: AbortSignal.any([execution.signal, AbortSignal.timeout(70_000)]),
          redirect: "error",
        });
      } catch {
        if (!observe_only) needsObservation = true;
        throw new Error("桌面连接中断，输入结果未知。先观察，再决定下一步。");
      }
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const rejected = response.status === 409 && result?.detail?.state === "rejected";
        if (!observe_only && !rejected) needsObservation = true;
        throw new Error(result?.detail?.message ?? "桌面请求失败，结果未确认。");
      }
      if (!result?.action_status) {
        if (!observe_only) needsObservation = true;
        throw new Error("桌面动作回执无效，请先重新观察。");
      }
      if (observe_only) needsObservation = false;
      return JSON.stringify(result);
    },
  })));
}
