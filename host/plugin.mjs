import { readFileSync, closeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { connectModel, modelEndpoint } from "./model-link.mjs";
import { Desktop } from "./desktop.mjs";
import { Capture, x11Input } from "./x11.mjs";
import { FrameSender } from "./transport.mjs";
import { createSupervision } from "./supervision.mjs";
import { createInterruptNotifications } from "./notifications.mjs";

export const name = "avl-computer-use";
export const inject = ["tools", "webServer", "connection", "systemPrompt", "agents", "subagents", "sessions", "sessionPersistence"];
function integer(name, other, min, max) {
  const n = Number(process.env[name] ?? other);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error("Invalid " + name);
  return n;
}
function modelSecret() {
  let secret = process.env.AVL_MODEL_TOKEN;
  if (process.env.AVL_MODEL_TOKEN_FD === "3") {
    try {
      secret = readFileSync(3, "utf8");
      // The shell here-string appends one LF. The container memfd has no delimiter.
      if (secret.endsWith("\n")) secret = secret.slice(0, -1);
    } finally {
      closeSync(3);
    }
  }
  delete process.env.AVL_MODEL_TOKEN;
  delete process.env.AVL_MODEL_TOKEN_FD;
  delete process.env.AVL_MODEL_TOKENS;
  if (!secret || secret.length > 512 || /[^\x21-\x7e]/u.test(secret))
    throw Error("AVL_MODEL_TOKEN must contain 1–512 printable ASCII characters without spaces");
  return secret;
}
const ui = new URL("../frontend/dist/", import.meta.url);
async function asset(path) {
  const file =
    path === "/avl/" || path === "/avl" ? "index.html" : path.slice(5);
  if (file !== "index.html" && !/^assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(file))
    return new Response(null, { status: 404 });
  const content = await readFile(new URL(file, ui)).catch(() => null);
  if (!content)
    return new Response("Build the desktop frontend first", { status: 404 });
  return new Response(content, {
    headers: {
      "content-type": file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html; charset=utf-8",
      "cache-control":
        file === "index.html"
          ? "no-store"
          : "private, max-age=31536000, immutable",
      "content-security-policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'",
      "x-content-type-options": "nosniff",
    },
  });
}

export function apply(ctx) {
  const token = modelSecret();
  const url = modelEndpoint(process.env.AVL_MODEL_WS);
  // DSH resolves this credential from its launch snapshot. Desktop children inherit process.env.
  delete process.env.AVL_MAIN_API_KEY;
  ctx.systemPrompt.section({
    name: "tool:avl-desktop",
    order: ctx.systemPrompt.getSectionOrder("TOOL_COMPUTER_USE"),
    text: [
      "For tasks on the shared XFCE desktop, call desktop_stream_start once and wait for your turn. Keep the returned leaseId for the whole task.",
      "Pass that leaseId to every desktop_step and desktop_stream_stop. Observe with observe_only=true before acting and again if idle video has paused.",
      "Request one GUI action per step, inspect the resulting screen to verify changes, and call desktop_stream_stop on completion.",
      "Treat a lost input acknowledgement as an unknown outcome. Observe the current screen before deciding whether another action is needed.",
      "On a forced user interruption, stop the interrupted desktop task and wait for the user's direction. Use desktop_service_status or desktop_service_recover for managed processes. Pass your leaseId to recovery while holding control.",
    ].join(" "),
  });
  const timeout = integer("AVL_STREAM_WRITE_TIMEOUT_MS", 1000, 1, 2147483647);
  const notifications = createInterruptNotifications(ctx);
  ctx.effect(() => () => notifications.close());
  const synthetic = process.env.AVL_SYNTHETIC === "1";
  const capture = new Capture({
    fps: integer("AVL_CAPTURE_FPS", 24, 12, 24),
    synthetic,
    publish: (...args) => desktop.publish(...args),
    lost: (reason) => desktop.interrupted(reason),
  });
  const desktop = new Desktop({
    demand: (v) => capture.demand(v),
    input: synthetic
      ? async () => {
          throw Error("测试画面只允许观察");
        }
      : x11Input,
    idleMs: integer("AVL_STREAM_IDLE_MS", 60000, 100, 86400000),
    freshMs: integer("AVL_FRAME_FRESH_MS", 5000, 100, 60000),
    decisionMs: integer("AVL_STEP_TIMEOUT_MS", 30000, 100, 180000),
    onInterrupt: notifications.interrupt,
    onAlert: (reason) => ctx.logger.error("Desktop control: %s", reason),
  });
  const supervision = createSupervision({
    tryAutoRepair: (repair) => desktop.tryAutoRepair(repair),
    capture: {
      wanted: () => capture.wanted(),
      healthy: () => capture.healthy(),
      restart: () => {
        desktop.interrupted("采集超时，需要重新观察");
        capture.restart();
      },
    },
    onChange(state) {
      const log = state.state === "healthy" ? "info" : "warn";
      ctx.logger[log]("Desktop services %s %j", state.state, state.components);
    },
  });
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 131072,
  });
  let lastStatus = 0;
  const health = () => supervision.snapshot();
  const owner = (req, provided) => {
    const peer = provided ?? ctx.connection.admit(req).peer;
    return peer?.principal.kind === "owner" && !peer.signal.aborted
      ? peer
      : null;
  };
  const report = (peer) =>
    peer.send({ ...desktop.status(peer), services: health() });
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "prefix",
      path: "/avl",
      async resource(req, peer) {
        if (!owner(req, peer)) return new Response(null, { status: 403 });
        const path = new URL(req.url).pathname;
        if (path === "/avl/health")
          return Response.json(health(), {
            headers: { "cache-control": "no-store" },
          });
        return asset(path);
      },
    }),
  );

  function acceptViewer(socket, user, watching) {
    const sender = new FrameSender(socket, timeout);
    const finish = () => socket.terminate();
    const recentIds = new Set();
    let lastSeen = performance.now();
    socket.on("pong", () => { lastSeen = performance.now(); });
    const heartbeat = setInterval(() => {
      if (performance.now() - lastSeen > 10000) return finish();
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 2000).unref();
    desktop.addViewer(sender, watching);
    user.signal.addEventListener("abort", finish, { once: true });
    report(sender);
    const handle = async (data) => {
      const msg = JSON.parse(data.toString());
      if (
        typeof msg.id !== "string" ||
        msg.id.length > 100 ||
        !msg.id ||
        recentIds.has(msg.id)
      )
        throw Error("Invalid request ID");
      recentIds.add(msg.id);
      if (recentIds.size > 512)
        recentIds.delete(recentIds.values().next().value);
      try {
        await desktop.viewerCommand(sender, msg);
        sender.send({ type: "ack", id: msg.id, ok: true });
      } catch (error) {
        sender.send({
          type: "ack",
          id: msg.id,
          ok: false,
          error: error.message,
        });
      }
      report(sender);
    };
    socket.on("message", (data, binary) => {
      if (binary) return finish();
      void handle(data).catch(finish);
    });
    socket.on("error", finish);
    socket.once("close", () => {
      clearInterval(heartbeat);
      sender.close();
      user.signal.removeEventListener("abort", finish);
      desktop.removeViewer(sender);
    });
  }
  ctx.effect(() =>
    ctx.webServer.registerUpgrade({
      path: "/avl/view",
      handler(req, socket, head, provided) {
        const user = owner(req, provided);
        if (!user) return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        const watching = new URL(req.url, "http://localhost").searchParams.get("watch") !== "0";
        wss.handleUpgrade(req, socket, head, ws => acceptViewer(ws, user, watching));
      },
    }),
  );

  registerDesktopTools(ctx, desktop, supervision);

  ctx.effect(() => {
    const disconnect = connectModel({
      url, token, desktop, writeTimeout: timeout,
      onState(state, detail) {
        for (const viewer of desktop.viewers) report(viewer);
        ctx.logger[["connected", "connecting"].includes(state) ? "info" : "warn"]("Desktop vision: %s", detail);
      },
    });
    void supervision
      .start()
      .catch((error) =>
        ctx.logger.warn("Desktop supervision startup: %s", error.message),
      );
    const timer = setInterval(() => {
      const now = performance.now();
      desktop.tick();
      if (now - lastStatus >= 480) {
        lastStatus = now;
        for (const peer of desktop.videoSubscribers.keys()) report(peer);
      }
    }, 100).unref();
    return async () => {
      clearInterval(timer);
      disconnect();
      await desktop.close("Host 关闭");
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      capture.demand(false);
      await supervision.close();
    };
  });
}

