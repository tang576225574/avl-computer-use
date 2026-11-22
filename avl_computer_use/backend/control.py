"""Live feeds and single-owner keyboard/mouse control."""

import asyncio
import os
import time
from collections import deque
from dataclasses import dataclass, field

from .wire import Action, Frame


class InputRejected(Exception):
    pass


class InputUnknown(Exception):
    pass


@dataclass(eq=False)
class Feed:
    controls: deque[str] = field(default_factory=deque)
    pending_frame: bytes | None = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    failed: asyncio.Event = field(default_factory=asyncio.Event)

    def offer(self, item: bytes | str) -> None:
        if self.failed.is_set():
            return
        if isinstance(item, bytes):
            self.pending_frame = item
        elif len(self.controls) >= 24:
            self.failed.set()
            return
        else:
            self.controls.append(item)
        self.ready.set()

    async def get(self) -> bytes | str:
        while not self.controls and self.pending_frame is None:
            self.ready.clear()
            await self.ready.wait()
        if self.controls:
            return self.controls.popleft()
        frame = self.pending_frame
        assert frame is not None
        self.pending_frame = None
        return frame


class Desktop:
    def __init__(self, stale_after: float, *, paused=False, persist_pause=lambda _paused: None):
        self.stale_after = stale_after
        self.mode = "paused" if paused else "agent"
        self.persist_pause = persist_pause
        self.owner = None
        self.epoch = 0
        self.latest: Frame | None = None
        self.frames: dict[int, float] = {}
        self.recent: deque[float] = deque()
        self.feeds: set[Feed] = set()
        self.input_lock = asyncio.Lock()
        self.step_lock = asyncio.Lock()
        self.invalidate_step = lambda: None

    def subscribe(self) -> Feed:
        feed = Feed()
        self.feeds.add(feed)
        return feed

    def unsubscribe(self, feed: Feed) -> None:
        self.feeds.discard(feed)
        feed.failed.set()

    def publish(self, frame: Frame) -> None:
        if self.latest is not None and self.latest.stream != frame.stream:
            self.capture_lost()
        self.latest = frame
        now = time.monotonic()
        self.frames[frame.seq] = now
        while self.frames and now - next(iter(self.frames.values())) > self.stale_after:
            self.frames.pop(next(iter(self.frames)))
        self.recent.append(now)
        self.capture_fps(now)
        if self.feeds:
            packet = frame.encode()
            for feed in self.feeds:
                feed.offer(packet)

    def capture_lost(self) -> None:
        if self.latest is not None:
            self.epoch += 1
            self.invalidate_step()
        self.latest = None
        self.frames.clear()
        self.recent.clear()
        for feed in self.feeds:
            feed.pending_frame = None
        if self.mode == "human":
            self.mode = "paused"
            self.owner = None

    def capture_fps(self, now: float) -> float:
        while self.recent and now - self.recent[0] > 2:
            self.recent.popleft()
        if len(self.recent) < 2:
            return 0
        return round((len(self.recent) - 1) / (now - self.recent[0]), 1) if now > self.recent[0] else 0

    def require_frame(self, stream: str, seq: int) -> Frame:
        frame = self.latest
        if type(seq) is not int:
            raise InputRejected("帧序号无效")
        captured_at = self.frames.get(seq)
        if frame is None or frame.stream != stream or captured_at is None:
            raise InputRejected("画面已变化，请等待新帧")
        if time.monotonic() - captured_at > self.stale_after:
            raise InputRejected("画面过期，请重新观察")
        return frame

    def require_agent(self) -> Frame:
        if self.mode != "agent":
            raise InputRejected("Agent 输入已暂停")
        return self.require_live()

    def require_live(self) -> Frame:
        if self.latest is None:
            raise InputRejected("桌面画面未连接")
        if time.monotonic() - self.frames[self.latest.seq] > min(1.5, self.stale_after):
            raise InputRejected("桌面画面已停止更新")
        return self.require_frame(self.latest.stream, self.latest.seq)

    async def take_control(self, viewer: object) -> None:
        async with self.input_lock:
            self.require_live()
            if self.owner is not None and self.owner is not viewer:
                raise InputRejected("另一窗口正在操作")
            self.persist_pause(True)
            self.owner = viewer
            self.mode = "human"
            self.epoch += 1
            self.invalidate_step()

    async def viewer_left(self, viewer: object) -> None:
        if self.owner is viewer:
            self.owner = None
            self.mode = "paused"
            self.epoch += 1
            self.invalidate_step()
            async with self.input_lock:
                pass

    async def resume_agent(self, viewer: object | None = None) -> None:
        async with self.input_lock:
            self.require_live()
            if self.owner is not None and self.owner is not viewer:
                raise InputRejected("另一窗口正在操作")
            self.persist_pause(False)
            self.owner = None
            self.mode = "agent"
            self.epoch += 1
            self.invalidate_step()


async def execute_action(action: Action, frame: Frame, synthetic: bool, display: str) -> None:
    if synthetic:
        return
    if action.kind == "click":
        x = round(action.x * (frame.width - 1) / 1000)
        y = round(action.y * (frame.height - 1) / 1000)
        args = ["mousemove", str(x), str(y), "click", str(action.button or 1)]
    elif action.kind == "scroll":
        args = ["click", "--repeat", str(abs(action.delta)), "4" if action.delta < 0 else "5"]
    elif action.kind == "key":
        args = ["key", "--clearmodifiers", action.key]
    else:
        args = ["type", "--clearmodifiers", "--delay", "0", "--", action.text]
    try:
        process = await asyncio.create_subprocess_exec(
            "xdotool", *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, "DISPLAY": display},
        )
    except OSError as error:
        raise InputRejected("无法启动桌面输入程序") from error
    try:
        if await asyncio.wait_for(process.wait(), timeout=5):
            raise InputUnknown("输入程序失败，部分输入可能已执行")
    except (TimeoutError, asyncio.CancelledError) as error:
        if process.returncode is None:
            process.kill()
            await process.wait()
        if isinstance(error, asyncio.CancelledError):
            raise
        raise InputUnknown("输入超时，结果未知") from error
