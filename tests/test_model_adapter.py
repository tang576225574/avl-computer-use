import asyncio
from collections import Counter
from contextlib import asynccontextmanager
import json
import os
import signal
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from model.adapter import InferencePool, Receiver, decode_frame, run, token_digests, vision_server


def jpeg(seq, stream="first"):
    header = json.dumps(dict(seq=seq, stream=stream, capturedMs=seq * 100, width=10, height=10)).encode()
    return struct.pack("!I", len(header)) + header + b"\xff\xd8frame\xff\xd9"


class FrameTests(unittest.TestCase):
    def test_reject_truncated_or_invalid_frame(self):
        for packet in [b"x", struct.pack("!I", 1000) + b'{}', jpeg(0), jpeg(1)[:-2]]:
            with self.subTest(packet=packet), self.assertRaises(ValueError):
                decode_frame(packet)

    def test_require_nonempty_distinct_tokens(self):
        for value in [None, "[]", "{ }", '[""]', '["a b"]', '[1]', '["duplicate", "duplicate"]']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                token_digests(value)
        digests = token_digests('["alpha","beta"]')
        self.assertEqual(len(digests), 2)
        self.assertTrue(all(isinstance(d, bytes) and len(d) == 32 for d in digests))


class ControlledEngine:
    def __init__(self):
        self.calls = asyncio.Queue()
        self.cancelled = Counter()

    async def decide(self, image, instruction, observe_only):
        result = asyncio.get_running_loop().create_future()
        self.calls.put_nowait((instruction, result))
        try:
            return await result
        except asyncio.CancelledError:
            self.cancelled[instruction] += 1
            raise


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def start(self, engine=None, concurrency=1):
        server = await self.enterAsyncContext(vision_server(
            engine, token_digests('["alpha","beta"]'), port=0, max_concurrency=concurrency))
        self.url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/avl/model"
        self.mode = "simulator" if engine is not None else "benchmark"

    async def client(self, token):
        host = await self.enterAsyncContext(connect(self.url, additional_headers={"Authorization":"Bearer "+token}))
        self.assertEqual(await self.next(host, "hello"), {"type":"hello","version":2,"mode":self.mode})
        return host

    async def send(self, host, **data):
        await host.send(json.dumps(data))

    async def next(self, host, kind):
        async with asyncio.timeout(2):
            while True:
                msg = json.loads(await host.recv())
                if msg["type"] == kind:
                    return msg

    async def step(self, host, instruction, seq=1):
        await self.send(host, type="step", stream="first", id="same", afterSeq=seq-1, instruction=instruction, observeOnly=True)
        await host.send(jpeg(seq))

    async def test_handshake_and_reconnect(self):
        await self.start()
        host = await self.client("alpha")
        for url, headers, status in [
            (self.url, {}, 401),
            (self.url, {"Authorization":"Bearer wrong"}, 401),
            (self.url, {"Authorization":"Bearer alpha"}, 409),
            (self.url+"/wrong", {"Authorization":"Bearer beta"}, 404),
        ]:
            with self.subTest(status=status), self.assertRaises(InvalidStatus) as e:
                await connect(url, additional_headers=headers)
            self.assertEqual(e.exception.response.status_code,status)
        await host.close()
        await self.client("alpha")

    async def test_sigterm_closes_sockets_and_aborts_requests_before_engine_shutdown(self):
        engine = ControlledEngine()
        aborted_at_shutdown = []

        async def close_engine():
            aborted_at_shutdown.append(engine.cancelled["running"])

        engine.close = close_engine
        listening = asyncio.get_running_loop().create_future()

        @asynccontextmanager
        async def listener(*args, **kwargs):
            async with vision_server(*args, **kwargs) as server:
                listening.set_result(server.sockets[0].getsockname()[1])
                yield server

        def prior_handler(signum, frame):
            pass

        previous = signal.signal(signal.SIGTERM, prior_handler)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        args = SimpleNamespace(tls_cert=None, tls_key=None, sample_fps=24, host="127.0.0.1",
                               max_concurrency=1, port=0, benchmark=False, model="fixture")
        with patch.dict(os.environ, AVL_MODEL_TOKENS='["alpha"]'), \
                patch("model.adapter.EmbeddedOmni.create", AsyncMock(return_value=engine)), \
                patch("model.adapter.vision_server", listener):
            task = asyncio.create_task(run(args))
            try:
                self.url = f"ws://127.0.0.1:{await asyncio.wait_for(listening, 2)}/avl/model"
                self.mode = "simulator"
                a = await self.client("alpha")
                await self.send(a, type="start", stream="first")
                await self.step(a, "running")
                await asyncio.wait_for(engine.calls.get(), 1)
                os.kill(os.getpid(), signal.SIGTERM)
                await asyncio.wait_for(asyncio.shield(task), 2)
                self.assertEqual(a.close_code, 1001)
                self.assertEqual(aborted_at_shutdown, [1])
                self.assertIs(signal.getsignal(signal.SIGTERM), prior_handler)
            finally:
                if not task.done():
                    await a.close()
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

    async def test_two_desktops_share_engine_without_crossing_or_starving(self):
        engine = ControlledEngine()
        await self.start(engine)
        a, b = await self.client("alpha"), await self.client("beta")
        for host in (a,b):
            await self.send(host,type="start",stream="first")
        await self.step(a,"from A")
        instruction, a_result = await asyncio.wait_for(engine.calls.get(),1)
        self.assertEqual(instruction,"from A")
        await self.step(b,"from B")
        for seq in range(2,15):
            await a.send(jpeg(seq))
            await b.send(jpeg(seq))
        progress = await self.next(b,"progress")
        self.assertEqual((progress["received"],progress["processed"]), (14,0))
        a_result.set_result(("A image",None))
        result = await self.next(a,"result")
        self.assertEqual((result["id"],result["seq"],result["observation"]), ("same",1,"A image"))
        instruction, b_result = await asyncio.wait_for(engine.calls.get(),1)
        self.assertEqual(instruction,"from B")
        b_result.set_result(("B image",{"kind":"click","x":1,"y":2}))
        progress = await self.next(b,"progress")
        samples = list(progress["samples"])
        while not progress["processed"]:
            progress = await self.next(b,"progress")
            samples.extend(progress["samples"])
        sample = next(s for s in samples if s.get("submittedMs") is not None)
        self.assertGreaterEqual(sample["submittedMs"],sample["receivedMs"])
        result = await self.next(b,"result")
        self.assertEqual((result["seq"],result["action"],result["observation"]), (14,None,"B image"))

    async def test_expired_queued_frame_leaves_step_waiting_for_new_input(self):
        engine = ControlledEngine()
        await self.start(engine)
        a, b = await self.client("alpha"), await self.client("beta")
        await self.send(a, type="start", stream="first")
        await self.send(b, type="start", stream="first", freshMs=100)
        await self.step(a, "running")
        _, first = await asyncio.wait_for(engine.calls.get(), 1)
        await self.step(b, "waiting")
        await self.next(b, "progress")
        await asyncio.sleep(.11)
        first.set_result(("complete", None))
        await self.next(a, "result")
        progress = await self.next(b, "progress")
        self.assertEqual((progress["received"], progress["sampled"], progress["dropped"]), (1, 0, 1))
        await b.send(jpeg(2))
        instruction, second = await asyncio.wait_for(engine.calls.get(), 1)
        self.assertEqual(instruction, "waiting")
        second.set_result(("fresh", None))
        self.assertEqual((await self.next(b, "result"))["seq"], 2)

    async def test_blocked_result_delivery_releases_shared_engine_slot(self):
        engine = ControlledEngine()
        pool = InferencePool(engine, 1)
        blocked = asyncio.Event()

        class BlockedSocket:
            async def send(self, message):
                blocked.set()
                await asyncio.Future()

        async with asyncio.TaskGroup() as group:
            a = Receiver(BlockedSocket(), pool, 24, group)
            b = Receiver(BlockedSocket(), pool, 24, group)
            try:
                for receiver, name in ((a, "A"), (b, "B")):
                    await receiver.control(dict(type="start", stream="first"))
                    await receiver.control(dict(type="step", stream="first", id="s", afterSeq=0,
                                                instruction=name, observeOnly=True))
                    receiver.frame(jpeg(1))
                name, result = await asyncio.wait_for(engine.calls.get(), 1)
                self.assertEqual(name, "A")
                result.set_result(("A image", None))
                await asyncio.wait_for(blocked.wait(), 1)
                name, _ = await asyncio.wait_for(engine.calls.get(), 1)
                self.assertEqual(name, "B")
            finally:
                a.stop()
                b.stop()

    async def test_pong_transmit_timestamp_excludes_send_lock_delay(self):
        sent = []

        class Socket:
            async def send(self, message):
                sent.append(json.loads(message))

        async with asyncio.TaskGroup() as group:
            receiver = Receiver(Socket(), InferencePool(None, 1), 24, group)
            with patch("model.adapter.now_ms", return_value=100) as clock:
                async with receiver.send_lock:
                    pong = group.create_task(receiver.control(dict(type="ping", id="p", t0=80)))
                    await asyncio.sleep(0)
                    clock.return_value = 130
                await pong
        self.assertEqual((sent[0]["t1"], sent[0]["t2"]), (100, 130))

    async def test_bad_request_result_is_local_and_next_request_succeeds(self):
        engine = ControlledEngine()
        await self.start(engine)
        a = await self.client("alpha")
        await self.send(a, type="start", stream="first")
        await self.step(a, "malformed response")
        _, result = await asyncio.wait_for(engine.calls.get(), 1)
        result.set_exception(ValueError("test validation error"))
        self.assertIn("error", await self.next(a, "result"))
        await self.step(a, "valid response", 2)
        _, result = await asyncio.wait_for(engine.calls.get(), 1)
        result.set_result(("ok", None))
        self.assertEqual((await self.next(a, "result"))["observation"], "ok")

    async def test_fatal_engine_error_closes_all_hosts_and_cancels_work(self):
        from model.engine import VisionEngineDead
        engine = ControlledEngine()
        with self.assertRaises(VisionEngineDead):
            async with vision_server(engine, token_digests('["alpha","beta","gamma"]'),
                                     port=0, max_concurrency=2) as server:
                self.url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/avl/model"
                self.mode = "simulator"
                a, b, c = await self.client("alpha"), await self.client("beta"), await self.client("gamma")
                for host, instruction in ((a, "die"), (b, "running"), (c, "waiting")):
                    await self.send(host, type="start", stream="first")
                    await self.step(host, instruction)
                    await self.send(host, type="ping", id="ready", t0=0)
                    await self.next(host, "pong")
                calls = dict([await asyncio.wait_for(engine.calls.get(), 1) for _ in range(2)])
                calls["die"].set_exception(VisionEngineDead("engine stopped"))
                await asyncio.wait_for(server.wait_closed(), 2)
                self.assertTrue(all(host.close_code == 1001 for host in (a, b, c)))
                self.assertEqual(engine.cancelled["running"], 1)
                self.assertTrue(engine.calls.empty())

    async def test_stop_and_disconnect_cancel_only_owner(self):
        engine = ControlledEngine()
        await self.start(engine,2)
        a, b = await self.client("alpha"), await self.client("beta")
        for host in (a,b):
            await self.send(host,type="start",stream="first")
        await self.step(a,"from A")
        await self.step(b,"from B")
        calls = dict([await asyncio.wait_for(engine.calls.get(),1) for _ in range(2)])
        await a.close()
        await self.send(b,type="ping",id="ping",t0=1)
        await self.next(b,"pong")
        calls["from B"].set_result(("B survived",None))
        self.assertEqual((await self.next(b,"result"))["observation"],"B survived")
        self.assertEqual(engine.cancelled["from A"],1)
        a = await self.client("alpha")
        await self.send(a,type="start",stream="first")
        await self.step(a,"cancelled")
        await asyncio.wait_for(engine.calls.get(),1)
        await self.send(a,type="cancel",stream="first",id="same")
        await self.send(a,type="stop",stream="first")
        await self.send(a,type="ping",id="stopped",t0=1)
        self.assertEqual((await self.next(a,"pong"))["id"],"stopped")
        self.assertEqual(engine.cancelled["cancelled"],1)

    async def test_engine_result_after_stop_cannot_satisfy_new_subscription(self):
        class LateEngine(ControlledEngine):
            async def decide(self, image, instruction, observe_only):
                try:
                    return await super().decide(image, instruction, observe_only)
                except asyncio.CancelledError:
                    # Backend work may already have finished as the old step is cancelled.
                    return ("old response", None)

        engine = LateEngine()
        await self.start(engine)
        a = await self.client("alpha")
        await self.send(a, type="start", stream="first")
        await self.step(a, "old")
        await asyncio.wait_for(engine.calls.get(), 1)
        await self.send(a, type="stop", stream="first")
        await self.send(a, type="start", stream="first")
        await self.step(a, "new")
        instruction, new_result = await asyncio.wait_for(engine.calls.get(), 1)
        self.assertEqual(instruction, "new")
        new_result.set_result(("new response", None))
        self.assertEqual((await self.next(a, "result"))["observation"], "new response")

    async def test_benchmark_idle_ping_and_actual_receipt(self):
        await self.start()
        a = await self.client("alpha")
        await self.send(a,type="ping",id="p",t0=201)
        pong = await self.next(a,"pong")
        self.assertEqual((pong["id"],pong["t0"]), ("p",201))
        self.assertGreaterEqual(pong["t2"],pong["t1"])
        await self.send(a,type="start",stream="first")
        for seq in (1,5,7):
            await a.send(jpeg(seq))
        progress = await self.next(a,"progress")
        self.assertEqual((progress["received"],progress["processed"],progress["seq"]), (3,0,7))
        self.assertEqual([s["seq"] for s in progress["samples"]], [1,5,7])
        await self.send(a,type="stop",stream="first")
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(0.35):
                await a.recv()
