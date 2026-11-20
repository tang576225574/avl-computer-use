import asyncio
import json
import unittest
from unittest.mock import patch

from avl_computer_use.backend.wire import Frame, decode_frame
from avl_computer_use.backend.simulator import Sampler, QwenVision
from avl_computer_use.backend.control import Desktop, InputRejected


class StreamTests(unittest.IsolatedAsyncioTestCase):
    def test_frame_round_trip_and_sequence_metadata(self):
        frame = Frame("generation", 4, 123, 640, 360, b"\xff\xd8test\xff\xd9")
        self.assertEqual(decode_frame(frame.encode()), frame)
        with self.assertRaises(ValueError):
            decode_frame(frame.encode()[:5])

    def test_simulator_receives_every_frame_but_samples_twice_per_second(self):
        sampler = Sampler(2)
        selected = []
        for seq in range(1, 49):
            frame = Frame("generation", seq, seq * 1_000_000_000 // 24, 640, 360, b"jpeg")
            if sampler.receive(frame):
                selected.append(seq)
        self.assertEqual(selected, [1, 13, 25, 37])
        self.assertEqual(sampler.received, 48)
        self.assertEqual(sampler.sampled, 4)
        self.assertEqual(sampler.dropped, 44)

    async def test_qwen_adapter_sends_jpeg_and_desktop_instruction(self):
        import httpx
        captured = {}

        def respond(request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={"choices": [{"message": {"content":
                '{"observation":"ready","action":{"kind":"click","x":500,"y":250}}'}}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            model = QwenVision(client, "http://model/v1", "Qwen3-VL-8B-Instruct", "")
            decision = await model.infer("Click the button", Frame("g", 1, 100, 640, 360, b"jpeg"))
        self.assertEqual(decision.action.x, 500)
        content = captured["messages"][1]["content"]
        self.assertIn("Click the button", content[0]["text"])
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))

    async def test_control_blocks_on_manual_disconnect_until_explicit_resume(self):
        desktop = Desktop(stale_after=1)
        desktop.publish(Frame("generation", 1, 123, 640, 360, b"jpeg"))
        visitor = object()
        await desktop.take_control(visitor)
        await desktop.viewer_left(visitor)
        self.assertEqual(desktop.mode, "paused")
        with self.assertRaises(InputRejected):
            desktop.require_agent()
        await desktop.resume_agent()
        self.assertEqual(desktop.mode, "agent")

    async def test_stale_and_foreign_frame_ids_are_rejected(self):
        desktop = Desktop(stale_after=1)
        with patch("avl_computer_use.backend.control.time.monotonic", return_value=100):
            desktop.publish(Frame("generation", 4, 123, 640, 360, b"jpeg"))
            with self.assertRaises(InputRejected):
                desktop.require_frame("other", 4)
            with self.assertRaises(InputRejected):
                desktop.require_frame("generation", 3)
        with patch("avl_computer_use.backend.control.time.monotonic", return_value=102):
            with self.assertRaises(InputRejected):
                desktop.require_frame("generation", 4)
