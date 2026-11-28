"""Serve the cloud desktop vision protocol with one shared inference engine."""
import argparse
import asyncio
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import hashlib
import hmac
import ipaddress
import json
import logging
import math
import os
import re
import signal
import ssl as tls
import struct
import time
from weakref import WeakValueDictionary

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from websockets.protocol import State

from .engine import DEFAULT_MODEL, EmbeddedOmni, VisionEngineDead

MAX_PACKET = 8 * 1024 * 1024 + 1028
LOG = logging.getLogger("avl.model")


def now_ms():
    return time.monotonic_ns() / 1_000_000


@dataclass(frozen=True)
class Frame:
    stream: str
    seq: int
    jpeg: memoryview


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
    jpeg = memoryview(packet)[4 + length:]
    if len(jpeg) > 8 * 1024 * 1024 or jpeg[:2] != b"\xff\xd8" or jpeg[-2:] != b"\xff\xd9":
        raise ValueError("invalid JPEG envelope")
    return Frame(h["stream"], h["seq"], jpeg)


def token_digests(raw):
    try:
        tokens = json.loads(raw) if raw else None
    except ValueError:
        tokens = None
    if not isinstance(tokens, list) or not tokens:
        raise ValueError("AVL_MODEL_TOKENS must be a nonempty JSON array")
    digests = set()
    for token in tokens:
        if not isinstance(token, str) or not re.fullmatch(r"[!-~]{1,512}", token):
            raise ValueError("each device token must be 1–512 printable ASCII characters without spaces")
        digests.add(hashlib.sha256(token.encode("ascii")).digest())
    if len(tokens) != len(digests):
        raise ValueError("AVL_MODEL_TOKENS contains duplicate device tokens")
    return frozenset(digests)


@dataclass
class Subscription:
    stream: str
    fresh_ms: int
    seq: int = 0
    received: int = 0
    processed: int = 0
    processed_seq: int = 0
    sampled: int = 0
    dropped: int = 0
    next_sample_ms: float = 0
    samples: deque = field(default_factory=lambda: deque(maxlen=128))
    step: dict | None = None


class InferencePool:
    """A ready desktop gets one turn, then rejoins the tail when eligible again."""
    def __init__(self, engine, concurrency):
        self.engine = engine
        self.capacity = concurrency
        self.active = 0
        self.waiting = OrderedDict()
        self.fatal_error = None
        self.close_server = None

    def engine_died(self, error):
        if self.fatal_error is None:
            self.fatal_error = error
            self.waiting.clear()
            if self.close_server:
                self.close_server()

    def offer(self, receiver):
        if self.fatal_error is not None:
            return
        self.waiting[receiver] = None
        self.dispatch()

    def dispatch(self):
        while self.active < self.capacity and self.waiting:
            receiver, _ = self.waiting.popitem(last=False)
            if receiver.submit():
                self.active += 1

    def finished(self, receiver):
        self.active -= 1
        receiver.inference = None
        # Put this desktop behind all the peers already waiting.
        receiver.schedule()
        self.dispatch()


