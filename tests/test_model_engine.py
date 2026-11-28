import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from model.engine import EmbeddedOmni, VisionEngineDead


class DeadCore(RuntimeError):
    pass


class EngineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.renderer = AsyncMock(return_value=([], ["rendered input"]))
        self.engine = SimpleNamespace(
            renderer=SimpleNamespace(render_chat_async=self.renderer),
            abort=AsyncMock(), shutdown=Mock(),
        )
        self.model = EmbeddedOmni(self.engine, "template parameters", "sampling parameters", DeadCore)
        self.picture = object()
        decode = patch("model.engine._decode_jpeg", return_value=self.picture)
        self.decode = decode.start()
        self.addCleanup(decode.stop)

    async def test_in_memory_image_chat_and_observation_only(self):
        async def generate(prompt, params, request_id):
            self.assertEqual((prompt, params), ("rendered input", "sampling parameters"))
            self.assertTrue(request_id)
            text = '```json\n{"observation":"menu","action":{"kind":"click"}}\n```'
            yield SimpleNamespace(outputs=[SimpleNamespace(text=text)])
        self.engine.generate = generate
        self.assertEqual(await self.model.decide(b"jpeg", "look", True), ("menu", None))
        self.decode.assert_called_once_with(b"jpeg")
        conversation = self.renderer.await_args.args[0][0]
        image_part, text_part = conversation[1]["content"]
        self.assertIs(image_part["image_pil"], self.picture)
        self.assertEqual(text_part["text"], "Observation only. look")
        await self.model.close()
        self.engine.shutdown.assert_called_once_with()

    async def test_cancel_only_aborts_the_matching_gpu_request(self):
        in_flight = asyncio.Queue()
        resume = asyncio.Event()

        async def generate(prompt, params, request_id):
            await in_flight.put(request_id)
            await resume.wait()
            text = '{"observation":"icon","action":{"kind":"click","x":1,"y":2}}'
            yield SimpleNamespace(outputs=[SimpleNamespace(text=text)])
        self.engine.generate = generate
        a = asyncio.create_task(self.model.decide(b"a", "click", False))
        first = await in_flight.get()
        b = asyncio.create_task(self.model.decide(b"b", "click", False))
        second = await in_flight.get()
        self.assertNotEqual(first, second)
        a.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await a
        self.engine.abort.assert_awaited_once_with(first)
        resume.set()
        self.assertEqual(await b, ("icon", {"kind": "click", "x": 1, "y": 2}))

    async def test_render_or_generation_core_death_is_service_wide(self):
        self.renderer.side_effect = DeadCore()
        with self.assertRaises(VisionEngineDead) as caught:
            await self.model.decide(b"jpeg", "look", True)
        self.assertIsInstance(caught.exception.__cause__, DeadCore)

        self.renderer.side_effect = None
        async def generate(prompt, params, request_id):
            yield None
            raise DeadCore()
        self.engine.generate = generate
        with self.assertRaises(VisionEngineDead):
            await self.model.decide(b"jpeg", "look", True)

    async def test_cancel_reports_engine_death_if_abort_fails(self):
        started = asyncio.Event()
        async def generate(prompt, params, request_id):
            started.set()
            await asyncio.Future()
            yield None
        self.engine.generate = generate
        self.engine.abort.side_effect = DeadCore()
        work = asyncio.create_task(self.model.decide(b"jpeg", "look", True))
        await asyncio.wait_for(started.wait(), 1)
        work.cancel()
        with self.assertRaises(VisionEngineDead):
            await work

    async def test_regular_generation_errors_stay_request_local(self):
        async def generate(prompt, params, request_id):
            yield None
            raise ValueError("invalid request")
        self.engine.generate = generate
        with self.assertRaisesRegex(ValueError, "invalid request"):
            await self.model.decide(b"jpeg", "look", True)
