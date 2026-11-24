export function encodeFrame(header, jpeg) {
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length);
  return Buffer.concat([prefix, json, jpeg]);
}

// One write in flight, one replaceable picture. Commands remain ordered.
export class FrameSender {
  constructor(socket, timeout, onFrame = () => {}) {
    this.socket = socket;
    this.timeout = timeout;
    this.onFrame = onFrame;
    this.controls = [];
  }
  frame(packet) {
    this.pending = packet;
    this.flush();
  }
  send(message) {
    if (this.controls.length >= 32) return this.socket.terminate();
    this.controls.push(JSON.stringify(message));
    this.flush();
  }
  discard() {
    this.pending = undefined;
  }
  flush() {
    if (this.closed || this.timer || this.socket.readyState !== 1) return;
    const data = this.controls.shift() ?? this.pending;
    if (data === undefined) return;
    const binary = Buffer.isBuffer(data);
    if (binary) this.discard();
    this.timer = setTimeout(
      () => this.socket.terminate(),
      this.timeout,
    ).unref();
    this.socket.send(data, { binary }, (error) => {
      clearTimeout(this.timer);
      this.timer = undefined;
      if (error) return this.socket.terminate();
      if (binary) this.onFrame(data);
      this.flush();
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controls = [];
    this.discard();
  }
}
