const decoder = new TextDecoder("utf-8", { fatal: true });

export function desktopControls(status, fresh) {
  const manual = status?.control === "human" && status.owner === true;
  const paused = status?.control === "paused" && status.controlError == null;
  const canTake = (status?.control === "agent" || paused) &&
    (status.leaseId === null || typeof status.leaseId === "string");
  return {
    manual,
    canAct: manual && fresh,
    canResume: manual || paused,
    take: canTake ? {type:"take", leaseId:status.leaseId} : null
  };
}

export function parseFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) throw new Error("视频帧不完整");
  const length = new DataView(buffer).getUint32(0);
  const offset = 4 + length;
  if (length < 2 || length > 1024 || offset + 4 > buffer.byteLength || buffer.byteLength - offset > 8 * 1024 * 1024) {
    throw new Error("视频帧长度异常");
  }
  const header = JSON.parse(decoder.decode(new Uint8Array(buffer, 4, length)));
  if (!header || typeof header.stream !== "string" || !header.stream || !Number.isSafeInteger(header.seq) || header.seq < 0 ||
      ![header.width, header.height].every(x => Number.isInteger(x) && x > 0 && x <= 16384) ||
      !Number.isFinite(header.capturedMs)) throw new Error("视频帧头无效");
  const jpeg = new Uint8Array(buffer, offset);
  if (jpeg[0] !== 255 || jpeg[1] !== 216 || jpeg.at(-2) !== 255 || jpeg.at(-1) !== 217) {
    throw new Error("收到不完整的 JPEG 画面");
  }
  return { header, jpeg };
}

export class FramePainter {
  constructor(decode, paint, onError = () => {}) {
    this.decode = decode;
    this.paint = paint;
    this.onError = onError;
  }
  offer(frame) {
    if (this.closed) return;
    this.pending = frame;
    if (!this.busy) void this.drain();
  }
  async drain() {
    this.busy = true;
    while (this.pending && !this.closed) {
      const { jpeg, header } = this.pending;
      this.pending = null;
      let bitmap;
      try {
        bitmap = await this.decode(jpeg);
        if (!this.closed && (!this.pending || this.pending.header.stream === header.stream)) {
          this.paint(bitmap, header);
        }
      } catch (error) {
        if (!this.closed) this.onError(error);
      } finally {
        bitmap?.close();
      }
    }
    this.busy = false;
  }
  close() {
    this.closed = true;
    this.pending = null;
  }
}

export function pointOnScreen(box, frame, clientX, clientY) {
  if (!frame || box.width <= 0 || box.height <= 0) return null;
  const ratio = Math.min(box.width / frame.width, box.height / frame.height);
  const width = frame.width * ratio, height = frame.height * ratio;
  const x = (clientX - box.left - (box.width - width) / 2) / width;
  const y = (clientY - box.top - (box.height - height) / 2) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: Math.round(x * 1000), y: Math.round(y * 1000) };
}

const specialKeys = { Enter:"Return", Backspace:"BackSpace", Escape:"Escape", Tab:"Tab", Delete:"Delete",
  Home:"Home", End:"End", PageUp:"Prior", PageDown:"Next", Insert:"Insert",
  ArrowUp:"Up", ArrowRight:"Right", ArrowDown:"Down", ArrowLeft:"Left", " ":"space" };

export function keyAction(event) {
  if (event.isComposing || event.repeat || !event.key) return null;
  const { key, ctrlKey, altKey, metaKey, shiftKey } = event;
  if (!ctrlKey && !altKey && !metaKey && [...key].length === 1) return { kind: "type", text: key };
  const code = specialKeys[key] ?? (/^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2]))$/.test(key) ? key : null);
  if (!code) return null;
  const modifiers = [ctrlKey && "ctrl", altKey && "alt", metaKey && "super", shiftKey && "shift"].filter(Boolean);
  return { kind: "key", key: [...modifiers, code].join("+") };
}

export class CommandChannel {
  constructor(write, timeoutMs = 4500) {
    this.write = write;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.next = 0;
  }
  async send(message, timeoutMs = this.timeoutMs) {
    if (this.closed) throw new Error("桌面连接已关闭");
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("未收到操作回执，请查看新画面后再操作"));
      }, timeoutMs);
      this.pending.set(id, { timer, resolve, reject });
      try {
        this.write({ ...message, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  ack({ id, ok, error }) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (ok) request.resolve();
    else request.reject(new Error(typeof error === "string" ? error : "桌面拒绝了此操作"));
  }
  close() {
    this.closed = true;
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("连接断开，操作回执未知，请先查看桌面"));
    }
    this.pending.clear();
  }
}