class Receiver:
    def __init__(self, socket, pool, sample_fps, group):
        self.socket = socket
        self.pool = pool
        self.interval_ms = 1000 / sample_fps
        self.group = group
        self.subscription = None
        self.inference = None
        self.delivery = None
        self.candidate = None
        self.timer = None
        self.send_lock = asyncio.Lock()

    async def send(self, payload):
        async with self.send_lock:
            await self.write(payload)

    async def write(self, payload):
        try:
            async with asyncio.timeout(5):
                await self.socket.send(json.dumps(payload, separators=(",", ":"), allow_nan=False))
        except TimeoutError:
            await self.socket.close(1013, "Response delivery timed out")

    def clear_work(self):
        self.pool.waiting.pop(self, None)
        if self.timer:
            self.timer.cancel()
            self.timer = None
        if self.candidate is not None and self.subscription is not None:
            self.subscription.dropped += 1
        self.candidate = None
        if self.inference and not self.inference.done():
            self.inference.cancel()
        if self.delivery and not self.delivery.done():
            self.delivery.cancel()

    def stop(self):
        self.clear_work()
        self.subscription = None

    async def control(self, msg):
        if not isinstance(msg, dict):
            raise ValueError("invalid control")
        kind = msg["type"]
        sub = self.subscription
        if kind == "ping":
            t1 = now_ms()
            async with self.send_lock:
                await self.write(dict(type="pong", id=msg["id"], t0=msg["t0"], t1=t1, t2=now_ms()))
        elif kind == "start":
            self.stop()
            stream = msg["stream"]
            fresh_ms = msg.get("freshMs", 5000)
            if not isinstance(stream, str) or not 0 < len(stream) <= 128:
                raise ValueError("invalid stream")
            if type(fresh_ms) is not int or not 100 <= fresh_ms <= 60000:
                raise ValueError("invalid frame lifetime")
            self.subscription = Subscription(stream, fresh_ms)
        elif not sub or sub.stream != msg.get("stream"):
            return
        elif kind == "stop":
            self.stop()
        elif kind == "step":
            if sub.step:
                raise ValueError("overlapping model steps")
            if not (isinstance(msg.get("instruction"), str) and 0 < len(msg["instruction"]) <= 8000
                    and type(msg.get("observeOnly")) is bool and type(msg.get("afterSeq")) is int
                    and isinstance(msg.get("id"), str) and 0 < len(msg["id"]) <= 128):
                raise ValueError("invalid step")
            if self.pool.engine is None:
                await self.send(dict(type="result", stream=sub.stream, id=msg["id"], seq=sub.seq,
                                     error="Benchmark receiver cannot produce decisions"))
                return
            self.clear_work()
            sub.next_sample_ms = 0
            sub.step = msg
        elif kind == "cancel" and sub.step and msg.get("id") == sub.step["id"]:
            self.clear_work()
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
        if self.pool.engine is None:
            return
        if sub.step and frame.seq <= sub.step["afterSeq"]:
            sub.dropped += 1
            return
        if self.candidate is not None:
            sub.dropped += 1
        self.candidate = (frame, received)
        self.schedule()

    def schedule(self):
        if self.inference is not None or self.delivery is not None or self.candidate is None or self.timer:
            return
        delay = self.subscription.next_sample_ms - now_ms()
        if delay > 0:
            self.timer = asyncio.get_running_loop().call_later(delay / 1000, self.wake)
        else:
            self.pool.offer(self)

    def wake(self):
        self.timer = None
        self.schedule()

    def submit(self):
        sub = self.subscription
        frame, received = self.candidate
        self.candidate = None
        submitted = now_ms()
        if submitted - received > sub.fresh_ms:
            sub.dropped += 1
            return False
        sub.sampled += 1
        sub.next_sample_ms = submitted + self.interval_ms
        self.inference = self.group.create_task(self.infer(sub, frame, received, sub.step))
        sub.samples.append(dict(seq=frame.seq, receivedMs=received, submittedMs=submitted))
        self.inference.add_done_callback(lambda _: self.pool.finished(self))
        return True

    async def infer(self, sub, frame, received, step):
        try:
            observation, action = await self.pool.engine.decide(
                frame.jpeg, step["instruction"] if step else "Describe the visible desktop briefly.",
                step is None or step["observeOnly"],
            )
        except VisionEngineDead as exc:
            self.pool.engine_died(exc)
            return
        except Exception as exc:
            LOG.warning("Omni inference failed (%s)", type(exc).__name__)
            result = {"error": "Omni inference failed: " + type(exc).__name__}
        else:
            result = dict(observation=observation, action=action if step and not step["observeOnly"] else None)
        if self.subscription is not sub or sub.step is not step:
            return
        if "error" not in result:
            sub.processed += 1
            sub.processed_seq = frame.seq
            sub.samples.append(dict(seq=frame.seq, receivedMs=received, processedMs=now_ms()))
        if step:
            # A blocked socket can delay its own next job, never another tenant's inference slot.
            self.delivery = self.group.create_task(self.deliver(sub, step, frame.seq, result))
            self.delivery.add_done_callback(self.delivered)

    async def deliver(self, sub, step, seq, result):
        await self.progress(sub)
        async with self.send_lock:
            if self.subscription is sub and sub.step is step:
                await self.write(dict(type="result", stream=sub.stream, id=step["id"], seq=seq, **result))
                if self.subscription is sub and sub.step is step:
                    sub.step = None

    def delivered(self, _):
        self.delivery = None
        self.schedule()

    async def progress(self, sub):
        async with self.send_lock:
            if self.subscription is not sub or not sub.received:
                return
            payload = dict(type="progress", stream=sub.stream, seq=sub.seq, received=sub.received,
                           processed=sub.processed, processedSeq=sub.processed_seq, sampled=sub.sampled,
                           dropped=sub.dropped, samples=list(sub.samples), measuredMs=now_ms())
            sub.samples.clear()
            await self.write(payload)

    async def report(self):
        while True:
            await asyncio.sleep(.25)
            if self.subscription:
                await self.progress(self.subscription)