export function registerDesktopTools(ctx, desktop, supervision) {
  function register(name, description, parameters, run) {
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          name,
          description,
          parameters,
          output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
          },
          async execute(args, execution) {
            execution.signal.throwIfAborted();
            const agent = execution.agent;
            if (!agent?.id || agent.id !== agent.session?.id)
              throw Error("Desktop tools require a DSH agent");
            return JSON.stringify(await run(args, agent, execution.signal));
          },
        }),
      ),
    );
  }
  const lease = {
    type: "string",
    required: true,
    description: "Current leaseId returned by desktop_stream_start",
  };
  register(
    "desktop_stream_start",
    "Wait for exclusive desktop control. Returns the leaseId for subsequent steps and release. Observe before acting.",
    {},
    (_, agent, signal) => {
      // Ordinary DSH forks have parentSession too, but own independent trees.
      return desktop.start(agent.id, signal, ctx.subagents.rootOf(agent).id);
    },
  );
  register(
    "desktop_step",
    "Observe the current task's video and optionally apply one GUI action on a confirmed fresh frame.",
    {
      leaseId: lease,
      instruction: {
        type: "string",
        required: true,
        description: "Immediate desktop objective",
      },
      observe_only: {
        type: "boolean",
        description: "Observe without making an input",
      },
    },
    (args, agent, signal) =>
      desktop.step(
        agent.id,
        args.leaseId,
        args.instruction,
        args.observe_only === true,
        signal,
      ),
  );
  register(
    "desktop_stream_stop",
    "End this session's desktop task and stop model video immediately.",
    { leaseId: lease },
    (args, agent) => desktop.stop(agent.id, args.leaseId),
  );
  register(
    "desktop_service_status",
    "Read local desktop component health and bounded recovery state.",
    {},
    () => supervision.snapshot(),
  );
  register(
    "desktop_service_recover",
    "Recheck one managed local service and request bounded recovery if unhealthy.",
    {
      leaseId: { type: "string", description: "Current leaseId if you hold the desktop" },
      component: {
        type: "string",
        required: true,
        description:
          "x11, xfce, dbus, wm, panel, terminal, novnc, sshd, or capture",
      },
    },
    (args, agent) => desktop.recover(agent.id, args.leaseId, () => supervision.request(args.component)),
  );
  ctx.on(
    "session/event",
    (session, event) => {
      if (event.type === "turn/end") {
        desktop.endSession(session.id, "会话轮次结束");
      }
    },
    { global: true },
  );
  ctx.on(
    "agent/disposed",
    ({ agent }) => {
      desktop.endSession(agent.id, "会话已释放");
    },
    { global: true },
  );
}
