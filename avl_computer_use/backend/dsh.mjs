import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import WebSocket, { WebSocketServer } from "ws";
import { createHealthResponse, DesktopSupervision, isOwner as owner, OpsSsh } from "./desktop-supervision.mjs";
import { registerFixedWorkspace } from "./fixed-workspace.mjs";

const namespace = "/avl-desktop";
const dist = new URL("../../frontend/dist/", import.meta.url);
const maxPacket = 8 * 1024 * 1024 + 1028;
const maxBuffered = 2 * maxPacket;

export const name = "avl-computer-use";
export const inject = ["tools", "webServer", "connection"];

function admit(ctx, request, peer) {
  return peer ?? ctx.connection.admit(request).peer;
}

function streamWriteTimeout() {
  const value = process.env.AVL_STREAM_WRITE_TIMEOUT_MS ?? "1000";
  const ms = Number(value);
  if (!/^\d+$/.test(value) || ms < 1 || ms > 2_147_483_647) {
    throw new Error("AVL_STREAM_WRITE_TIMEOUT_MS must be a positive 32-bit integer");
  }
  return ms;
}

export function createViewerSender(target, close, timeoutMs = streamWriteTimeout()) {
  const controls = [];
  let pendingFrame;
  let writeTimeout;
  let stopped = false;

  function sendNext() {
    if (stopped || writeTimeout !== undefined || (!controls.length && pendingFrame === undefined)) return;
    if (target.readyState !== WebSocket.OPEN) return close();
    const binary = controls.length === 0;
    const data = binary ? pendingFrame : controls.shift();
    if (binary) pendingFrame = undefined;
    writeTimeout = setTimeout(close, timeoutMs).unref();
    target.send(data, { binary }, error => {
      clearTimeout(writeTimeout);
      writeTimeout = undefined;
      if (error) close();
      else sendNext();
    });
  }

  return {
    offer(data, binary) {
      if (stopped) return;
      if (binary) pendingFrame = data;
      else if (controls.length >= 24) return close();
      else controls.push(data);
      sendNext();
    },
    stop() {
      stopped = true;
      clearTimeout(writeTimeout);
      controls.length = 0;
      pendingFrame = undefined;
    },
  };
}

function proxyViewer(ctx, upstream, token, timeoutMs) {
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
          if (!connections.delete(close)) return;
          sender.stop();
          peer.signal.removeEventListener("abort", close);
          browser.terminate();
          desktop.terminate();
        };
        const sender = createViewerSender(browser, close, timeoutMs);
        connections.add(close);
        peer.signal.addEventListener("abort", close, { once: true });
        browser.on("message", (data, binary) => {
          if (desktop.readyState === WebSocket.CONNECTING && !binary && data.toString() === '{"type":"ping"}') return;
          if (desktop.readyState !== WebSocket.OPEN || desktop.bufferedAmount > maxBuffered) return close();
          desktop.send(data, { binary }, error => { if (error) close(); });
        });
        desktop.on("message", sender.offer);
        for (const source of [browser, desktop]) {
          source.once("close", close);
          source.once("error", close);
        }
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
  const timeoutMs = streamWriteTimeout();
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
  const opsAlias = process.env.AVL_OPS_SSH_HOST;
  let checkWorkspace = async () => workspace ? "unavailable" : "disabled";
  if (workspace || alias) {
    if (!workspace || !alias) throw new Error("AVL_WORKSPACE and AVL_SSH_HOST must be set together");
    ctx.inject(["connection", "workspaceRegistry", "sessionController"], fixedCtx => {
      checkWorkspace = registerFixedWorkspace(fixedCtx, workspace, alias);
    });
  }

  let supervision;
  if (workspace || opsAlias) {
    if (!workspace) throw new Error("Operations SSH requires a fixed workspace");
    if (opsAlias === alias) throw new Error("Use a separate SSH alias for AVL_OPS_SSH_HOST");
    const credentialFile = process.env.AVL_SUDO_PASSWORD_FILE;
    delete process.env.AVL_SUDO_PASSWORD_FILE;
    if (credentialFile && credentialFile !== join(process.cwd(), "sudo-password")) {
      throw new Error("Invalid launcher sudo credential path");
    }
    const sudoPassword = credentialFile ? await readFile(credentialFile, "utf8") : undefined;
    if (credentialFile) await unlink(credentialFile);
    supervision = new DesktopSupervision({
      openOps: opsAlias ? () => new OpsSsh(opsAlias, { sudoPassword }) : undefined,
      workspace: () => checkWorkspace(),
      onTransition({ state, workspace, repairing, attempt, lastError }) {
        const message = `Desktop supervision: ${state}; workspace: ${workspace}` +
          (repairing ? `; recovering ${repairing} (attempt ${attempt}/3)` : "") +
          (lastError ? `; last repair failed: ${lastError}` : "");
        if (["healthy", "disabled"].includes(state) && workspace === "ready") ctx.logger.info(message);
        else ctx.logger.warn(message);
      },
    });
    ctx.effect(() => supervision.start());
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: `${namespace}/health`,
    resource: (request, peer) => createHealthResponse(
      supervision?.snapshot ?? { state: "disabled" }, admit(ctx, request, peer),
    ),
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix", path: namespace,
    resource: (request, peer) => panelAsset(request, admit(ctx, request, peer)),
  }));
  proxyViewer(ctx, viewUrl, token, timeoutMs);
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
      const health = supervision?.snapshot.components;
      if ([health?.x11, health?.backend].some(state => state && state !== "healthy")) {
        throw new Error("桌面服务正在恢复或不可用，请查看 DSH 的恢复告警。");
      }
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
