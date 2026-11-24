import { useEffect, useRef, useState } from "react";
import { CommandChannel, FramePainter, parseFrame } from "./viewer.js";

export function useDesktop(canvas) {
  const [state, setState] = useState("connecting");
  const [status, setStatus] = useState(null);
  const [display, setDisplay] = useState(null);
  const [fresh, setFresh] = useState(false);
  const [notice, setNotice] = useState("");
  const channel = useRef(null);
  const frame = useRef(null);

  useEffect(() => {
    const pane = window.frameElement;
    const isVisible = () => !document.hidden && pane?.getAttribute("data-avl-visible") !== "false";
    let stopped = false, pageActive = true, visible = isVisible();
    let socket, commands, painter, retry, failures = 0, videoRevision = 0;
    let receiving = false;

    function clearFrame() {
      receiving = false;
      painter?.close();
      painter = undefined;
      frame.current = null;
      if (stopped) return;
      setDisplay(null);
      setFresh(false);
      const screen = canvas.current;
      screen?.getContext("2d")?.clearRect(0, 0, screen.width, screen.height);
    }
    function disconnect() {
      clearTimeout(retry);
      videoRevision++;
      clearFrame();
      commands?.close();
      channel.current = null;
      const active = socket;
      socket = undefined;
      if (active && active.readyState < WebSocket.CLOSING) active.close();
      if (!stopped) {
        setStatus(null);
        setNotice("");
      }
    }
    function badPacket() {
      if (!socket) return;
      setNotice("画面格式异常，正在重新建立连接");
      socket.close(1002, "Invalid desktop packet");
    }
    function makePainter() {
      return new FramePainter(jpeg => createImageBitmap(new Blob([jpeg], { type: "image/jpeg" })), (image, header) => {
        const screen = canvas.current;
        if (!screen || !receiving) return;
        if (image.width !== header.width || image.height !== header.height) throw new Error("Frame dimensions differ");
        if (screen.width !== header.width) screen.width = header.width;
        if (screen.height !== header.height) screen.height = header.height;
        screen.getContext("2d", {alpha:false}).drawImage(image, 0, 0);
        const previous = frame.current;
        frame.current = header;
        if (!previous || previous.width !== header.width || previous.height !== header.height) {
          setDisplay({width:header.width, height:header.height});
        }
        setFresh(performance.now() - header.receivedAt <= 2000);
      }, () => { if (receiving) badPacket(); });
    }
    async function updateVideo() {
      const revision = ++videoRevision;
      clearFrame();
      if (socket?.readyState !== WebSocket.OPEN) return;
      const ws = socket;
      setState(visible ? "connected" : "hidden");
      try {
        // A background tab can suspend JS timers. Socket closure still rejects pending subscriptions.
        await commands.send({type:"watch", enabled:visible}, null);
        // Old frames already in TCP precede the ack. Rapid hide/show also invalidates old decodes.
        if (revision === videoRevision && socket === ws && visible) {
          receiving = true;
          painter = makePainter();
        }
      } catch (error) {
        if (revision === videoRevision && socket === ws) setNotice(error.message);
      }
    }
    function connect() {
      if (stopped || !pageActive || !visible || socket) return;
      clearTimeout(retry);
      setState(failures ? "reconnecting" : "connecting");
      const url = new URL("/avl/view?watch=0", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket = ws;
      ws.binaryType = "arraybuffer";
      const active = () => !stopped && socket === ws;
      commands = new CommandChannel(message => {
        if (!active() || ws.readyState !== WebSocket.OPEN) throw new Error("桌面连接已关闭");
        ws.send(JSON.stringify(message));
      });
      ws.onopen = () => {
        if (!active()) return;
        channel.current = commands;
        void updateVideo();
      };
      ws.onmessage = ({ data }) => {
        if (!active()) return;
        try {
          if (typeof data !== "string") {
            if (!receiving || !visible) return;
            const packet = parseFrame(data);
            packet.header.receivedAt = performance.now();
            painter.offer(packet);
          } else {
            const message = JSON.parse(data);
            if (message.type === "ack") commands.ack(message);
            if (message.type === "status") {
              failures = 0;
              setStatus(message);
            }
          }
        } catch { badPacket(); }
      };
      ws.onclose = () => {
        if (!active()) return;
        disconnect();
        setState(visible ? "reconnecting" : "hidden");
        failures += 1;
        if (visible) retry = setTimeout(connect, Math.min(8000, 500 * 2 ** Math.min(failures - 1, 4)));
      };
      ws.onerror = () => { if (active()) ws.close(); };
    }
    function visibility() {
      const next = isVisible();
      if (next !== visible) {
        visible = next;
        if (!visible) setState("hidden");
        void updateVideo();
      }
      if (visible && !socket) connect();
    }
    function leavePage() {
      pageActive = false;
      disconnect();
    }
    function enterPage() {
      pageActive = true;
      visibility();
    }
    const observer = new MutationObserver(visibility);
    if (pane) observer.observe(pane, {attributes:true, attributeFilter:["data-avl-visible"]});
    const freshness = setInterval(() => {
      if (frame.current && performance.now() - frame.current.receivedAt > 2000) setFresh(false);
    }, 500);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", leavePage);
    window.addEventListener("pageshow", enterPage);
    if (visible) connect(); else setState("hidden");
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", leavePage);
      window.removeEventListener("pageshow", enterPage);
      observer.disconnect();
      clearInterval(freshness);
      disconnect();
    };
  }, [canvas]);

  async function send(command) {
    const target = channel.current;
    const current = frame.current;
    if (!target) return false;
    if (command.type === "act" && (!current || !status?.owner || status.control !== "human" || performance.now() - current.receivedAt > 2000)) {
      setNotice("请在获得控制权并看到新画面后操作。");
      return false;
    }
    try {
      const message = command.type === "act" ? {...command, stream:current.stream, seq:current.seq} : command;
      await target.send(message);
      if (channel.current === target) setNotice("");
      return true;
    } catch (error) {
      if (channel.current === target) setNotice(error.message);
      return false;
    }
  }
  return { state, status, display, fresh, notice, setNotice, frame, send };
}