async def run_connection(socket, pool, sample_fps):
    async with asyncio.TaskGroup() as group:
        receiver = Receiver(socket, pool, sample_fps, group)
        await receiver.send(dict(type="hello", version=2, mode="simulator" if pool.engine is not None else "benchmark"))
        reporter = group.create_task(receiver.report())
        try:
            async for message in socket:
                if isinstance(message, bytes):
                    receiver.frame(message)
                else:
                    if len(message) > 65536:
                        raise ValueError("control message too large")
                    await receiver.control(json.loads(message))
        finally:
            reporter.cancel()
            receiver.stop()


def loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@asynccontextmanager
async def vision_server(engine, tokens, *, host="127.0.0.1", port=8765, sample_fps=2, max_concurrency=4, ssl=None):
    if not tokens or not 0 < sample_fps <= 24 or max_concurrency < 1:
        raise ValueError("supply device tokens, sample FPS in (0,24] and positive concurrency")
    if ssl is None and not loopback(host):
        raise ValueError("remote vision listeners require TLS; bind loopback behind a TLS proxy")
    pool = InferencePool(engine, max_concurrency)
    owners = WeakValueDictionary()

    def authenticate(socket, request, response):
        if response.status_code != 101:
            return response
        if request.path != "/avl/model":
            return socket.respond(404, "Unknown endpoint\n")
        headers = request.headers.get_all("Authorization")
        value = headers[0] if len(headers) == 1 else ""
        scheme, _, token = value.partition(" ")
        digest = hashlib.sha256(token.encode("utf-8", "surrogateescape")).digest()
        matches = [allowed for allowed in tokens if hmac.compare_digest(allowed, digest)]
        if scheme.lower() != "bearer" or not matches:
            return socket.respond(401, "Invalid device credential\n")
        # No await between check and reservation: concurrent upgrades cannot displace an owner.
        owner = owners.get(digest)
        if owner is not None and owner.state != State.CLOSED:
            return socket.respond(409, "Desktop already connected\n")
        owners[digest] = socket
        socket.avl_identity = digest
        return response

    async def handle(socket):
        try:
            try:
                await run_connection(socket, pool, sample_fps)
            except* ConnectionClosed:
                pass
            except* (ValueError, TypeError, KeyError, OverflowError, RecursionError):
                await socket.close(1008, "Invalid desktop message")
        finally:
            if owners.get(socket.avl_identity) is socket:
                del owners[socket.avl_identity]

    async with serve(handle, host, port, ssl=ssl, process_response=authenticate, compression=None,
                     max_size=MAX_PACKET, max_queue=4, open_timeout=8, close_timeout=3) as server:
        pool.close_server = server.close
        yield server
    if pool.fatal_error is not None:
        raise pool.fatal_error


async def run(args):
    tokens = token_digests(os.environ.pop("AVL_MODEL_TOKENS", None))
    context = None
    if bool(args.tls_cert) != bool(args.tls_key):
        raise ValueError("supply both --tls-cert and --tls-key")
    if args.tls_cert:
        context = tls.SSLContext(tls.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(args.tls_cert, args.tls_key)
    if not (0 < args.sample_fps <= 24 and args.max_concurrency >= 1 and 0 <= args.port <= 65535):
        raise ValueError("invalid sample FPS, concurrency or listener port")
    if context is None and not loopback(args.host):
        raise ValueError("supply TLS for a non-loopback listener")
    engine = None
    if not args.benchmark:
        engine = await EmbeddedOmni.create(args.model)
    # Install the CLI handler after vLLM launches its worker processes.
    loop = asyncio.get_running_loop()
    prior_handler = None
    try:
        async with vision_server(engine, tokens, host=args.host, port=args.port, sample_fps=args.sample_fps,
                                 max_concurrency=args.max_concurrency, ssl=context) as server:
            prior_handler = signal.signal(signal.SIGTERM, lambda *_: loop.call_soon_threadsafe(server.close))
            LOG.info("Vision service listening on %s:%d", args.host, server.sockets[0].getsockname()[1])
            await server.wait_closed()
    finally:
        try:
            if engine is not None:
                await engine.close()
        finally:
            if prior_handler is not None:
                signal.signal(signal.SIGTERM, prior_handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--tls-cert")
    parser.add_argument("--tls-key")
    parser.add_argument("--benchmark", action="store_true", help="measure receipt without loading model weights")
    parser.add_argument("--sample-fps", type=float, default=os.getenv("AVL_SIM_INFERENCE_FPS", "2"))
    parser.add_argument("--max-concurrency", type=int, default=4, help="shared limit on concurrent inference requests")
    parser.add_argument("--model", default=os.getenv("AVL_OMNI_MODEL", DEFAULT_MODEL))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    try:
        asyncio.run(run(args))
    except VisionEngineDead:
        parser.exit(1, "The shared vision engine stopped. Restart the vision service.\n")
    except ValueError as exc:
        parser.error(str(exc))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
