import asyncio
import json
import os
import unittest
from unittest.mock import patch

from avl_computer_use.backend.wire import Frame, decode_frame
from avl_computer_use.backend.simulator import Sampler, QwenVision
from avl_computer_use.backend.control import Desktop, InputRejected


class StreamTests(unittest.IsolatedAsyncioTestCase):
    def test_stream_write_timeout_setting(self):
        from avl_computer_use.backend.server import Settings
        with patch.dict(os.environ, {"AVL_DESKTOP_TOKEN": "desk", "AVL_MODEL_TOKEN": "model",
                                     "AVL_STREAM_WRITE_TIMEOUT_MS": "2500"}):
            self.assertEqual(Settings.environment().stream_write_timeout_ms, 2500)
            os.environ["AVL_STREAM_WRITE_TIMEOUT_MS"] = "0"
            with self.assertRaisesRegex(ValueError, "AVL_STREAM_WRITE_TIMEOUT_MS"):
                Settings.environment()

    async def test_desktop_write_timeout_cancels_a_stalled_sender(self):
        from avl_computer_use.backend.server import send_feed
        from unittest.mock import AsyncMock

        async def stalled(_message):
            await asyncio.Event().wait()

        feed = Desktop(stale_after=5).subscribe()
        socket = AsyncMock()
        for message, method in [(b"frame", socket.send_bytes), ("status", socket.send_text)]:
            method.side_effect = stalled
            feed.offer(message)
            sender = asyncio.create_task(send_feed(socket, feed, timeout_ms=20))
            try:
                done, _ = await asyncio.wait({sender}, timeout=0.5)
                self.assertIn(sender, done)
                with self.assertRaises(TimeoutError):
                    await sender
                method.assert_awaited_once_with(message)
            finally:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)

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

    async def test_slow_subscriber_gets_the_latest_frame_without_blocking_the_other_feed(self):
        desktop = Desktop(stale_after=5)
        slow = desktop.subscribe()
        fast = desktop.subscribe()

        for seq in range(1, 51):
            desktop.publish(Frame("generation", seq, seq, 640, 360, b"jpeg"))
            self.assertEqual(decode_frame(await asyncio.wait_for(fast.get(), 0.1)).seq, seq)

        self.assertFalse(slow.failed.is_set())
        self.assertEqual(decode_frame(await asyncio.wait_for(slow.get(), 0.1)).seq, 50)

    async def test_control_messages_survive_frame_replacement_in_order(self):
        feed = Desktop(stale_after=5).subscribe()
        feed.offer(b"old frame")
        feed.offer("start")
        feed.offer(b"new frame")
        feed.offer("cancel")
        self.assertEqual([await asyncio.wait_for(feed.get(), 0.1) for _ in range(3)],
                         ["start", "cancel", b"new frame"])

    async def test_capture_loss_discards_the_pending_frame(self):
        desktop = Desktop(stale_after=5)
        feed = desktop.subscribe()
        desktop.publish(Frame("old", 1, 1, 640, 360, b"jpeg"))
        desktop.capture_lost()
        feed.offer("cancel")
        self.assertEqual(await asyncio.wait_for(feed.get(), 0.1), "cancel")
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(feed.get(), 0.01)

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
