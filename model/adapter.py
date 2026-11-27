"""Receive desktop video without coupling frame ingestion to Omni inference."""
import argparse
import asyncio
import base64
from collections import deque
from dataclasses import dataclass, field
import json
import logging
import math
import os
import struct
import time
from urllib.parse import urlsplit

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException


MAX_PACKET = 8 * 1024 * 1024 + 1028
LOG = logging.getLogger("avl.model")
DECISION_PROMPT = """Interpret the supplied desktop image for the operator's immediate instruction.
Return one JSON object with an observation string and action. For observation only return action null.
Supported action objects have kind click or move with integer x,y from 0 to 1000 (upper left origin);
click may have button left, middle, or right. scroll uses x,y and dy from -12 to 12 (positive = down);
key uses a single key or chord in key; type uses a text string. Choose at most one action."""


def now_ms():
    return time.monotonic_ns() / 1_000_000


@dataclass(frozen=True)
class Frame:
    stream: str
    seq: int
    jpeg: bytes


def decode_frame(packet):
    if len(packet) < 4 or len(packet) > MAX_PACKET:
        raise ValueError("invalid frame size")
    length, = struct.unpack_from("!I", packet)
    if not 0 < length <= 1024 or length + 8 > len(packet):
        raise ValueError("invalid frame header length")
    h = json.loads(packet[4:4 + length])
    if not isinstance(h, dict) or not isinstance(h.get("stream"), str) or not h["stream"]:
        raise ValueError("invalid stream identity")
    if any(type(h.get(key)) is not int or h[key] <= 0 for key in ("seq", "width", "height")):
        raise ValueError("invalid frame coordinates")
    if type(h.get("capturedMs")) not in (int, float) or not math.isfinite(h["capturedMs"]):
        raise ValueError("invalid capture timestamp")
    jpeg = packet[4 + length:]
    if len(jpeg) > 8 * 1024 * 1024 or not jpeg.startswith(b"\xff\xd8") or not jpeg.endswith(b"\xff\xd9"):
        raise ValueError("invalid JPEG envelope")
    return Frame(h["stream"], h["seq"], jpeg)


class Omni:
    def __init__(self, client, base_url, model, api_key=None):
        self.client = client
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.model = model
        self.headers = {"Authorization": "Bearer " + api_key} if api_key else {}

    async def decide(self, jpeg, instruction, observe_only):
        url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
        body = {
            "model": self.model, "temperature": 0, "max_tokens": 512,
            "messages": [
                {"role": "system", "content": DECISION_PROMPT},
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": url}},
                    {"type": "text", "text": ("Observation only. " if observe_only else "") + instruction},
                ]},
            ],
        }
        response = await self.client.post(self.url, headers=self.headers, json=body)
        response.raise_for_status()
        text = response.json()["choices"][0]["message"]["content"].strip()
        if text.startswith("```") and text.endswith("```"):
            text = text.partition("\n")[2][:-3].strip()
        decision = json.loads(text)
        observation = decision["observation"]
        if not isinstance(observation, str) or not observation.strip():
            raise ValueError("missing observation")
        action = None if observe_only else decision["action"]
        if action is not None and not isinstance(action, dict):
            raise ValueError("invalid action")
        return observation[:4096], action


@dataclass
class Subscription:
    stream: str
    seq: int = 0
    received: int = 0
    processed: int = 0
    processed_seq: int = 0
    sampled: int = 0
    dropped: int = 0
    next_sample_ms: float = 0
    samples: deque = field(default_factory=lambda: deque(maxlen=128))
    step: dict | None = None


