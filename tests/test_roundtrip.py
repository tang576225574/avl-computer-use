import asyncio
import json
import shutil
import socket
import unittest
from contextlib import asynccontextmanager
from uuid import uuid4

import httpx
import uvicorn
from fastapi import FastAPI, Request
from websockets.asyncio.client import connect

from avl_computer_use.backend.server import Settings, create_app
from avl_computer_use.backend.simulator import QwenVision, model_session
from avl_computer_use.backend.wire import decode_frame

DESKTOP = {"Authorization": "Bearer desktop-test"}
MODEL = {"Authorization": "Bearer model-test"}


@asynccontextmanager
async def serve(app):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    endpoint = f"127.0.0.1:{listener.getsockname()[1]}"
    server = uvicorn.Server(uvicorn.Config(app, lifespan="on", log_level="error",
                                           timeout_graceful_shutdown=2, ws="websockets"))
    running = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                await asyncio.sleep(0.01)
        yield endpoint
    finally:
        server.should_exit = True
        await asyncio.wait_for(running, timeout=5)
        listener.close()


async def event(viewer, predicate):
    async with asyncio.timeout(6):
        while True:
            data = await viewer.recv()
            if isinstance(data, str):
                message = json.loads(data)
                if predicate(message):
                    return message


@unittest.skipUnless(shutil.which("ffmpeg"), "requires FFmpeg")
class RoundTripTest(unittest.IsolatedAsyncioTestCase):
    async def test_model_sampling_input_takeover_and_reconnect(self):
        app = FastAPI()
        calls = asyncio.Queue()
        release = asyncio.Event()
        release.set()

        @app.post("/v1/chat/completions")
        async def infer(request: Request):
            await calls.put(await request.json())
            await release.wait()
            return {"choices": [{"message": {"content": json.dumps({
                "observation": "Button found", "action": {"kind": "click", "x": 500, "y": 500},
            })}}]}

        settings = Settings("desktop-test", "model-test", width=320, height=180, synthetic=True)
        async with serve(app) as model, serve(create_app(settings)) as desktop, httpx.AsyncClient(timeout=6) as http:
            async def status_ready(predicate):
                async with asyncio.timeout(5):
                    while True:
                        value = (await http.get(f"http://{desktop}/v1/status", headers=DESKTOP)).json()
                        if predicate(value):
                            return value
                        await asyncio.sleep(0.04)

            async def step(request_id=None, observe_only=False):
                return await http.post(f"http://{desktop}/v1/step", headers=DESKTOP, json={
                    "instruction": "Click", "request_id": request_id or uuid4().hex, "observe_only": observe_only,
                })

            qwen = QwenVision(http, f"http://{model}/v1", "Qwen3-VL-test", "")
            for attempt in range(2):
                async with connect(f"ws://{desktop}/v1/model", additional_headers=MODEL) as model_ws:
                    worker = asyncio.create_task(model_session(model_ws, qwen, 2, idle_inference=attempt == 1))
                    await status_ready(lambda value: value["model"] and value["model"]["received"] > 12)
                    if attempt == 1:
                        await status_ready(lambda value: value["model"]["processed"] > 0)
                        self.assertEqual((await step(observe_only=True)).json()["action_status"], "none")
                        worker.cancel()
                        await asyncio.gather(worker, return_exceptions=True)
                        continue

                    async with connect(f"ws://{desktop}/v1/view", additional_headers=DESKTOP) as viewer:
                        packet = await viewer.recv()
                        while isinstance(packet, str):
                            packet = await viewer.recv()
                        first = decode_frame(packet)
                        self.assertEqual(first.width, 320)
                        result = await step("exactly-once")
                        self.assertEqual(result.json()["action_status"], "simulated")
                        self.assertEqual((await step("exactly-once")).status_code, 409)
                        payload = await asyncio.wait_for(calls.get(), 3)
                        self.assertEqual(payload["model"], "Qwen3-VL-test")
                        release.clear()
                        pending = asyncio.create_task(step())
                        await asyncio.wait_for(calls.get(), 3)
                        before = await status_ready(lambda value: value["model"]["rx_fps"] > 12)
                        after = await status_ready(lambda value: value["model"]["received"] >= before["model"]["received"] + 12)
                        self.assertEqual(after["model"]["started"], 2)
                        self.assertGreater(after["model"]["dropped"], after["model"]["sampled"])
                        await viewer.send(json.dumps({"type": "take", "id": "take"}))
                        self.assertEqual((await event(viewer, lambda item: item.get("id") == "take"))["status"], "ok")
                        self.assertEqual((await pending).status_code, 409)
                        owned = await event(viewer, lambda item: item.get("human_owner"))
                        click = {"type": "act", "id": "input", "stream": first.stream, "seq": first.seq,
                                 "epoch": owned["epoch"], "ordinal": 1,
                                 "action": {"kind": "click", "x": 500, "y": 500}}
                        await viewer.send(json.dumps(click))
                        self.assertEqual((await event(viewer, lambda item: item.get("id") == "input"))["status"], "ok")
                        await viewer.send(json.dumps(click))
                        self.assertEqual((await event(viewer, lambda item: item.get("id") == "input"))["status"], "rejected")
                    await status_ready(lambda value: value["control"] == "paused")
                    self.assertEqual((await step()).status_code, 409)
                    async with connect(f"ws://{desktop}/v1/view", additional_headers=DESKTOP) as viewer:
                        await viewer.send(json.dumps({"type": "resume", "id": "resume"}))
                        self.assertEqual((await event(viewer, lambda item: item.get("id") == "resume"))["status"], "ok")
                    pending = asyncio.create_task(step())
                    await asyncio.wait_for(calls.get(), 3)
                    await model_ws.close()
                    await asyncio.gather(worker, return_exceptions=True)
                    self.assertEqual((await pending).status_code, 409)
                    await status_ready(lambda value: value["model"] is None)
                    release.set()

    async def test_full_model_contract_waits_for_encoded_receipts(self):
        settings = Settings("desktop-test", "model-test", fps=12, width=320, height=180, synthetic=True)
        async with serve(create_app(settings)) as desktop, httpx.AsyncClient(timeout=6) as http:
            async with connect(f"ws://{desktop}/v1/model", additional_headers=MODEL) as model:
                await model.send(json.dumps({"type": "hello", "v": 1, "mode": "full"}))

                async def consume():
                    received = 0
                    requested = None
                    async for message in model:
                        if isinstance(message, str):
                            cmd = json.loads(message)
                            requested = cmd if cmd["type"] == "start" else None
                            continue
                        frame = decode_frame(message)
                        received += 1
                        if received % 6 == 0 or requested is not None:
                            await model.send(json.dumps({
                                "type": "progress", "stream": frame.stream, "seq": frame.seq, "received": received,
                                "processed": received, "processed_seq": frame.seq,
                            }))
                        if requested is not None:
                            self.assertEqual(requested["stream"], frame.stream)
                            self.assertGreater(frame.seq, requested["after_seq"])
                            await model.send(json.dumps({
                                "type": "result", "stream": frame.stream, "seq": frame.seq, "id": requested["id"],
                                "decision": {"observation": "full model fixture", "action": None},
                            }))
                            requested = None

                consumer = asyncio.create_task(consume())
                try:
                    async with asyncio.timeout(4):
                        while True:
                            status = (await http.get(f"http://{desktop}/v1/status", headers=DESKTOP)).json()
                            if status["model"] and status["model"]["meets_minimum"]:
                                break
                            await asyncio.sleep(0.05)
                    result = await http.post(f"http://{desktop}/v1/step", headers=DESKTOP, json={
                        "instruction": "Observe", "observe_only": True, "request_id": "full-observe",
                    })
                    self.assertEqual(result.status_code, 200, result.text)
                    self.assertEqual(result.json()["model_mode"], "full")
                    self.assertEqual(result.json()["observation"], "full model fixture")
                finally:
                    consumer.cancel()
                    await asyncio.gather(consumer, return_exceptions=True)
