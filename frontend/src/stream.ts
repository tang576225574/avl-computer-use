export interface Frame {
  stream: string;
  seq: number;
  width: number;
  height: number;
  image: Blob;
}

export interface Status {
  type: "status";
  stream: string | null;
  capture_fps: number;
  control: "agent" | "human" | "paused";
  epoch: number;
  human_owner: boolean;
  model: {
    mode: "simulator" | "full";
    rx_fps: number;
    processed_fps: number;
    dropped: number | null;
    ready: boolean;
    meets_minimum: boolean;
  } | null;
}

export type Action =
  | { kind: "click"; x: number; y: number; button: number }
  | { kind: "key"; key: string }
  | { kind: "type"; text: string }
  | { kind: "scroll"; delta: number };

export type Control =
  | { type: "take" | "resume" }
  | { type: "act"; action: Action; seq: number; stream: string; epoch: number; ordinal: number };

export interface Ack {
  type: "ack";
  id: string;
  status: "ok" | "rejected" | "unknown";
  message?: string;
}

const decoder = new TextDecoder();

export function parseFrame(packet: ArrayBuffer): Frame {
  if (packet.byteLength < 6) throw new Error("invalid frame");
  const length = new DataView(packet).getUint32(0);
  if (length < 1 || length > 1024 || length + 4 >= packet.byteLength) throw new Error("invalid header");
  const header = JSON.parse(decoder.decode(new Uint8Array(packet, 4, length)));
  if (header.v !== 1 || typeof header.stream !== "string" ||
      ![header.seq, header.width, header.height].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("invalid frame metadata");
  }
  return { ...header, image: new Blob([packet.slice(length + 4)], { type: "image/jpeg" }) };
}