class Receiver:
    def __init__(self, socket, omni, sample_fps, group):
        self.socket = socket
        self.omni = omni
        self.interval_ms = 1000 / sample_fps
        self.group = group
        self.subscription = None
        self.inference = None
        self.send_lock = asyncio.Lock()

    async def send(self, payload):
        async with self.send_lock:
            await self.socket.send(json.dumps(payload, separators=(",", ":"), allow_nan=False))

    def cancel_inference(self):
        if self.inference is not None:
            self.inference.cancel()
            self.inference = None

    def stop(self):
        self.subscription = None
        self.cancel_inference()

    async def control(self, msg):
        kind = msg["type"]
        sub = self.subscription
        if kind == "ping":
            t1 = now_ms()
            await self.send(dict(type="pong", id=msg["id"], t0=msg["t0"], t1=t1, t2=now_ms()))
        elif kind == "start":
            self.stop()
            stream = msg["stream"]
            if not isinstance(stream, str) or not stream:
                raise ValueError("invalid stream")
            self.subscription = Subscription(stream)
        elif kind == "stop" and sub and sub.stream == msg.get("stream"):
            self.stop()
        elif kind == "step" and sub and sub.stream == msg.get("stream"):
            if sub.step:
                raise ValueError("overlapping model steps")
            if self.omni is None:
                await self.send(dict(type="result", stream=sub.stream, id=msg["id"], seq=sub.seq,
                                     error="Benchmark receiver cannot produce decisions"))
                return
            self.cancel_inference()
            sub.next_sample_ms = 0
            sub.step = msg
        elif kind == "cancel" and sub and sub.step and msg.get("id") == sub.step["id"]:
            self.cancel_inference()
            sub.step = None

    def frame(self, packet):
        received = now_ms()
        frame = decode_frame(packet)
        sub = self.subscription
        if not sub or sub.stream != frame.stream:
            return
        if frame.seq <= sub.seq:
            raise ValueError("frame sequence rewound")
        sub.seq = frame.seq
        sub.received += 1
        sub.samples.append(dict(seq=frame.seq, receivedMs=received))
        if self.omni is None:
            return
        if (self.inference and not self.inference.done() or received < sub.next_sample_ms
                or sub.step and frame.seq <= sub.step["afterSeq"]):
            sub.dropped += 1
            return
        sub.sampled += 1
        sub.next_sample_ms = received + self.interval_ms
        self.inference = self.group.create_task(self.infer(sub, frame, received, sub.step))

    async def infer(self, sub, frame, received, step):
        try:
            observation, action = await self.omni.decide(
                frame.jpeg, step["instruction"] if step else "Describe the visible desktop briefly.",
                step is None or step["observeOnly"],
            )
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            LOG.warning("Omni inference failed (%s)", type(exc).__name__)
            result = {"error": "Omni inference failed: " + type(exc).__name__}
        else:
            sub.processed += 1
            sub.processed_seq = frame.seq
            sub.samples.append(dict(seq=frame.seq, receivedMs=received, processedMs=now_ms()))
            result = dict(observation=observation, action=action)
        if step and self.subscription is sub and sub.step is step:
            await self.progress(sub)
            if self.subscription is sub and sub.step is step:
                await self.send(dict(type="result", stream=sub.stream, id=step["id"], seq=frame.seq, **result))
                sub.step = None

    async def progress(self, sub):
        # Serialize snapshot and write together so a delayed timer cannot rewind counters.
        async with self.send_lock:
            if self.subscription is not sub or not sub.received:
                return
            payload = dict(type="progress", stream=sub.stream, seq=sub.seq, received=sub.received,
                           processed=sub.processed, processedSeq=sub.processed_seq, sampled=sub.sampled,
                           dropped=sub.dropped, samples=list(sub.samples))
            sub.samples.clear()
            payload["measuredMs"] = now_ms()
            await self.socket.send(json.dumps(payload, separators=(",", ":")))

    async def report(self):
        while True:
            await asyncio.sleep(.25)
            if self.subscription:
                await self.progress(self.subscription)


async def run_connection(socket, omni, sample_fps=2):
    if not 0 < sample_fps <= 24:
        raise ValueError("sample FPS must be in (0, 24]")
    async with asyncio.TaskGroup() as group:
        receiver = Receiver(socket, omni, sample_fps, group)
        await receiver.send(dict(type="hello", version=2, mode="simulator" if omni else "benchmark"))
        reporter = group.create_task(receiver.report())
        try:
            async for message in socket:
                if isinstance(message, bytes):
                    receiver.frame(message)
                else:
                    await receiver.control(json.loads(message))
        finally:
            reporter.cancel()
            receiver.stop()


async def run(args):
    endpoint = urlsplit(args.url)
    if endpoint.scheme != "wss" and not (endpoint.scheme == "ws" and endpoint.hostname in {"localhost","127.0.0.1","::1"}):
        raise ValueError("use wss:// for remote Host connections")
    if not args.token or not 0 < args.sample_fps <= 24:
        raise ValueError("set AVL_MODEL_TOKEN and sample FPS in (0,24]")
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        omni = None if args.benchmark else Omni(client, args.omni_url, args.model, os.getenv("AVL_OMNI_API_KEY"))
        delay = 1
        while True:
            try:
                async with connect(args.url, additional_headers={"Authorization": "Bearer " + args.token},
                                   compression=None, max_size=MAX_PACKET, max_queue=4, open_timeout=8) as socket:
                    LOG.info("Connected to the desktop Host")
                    delay = 1
                    await run_connection(socket, omni, args.sample_fps)
            except (WebSocketException, OSError, TimeoutError, ExceptionGroup) as exc:
                LOG.warning("Model connection ended (%s)", type(exc).__name__)
            await asyncio.sleep(delay)
            delay = min(15, delay * 2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.getenv("AVL_MODEL_WS","ws://127.0.0.1:3080/avl/model"))
    parser.add_argument("--benchmark", action="store_true", help="measure receipt without running a model")
    parser.add_argument("--sample-fps", type=float, default=float(os.getenv("AVL_SIM_INFERENCE_FPS","2")))
    parser.add_argument("--omni-url", default=os.getenv("AVL_OMNI_BASE_URL","http://127.0.0.1:8000/v1"))
    parser.add_argument("--model", default=os.getenv("AVL_OMNI_MODEL","Qwen/Qwen3-VL-8B-Instruct"))
    args = parser.parse_args()
    args.token = os.getenv("AVL_MODEL_TOKEN")
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
