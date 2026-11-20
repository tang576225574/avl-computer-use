import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { parseFrame, type Ack, type Action, type Control, type Frame, type Status } from "./stream";
import "./style.css";

const names: Record<string, string> = {
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
  Enter: "Return", Backspace: "BackSpace", Escape: "Escape", " ": "space", Tab: "Tab",
  Delete: "Delete", Home: "Home", End: "End", PageUp: "Prior", PageDown: "Next",
  "-": "minus", "=": "equal", ".": "period", ",": "comma", "/": "slash", ";": "semicolon",
};

function DesktopPanel() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const connection = useRef<WebSocket | null>(null);
  const displayed = useRef<Frame | null>(null);
  const displayedAt = useRef(0);
  const ordinal = useRef(0);
  const waiting = useRef(new Map<string, Control["type"]>());
  const [connected, setConnected] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [fps, setFps] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let disposed = false;
    let reconnect: number | undefined;
    let delay = 400;
    let latest: Frame | null = null;
    let rendering = false;
    let generation = 0;
    const rendered: number[] = [];

    async function draw() {
      if (rendering || !latest) return;
      rendering = true;
      const written = latest;
      const expected = generation;
      latest = null;
      try {
        const bitmap = await createImageBitmap(written.image);
        try {
          const element = canvas.current;
          if (disposed || expected !== generation || !element) return;
          const context = element.getContext("2d");
          if (!context) return;
          if (element.width !== bitmap.width) element.width = bitmap.width;
          if (element.height !== bitmap.height) element.height = bitmap.height;
          context.drawImage(bitmap, 0, 0);
          displayed.current = written;
          displayedAt.current = performance.now();
          rendered.push(displayedAt.current);
        } finally {
          bitmap.close();
        }
      } catch {
        // A corrupt frame expires normally if no valid frame follows.
      } finally {
        rendering = false;
        if (latest) void draw();
      }
    }

    function open() {
      const url = new URL("/avl-desktop/socket", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      connection.current = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => { delay = 400; setConnected(true); };
      socket.onmessage = ({ data }) => {
        try {
          if (data instanceof ArrayBuffer) {
            latest = parseFrame(data);
            void draw();
            return;
          }
          const message = JSON.parse(data) as Status | Ack;
          if (message.type === "status") setStatus(message);
          if (message.type === "ack") {
            const kind = waiting.current.get(message.id);
            waiting.current.delete(message.id);
            if (message.status !== "ok") setNote(message.message ?? "操作未确认");
            else if (kind === "take") { setNote(""); canvas.current?.focus(); }
            else if (kind === "resume") setNote("");
          }
        } catch {
          socket.close(1002, "Invalid data");
        }
      };
      socket.onclose = () => {
        generation += 1;
        latest = null;
        displayed.current = null;
        displayedAt.current = 0;
        rendered.length = 0;
        connection.current = null;
        if (disposed) return;
        if ([...waiting.current.values()].includes("act")) setNote("连接中断，输入结果未知");
        waiting.current.clear();
        setConnected(false);
        setFresh(false);
        setStatus(null);
        setFps(0);
        reconnect = window.setTimeout(open, delay);
        delay = Math.min(delay * 2, 5000);
      };
    }

    const pulse = window.setInterval(() => {
      const socket = connection.current;
      if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 4096) socket.send('{"type":"ping"}');
    }, 1000);
    const measure = window.setInterval(() => {
      const now = performance.now();
      while (rendered[0] < now - 2000) rendered.shift();
      setFresh(displayedAt.current > 0 && now - displayedAt.current < 1500);
      const count = rendered.length;
      setFps(count > 1 ? (1000 * (count - 1)) / (rendered[count - 1] - rendered[0]) : 0);
    }, 250);
    open();

    return () => {
      disposed = true;
      window.clearInterval(pulse);
      window.clearInterval(measure);
      window.clearTimeout(reconnect);
      connection.current?.close();
      waiting.current.clear();
    };
  }, []);

  const live = connected && fresh && status !== null &&
    status.stream !== null && status.stream === displayed.current?.stream;
  const manual = live && status.human_owner;

  function send(control: Control) {
    const socket = connection.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 16_384) {
      setNote("连接暂不可用");
      return false;
    }
    const id = globalThis.crypto?.randomUUID?.() ?? String(performance.now() + Math.random());
    waiting.current.set(id, control.type);
    socket.send(JSON.stringify({ ...control, id }));
    return true;
  }

  function act(action: Action) {
    const frame = displayed.current;
    if (!manual || !frame || performance.now() - displayedAt.current > 1500) return false;
    ordinal.current += 1;
    return send({ type: "act", stream: frame.stream, seq: frame.seq, epoch: status.epoch, ordinal: ordinal.current, action });
  }

  function click(event: MouseEvent<HTMLCanvasElement>, button: number) {
    event.preventDefault();
    if (!manual) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const frame = displayed.current;
    if (!frame) return;
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
    const width = frame.width * scale;
    const height = frame.height * scale;
    const x = (event.clientX - rect.left - (rect.width - width) / 2) * 1000 / width;
    const y = (event.clientY - rect.top - (rect.height - height) / 2) * 1000 / height;
    if (x >= 0 && x <= 1000 && y >= 0 && y <= 1000) {
      act({ kind: "click", x: Math.round(x), y: Math.round(y), button });
    }
  }

  function keyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    if (!manual || event.key === "Tab") return;
    const key = names[event.key] ?? (/^[a-zA-Z0-9]$|^F[1-9][0-2]?$/.test(event.key) ? event.key.toLowerCase() : null);
    if (!key) return;
    event.preventDefault();
    const modifiers = [event.ctrlKey && "ctrl", event.shiftKey && "shift", event.altKey && "alt", event.metaKey && "super"];
    act({ kind: "key", key: [...modifiers.filter(Boolean), /^f[0-9]+$/.test(key) ? key.toUpperCase() : key].join("+") });
  }

  function typeText(event: FormEvent) {
    event.preventDefault();
    if (draft && act({ kind: "type", text: draft })) setDraft("");
  }

  const model = status?.model;
  return (
    <main className="desktop">
      <header className="toolbar">
        <div className="connection" role="status">
          <span className={live ? "dot online" : "dot"} />
          {live ? status.human_owner ? "人工操作中" : status.control === "agent" ? "Agent 控制" : status.control === "human" ? "其他窗口正在操作" : "输入已暂停"
                : connected ? "等待有效画面" : "正在连接桌面"}
        </div>
        <div className="metrics">
          {fps > 0 && <span>播放 {fps.toFixed(1)} fps</span>}
          {model && <span>模型收帧 {model.rx_fps.toFixed(1)} fps</span>}
          {model && <span>{model.mode === "simulator" ? "Qwen 模拟推理" : "模型编码"} {model.processed_fps.toFixed(1)} fps</span>}
          {model?.mode === "simulator" && model.dropped !== null && <span>抽样丢帧 {model.dropped}</span>}
        </div>
        <div className="controls">
          <button disabled={!live || status.control === "human"} onClick={() => send({ type: "take" })}>接管桌面</button>
          <button disabled={!live || !(manual || status.control === "paused")} onClick={() => send({ type: "resume" })}>交还 Agent</button>
        </div>
      </header>
      <section className="viewport" aria-label="远程桌面画面">
        <canvas ref={canvas} tabIndex={manual ? 0 : -1} aria-label="远程屏幕"
          onClick={event => click(event, 1)} onContextMenu={event => click(event, 3)} onKeyDown={keyDown}
          onWheel={event => { if (event.deltaY) act({ kind: "scroll", delta: event.deltaY < 0 ? -1 : 1 }); }} />
        {!live && <p className="offline">画面不可用，输入已暂停</p>}
      </section>
      <footer className="footer">
        {manual && <form onSubmit={typeText}>
          <label htmlFor="desktop-text">向桌面输入文字</label>
          <input id="desktop-text" value={draft} onChange={event => setDraft(event.target.value)} maxLength={2048} />
          <button disabled={!draft}>发送</button>
        </form>}
        {(note || (live && (!model?.ready || (model.mode === "full" && !model.meets_minimum)))) &&
          <p role="status">{note || (!model?.ready ? "视觉模型尚未就绪" : "模型处理帧率低于 12 fps")}</p>}
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<DesktopPanel />);
