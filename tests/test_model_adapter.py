import asyncio
import json
import struct
import unittest

import httpx
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from model.adapter import Qwen, decode_frame, run_connection


def jpeg(seq, stream="first"):
    header = json.dumps(dict(seq=seq, stream=stream, capturedMs=seq*100, width=10, height=10)).encode()
    return struct.pack("!I", len(header)) + header + b"\xff\xd8frame\xff\xd9"


class FrameTests(unittest.TestCase):
    def test_reject_truncated_or_invalid_frame(self):
        for packet in [b"x", struct.pack("!I", 1000) + b'{}', jpeg(0), jpeg(1)[:-2]]:
            with self.subTest(packet=packet), self.assertRaises(ValueError):
                decode_frame(packet)


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.connected = asyncio.get_running_loop().create_future()
        self.done = asyncio.Event()
        async def handle(ws):
            self.connected.set_result(ws)
            await self.done.wait()
        self.server = await serve(handle, "127.0.0.1", 0)
        self.socket = await connect(f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}/avl/model", compression=None)
        self.host = await self.connected
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.requests = []
        async def completions(request):
            self.requests.append(json.loads(request.content))
            self.started.set()
            await self.release.wait()
            content = json.dumps({"observation":"Save is visible","action":{"kind":"click","x":250,"y":500}})
            return httpx.Response(200, json={"choices":[{"message":{"content":content}}]})
        self.client = httpx.AsyncClient(transport=httpx.MockTransport(completions))

    async def asyncTearDown(self):
        self.done.set()
        await self.socket.close()
        if hasattr(self, "run_task"):
            await asyncio.wait_for(self.run_task, 2)
        self.server.close()
        await self.server.wait_closed()
        await self.client.aclose()

    async def begin(self, mode):
        engine = Qwen(self.client, "https://test/v1", "Qwen3-VL") if mode == "simulator" else None
        self.run_task = asyncio.create_task(run_connection(self.socket, engine, sample_fps=2))
        self.assertEqual(await self.next("hello"), {"type":"hello","version":2,"mode":mode})

    async def send(self, **data):
        await self.host.send(json.dumps(data))

    async def next(self, kind):
        async with asyncio.timeout(2):
            while True:
                msg = json.loads(await self.host.recv())
                if msg["type"] == kind:
                    return msg

    async def test_receive_continues_during_step_and_stale_result_is_cancelled(self):
        await self.begin("simulator")
        await self.send(type="start",stream="first")
        await self.send(type="step",stream="first",id="one",afterSeq=1,instruction="Save",observeOnly=False)
        await self.host.send(jpeg(2))
        await asyncio.wait_for(self.started.wait(),1)
        for seq in range(3,15):
            await self.host.send(jpeg(seq))
        progress = await self.next("progress")
        self.assertEqual((progress["received"],progress["seq"],progress["processed"]), (13,14,0))
        self.assertTrue(len(progress["samples"])>0)
        await self.send(type="stop",stream="first")
        await self.send(type="ping",id="stopped",t0=100)
        self.assertEqual((await self.next("pong"))["id"], "stopped")
        self.release.set()
        await self.send(type="start",stream="new")
        await self.send(type="step",stream="new",id="two",afterSeq=0,instruction="Read the title",observeOnly=True)
        await self.host.send(jpeg(1, "new"))
        progress = await self.next("progress")
        self.assertEqual((progress["stream"],progress["processedSeq"]), ("new",1))
        msg = await self.next("result")
        self.assertEqual((msg["id"],msg["seq"],msg["action"]), ("two",1,None))
        self.assertIn("Read the title",str(self.requests[-1]["messages"]))

    async def test_benchmark_idle_ping_and_actual_receipt(self):
        await self.begin("benchmark")
        await self.send(type="ping",id="p",t0=201)
        pong = await self.next("pong")
        self.assertEqual((pong["id"],pong["t0"]), ("p",201))
        self.assertGreaterEqual(pong["t2"],pong["t1"])
        await self.send(type="start",stream="first")
        for seq in (1,5,7):
            await self.host.send(jpeg(seq))
        progress = await self.next("progress")
        self.assertEqual((progress["received"],progress["processed"],progress["seq"]), (3,0,7))
        self.assertEqual([s["seq"] for s in progress["samples"]], [1,5,7])
        self.assertGreaterEqual(progress["measuredMs"], max(s["receivedMs"] for s in progress["samples"]))
        await self.send(type="stop",stream="first")
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(0.35):
                await self.host.recv()
