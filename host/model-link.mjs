import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { FrameSender } from "./transport.mjs";

export function modelEndpoint(value = "ws://127.0.0.1:8765/avl/model") {
  const url = URL.parse(value);
  if (!url || !["wss:", "ws:"].includes(url.protocol) || url.username || url.password ||
      url.href.includes("?") || url.href.includes("#"))
    throw Error("AVL_MODEL_WS must be a WS(S) endpoint without credentials, query or fragment");
  const local = ["localhost", "[::1]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol === "ws:" && !local)
    throw Error("AVL_MODEL_WS requires wss:// outside loopback");
  return url;
}

// The cloud is shared. This Host holds one authenticated connection even between subscriptions.
export function connectModel({ url, token, desktop, writeTimeout, onState }) {
  let current, retry, failures = 0, stopped = false;
  function publish(state, detail) {
    if (desktop.modelConnection?.state === state && desktop.modelConnection.detail === detail) return;
    desktop.modelConnection = { state, detail };
    onState(state, detail);
  }
  function dial() {
    const socket = new WebSocket(url, {
      headers: { Authorization: "Bearer " + token },
      followRedirects: false,
      rejectUnauthorized: true,
      handshakeTimeout: 5000,
      perMessageDeflate: false,
      maxPayload: 131072,
    });
    current = socket;
    let ready = false, lastSeen = performance.now(), ping, pingTime = -Infinity;
    let failure = ["retrying", "无法连接视觉服务，Host 将自动重连。请检查地址、网络及服务状态。"];
    const sender = new FrameSender(socket, writeTimeout, packet => {
      if (desktop.model !== sender || !desktop.streaming) return;
      const length = packet.readUInt32BE();
      if (JSON.parse(packet.toString("utf8", 4, 4 + length)).stream === desktop.stream)
        desktop.metrics.modelBytes += packet.length;
    });
    const terminate = () => socket.terminate();
    socket.on("unexpected-response", (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403)
        failure = ["unauthorized", "视觉服务拒绝此令牌，请检查 Host 和云端的凭据配置。"];
      else if (response.statusCode === 409)
        failure = ["duplicate", "此视觉身份已有 Host 在线，请检查令牌分配或关闭重复连接。"];
      terminate();
      response.destroy();
    });
    socket.on("error", error => {
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? ""))
        failure = ["retrying", "视觉服务 TLS 证书校验失败，请检查域名、证书链和 Host 信任的 CA。"];
    });
    socket.on("open", () => { lastSeen = performance.now(); });
    socket.on("message", (data, binary) => {
      if (stopped || current !== socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        if (binary) throw Error();
        const msg = JSON.parse(data.toString());
        if (!ready) {
          if (msg.type !== "hello" || msg.version !== 2) throw Error();
          desktop.attachModel(sender, msg.mode);
          ready = true;
          failures = 0;
          lastSeen = performance.now();
          publish("connected", "视觉服务已连接");
        } else if (msg.type === "pong" && ping && msg.id === ping && msg.t0 === pingTime) {
          desktop.metrics.clock(pingTime, msg.t1, msg.t2, performance.now());
          ping = null;
          lastSeen = performance.now();
        } else if (msg.type === "progress") {
          if (desktop.streaming && desktop.stream === msg.stream)
            desktop.metrics.progress(msg, performance.now());
        } else if (msg.type === "result") desktop.result(msg);
        else throw Error();
      } catch {
        failure = ["protocol-error", "视觉服务协议无效，请核对服务地址和协议版本。"];
        terminate();
      }
    });
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const now = performance.now();
      if (now - lastSeen > (ready ? 10000 : 5000)) {
        failure = ready ? ["retrying", "视觉服务心跳超时，Host 将自动重连。"]
          : ["protocol-error", "视觉服务握手超时，请检查该地址是否提供桌面视频协议。"];
        terminate();
      } else if (ready && !ping && now - pingTime >= 1000) {
        ping = randomUUID();
        pingTime = now;
        sender.send({ type: "ping", id: ping, t0: now });
      }
    }, 200).unref();
    socket.once("close", () => {
      clearInterval(heartbeat);
      sender.close();
      if (stopped || current !== socket) return;
      current = null;
      desktop.detachModel(sender);
      publish(...failure);
      const ceiling = Math.min(30000, 1250 * 2 ** Math.min(failures++, 5));
      const delay = ceiling * (0.8 + Math.random() * 0.2);
      retry = setTimeout(dial, delay).unref();
    });
  }
  publish("connecting", "正在连接视觉服务");
  dial();
  return () => {
    stopped = true;
    clearTimeout(retry);
    current?.terminate();
  };
}
