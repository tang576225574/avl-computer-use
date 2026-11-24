import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const maxJpegBytes = 8 * 1024 * 1024;
const marker = Buffer.from([0xff, 0xd9]);

export function inputArguments(action, size) {
  if (!action || !size) throw Error("没有可用桌面画面");
  const point = () => {
    if (
      ![action.x, action.y].every(
        (v) => Number.isInteger(v) && v >= 0 && v <= 1000,
      )
    )
      throw Error("无效桌面坐标");
    return [
      "mousemove",
      String(Math.round((action.x * (size.width - 1)) / 1000)),
      String(Math.round((action.y * (size.height - 1)) / 1000)),
    ];
  };
  switch (action.kind) {
    case "click": {
      const button = { left: "1", middle: "2", right: "3" }[
        action.button ?? "left"
      ];
      if (typeof button !== "string") throw Error("无效鼠标键");
      return [...point(), "click", button];
    }
    case "move":
      return point();
    case "scroll":
      if (
        !Number.isInteger(action.dy) ||
        !action.dy ||
        Math.abs(action.dy) > 12
      )
        throw Error("无效滚动步数");
      return [
        ...point(),
        "click",
        "--repeat",
        String(Math.abs(action.dy)),
        action.dy > 0 ? "5" : "4",
      ];
    case "key":
      if (
        typeof action.key !== "string" ||
        !/^([a-zA-Z0-9_]{1,25}\+){0,4}[a-zA-Z0-9_]{1,25}$/.test(action.key)
      )
        throw Error("无效按键");
      return ["key", "--clearmodifiers", action.key];
    case "type":
      if (
        typeof action.text !== "string" ||
        action.text.length > 4096 ||
        action.text.includes("\0")
      )
        throw Error("无效输入文本");
      return ["type", "--clearmodifiers", "--delay", "1", "--", action.text];
    default:
      throw Error("未知桌面动作");
  }
}

export async function x11Input(action, size, signal) {
  const pending = exec("xdotool", inputArguments(action, size), {
    timeout: 8000,
    maxBuffer: 4096,
    signal,
    killSignal: "SIGKILL",
  });
  const closed = new Promise((resolve) => pending.child.once("close", resolve));
  // Node can reject on abort as soon as it signals the child, before X11 input has stopped.
  try {
    await pending;
  } finally {
    await closed;
  }
}

export class Capture {
  constructor({ fps, synthetic = false, publish, lost }) {
    Object.assign(this, { fps, synthetic, publish, lost });
    this.desired = false;
  }
  wanted() {
    return this.desired;
  }
  healthy() {
    return (
      !this.desired ||
      (performance.now() - this.lastFrame < 3500 && !this.failed)
    );
  }
  demand(wanted) {
    if (this.desired === wanted) return;
    this.desired = wanted;
    if (wanted) this.restart();
    else this.stop();
  }
  stop() {
    this.generation = Symbol();
    this.child?.kill("SIGKILL");
    this.child = null;
  }
  restart() {
    this.stop();
    if (!this.desired) return;
    this.failed = false;
    this.lastFrame = performance.now();
    const generation = this.generation;
    void this.run(generation).catch(() => {
      if (this.generation !== generation || !this.desired) return;
      this.failed = true;
      this.lost("桌面采集已中断");
    });
  }
  async run(generation) {
    let width = 640,
      height = 360;
    if (!this.synthetic) {
      const { stdout } = await exec("xdotool", ["getdisplaygeometry"], {
        timeout: 2000,
      });
      [width, height] = stdout.trim().split(/\s+/).map(Number);
      if (
        ![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 8192)
      )
        throw Error("无效 X11 尺寸");
    }
    if (generation !== this.generation) return;
    const size = width + "x" + height;
    const source = this.synthetic
      ? ["-re", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${this.fps}`]
      : [
          "-f",
          "x11grab",
          "-framerate",
          String(this.fps),
          "-video_size",
          size,
          "-i",
          process.env.DISPLAY || ":1",
        ];
    const child = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        ...source,
        "-an",
        "-threads",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "5",
        "-f",
        "image2pipe",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.child = child;
    let chunks = [],
      total = 0,
      tail = false;
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
      child.stdout.on("data", (chunk) => {
        if (generation !== this.generation) return;
        while (chunk.length) {
          const boundary = chunk.indexOf(marker);
          let end = boundary < 0 ? 0 : boundary + 2;
          if (tail && chunk[0] === 0xd9) end = 1;
          const part = end ? chunk.subarray(0, end) : chunk;
          total += part.length;
          if (total <= maxJpegBytes) chunks.push(part);
          else chunks = [];
          if (!end) {
            tail = chunk.at(-1) === 0xff;
            return;
          }
          if (total <= maxJpegBytes) {
            this.lastFrame = performance.now();
            this.publish(Buffer.concat(chunks, total), width, height);
          }
          chunks = [];
          total = 0;
          tail = false;
          chunk = chunk.subarray(end);
        }
      });
    });
    if (generation === this.generation) throw Error("FFmpeg exited");
  }
}
