"""Desktop-side capture, model streaming and input arbitration."""

import asyncio
import json
import os
import secrets
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .capture import capture
from .control import Desktop, Feed, InputRejected, InputUnknown, execute_action
from .recovery import RecoveryState
from .wire import Action, Decision

MIN_MODEL_FPS = 11.8  # Allow scheduling jitter at the nominal 12 fps floor.


@dataclass(frozen=True)
class Settings:
    desktop_token: str
    model_token: str
    fps: int = 24
    width: int = 1280
    height: int = 720
    display: str = ":0.0"
    synthetic: bool = False
    fresh_seconds: float = 5.0
    decision_timeout: float = 20.0
    state_path: str | None = None
    stream_write_timeout_ms: int = 1000

    def __post_init__(self):
        if not 1 <= self.stream_write_timeout_ms <= 2_147_483_647:
            raise ValueError("AVL_STREAM_WRITE_TIMEOUT_MS must be a positive 32-bit integer")
        if not self.desktop_token or not self.model_token or self.desktop_token == self.model_token:
            raise ValueError("AVL_DESKTOP_TOKEN and AVL_MODEL_TOKEN must be distinct nonempty values")
        if not 12 <= self.fps <= 24 or not 0 < self.width <= 4096 or not 0 < self.height <= 2160:
            raise ValueError("invalid capture FPS or resolution")
        if not 0.25 <= self.fresh_seconds <= 30 or not self.fresh_seconds <= self.decision_timeout <= 60:
            raise ValueError("invalid desktop deadlines")

    @classmethod
    def environment(cls):
        return cls(
            desktop_token=os.getenv("AVL_DESKTOP_TOKEN", ""),
            model_token=os.getenv("AVL_MODEL_TOKEN", ""),
            fps=int(os.getenv("AVL_CAPTURE_FPS", "24")),
            width=int(os.getenv("AVL_WIDTH", "1280")),
            height=int(os.getenv("AVL_HEIGHT", "720")),
            display=os.getenv("DISPLAY", ":0.0"),
            synthetic=os.getenv("AVL_SYNTHETIC") == "1",
            fresh_seconds=float(os.getenv("AVL_FRESH_SECONDS", "5")),
            decision_timeout=float(os.getenv("AVL_DECISION_TIMEOUT", "20")),
            state_path=os.getenv("AVL_DESKTOP_STATE"),
            stream_write_timeout_ms=int(os.getenv("AVL_STREAM_WRITE_TIMEOUT_MS", "1000")),
        )


class StepRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instruction: str = Field(min_length=1, max_length=8000)
    observe_only: bool = False
    request_id: str = Field(min_length=1, max_length=64)


class Progress(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: str
    stream: str = Field(min_length=1, max_length=64)
    seq: int = Field(gt=0)
    received: int = Field(gt=0)
    processed: int = Field(ge=0)
    sampled: int | None = Field(default=None, ge=0)
    dropped: int | None = Field(default=None, ge=0)
    started: int | None = Field(default=None, ge=0)
    processed_seq: int | None = Field(default=None, gt=0)


@dataclass
class ModelLink:
    feed: Feed
    mode: str
    progress: Progress | None = None
    updated_at: float = 0.0
    history: deque[tuple[float, Progress]] = field(default_factory=deque)

    def update(self, progress: Progress, desktop: Desktop) -> None:
        current = desktop.latest
        if (current is None or current.stream != progress.stream or progress.seq > current.seq or
                progress.processed > progress.received):
            return
        older = self.progress
        if older and (progress.received <= older.received or progress.processed < older.processed):
            return
        if older and older.stream == progress.stream and progress.seq <= older.seq:
            return
        if self.mode == "full" and (
            progress.processed_seq is None or progress.processed_seq > progress.seq or
            (older and older.stream == progress.stream and progress.processed_seq < older.processed_seq)
        ):
            return
        self.progress = progress
        self.updated_at = time.monotonic()
        self.history.append((self.updated_at, progress))
        self.prune(self.updated_at)

    def prune(self, now: float) -> None:
        while self.history and now - self.history[0][0] > 3:
            self.history.popleft()

    def rates(self, now: float) -> tuple[float, float]:
        self.prune(now)
        if len(self.history) < 2 or now - self.updated_at > 1.5:
            return 0.0, 0.0
        start, first = self.history[0]
        end, last = self.history[-1]
        return round((last.received - first.received) / (end - start), 1), round(
            (last.processed - first.processed) / (end - start), 1,
        )


@dataclass
class Job:
    id: str
    model: ModelLink
    stream: str
    after_seq: int
    epoch: int
    reply: asyncio.Future


class Runtime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.recovery = RecoveryState(settings.state_path)
        paused, self.needs_observation = self.recovery.restore()
        self.desktop = Desktop(settings.fresh_seconds, paused=paused, persist_pause=self.recovery.pause)
        self.desktop.invalidate_step = self.invalidate
        self.model: ModelLink | None = None
        self.job: Job | None = None

    def invalidate(self) -> None:
        job = self.job
        if job is not None and not job.reply.done():
            job.reply.cancel()

    def status(self, viewer: Feed | None = None) -> dict:
        now = time.monotonic()
        model = self.model
        progress = model.progress if model else None
        rx, processed = model.rates(now) if model else (0.0, 0.0)
        latest = self.desktop.latest
        model_frame = (progress.processed_seq if model and model.mode == "full" else progress.seq) if progress else None
        captured_at = self.desktop.frames.get(model_frame)
        ready = bool(model and latest and progress and progress.stream == latest.stream and
                     captured_at is not None and now - captured_at <= 1.5 and
                     not model.feed.failed.is_set() and now - model.updated_at <= 1.5)
        return {
            "type": "status",
            "capture_fps": self.desktop.capture_fps(now),
            "stream": latest.stream if latest else None,
            "control": self.desktop.mode,
            "epoch": self.desktop.epoch,
            "human_owner": viewer is not None and self.desktop.owner is viewer,
            "model": None if model is None else {
                "mode": model.mode, "rx_fps": rx, "processed_fps": processed,
                "received": progress.received if progress else 0,
                "sampled": progress.sampled if progress else None,
                "dropped": progress.dropped if progress else None,
                "processed": progress.processed if progress else 0,
                "started": progress.started if progress else None,
                "ready": ready,
                "meets_minimum": min(rx, processed) >= MIN_MODEL_FPS,
            },
            "needs_observation": self.needs_observation,
        }

    def require_model(self) -> ModelLink:
        model = self.model
        status = self.status()["model"]
        if model is None or status is None or not status["ready"]:
            raise InputRejected("模型视频流未就绪")
        if model.mode == "full" and not status["meets_minimum"]:
            raise InputRejected("模型处理帧率低于 12 fps，Agent 输入已暂停")
        return model

    async def step(self, body: StepRequest, request: Request) -> dict:
        desktop = self.desktop
        if desktop.step_lock.locked():
            raise InputRejected("已有桌面操作在进行")
        async with desktop.step_lock:
            frame = desktop.require_agent()
            model = self.require_model()
            if self.needs_observation and not body.observe_only:
                raise InputRejected("上次动作结果未知，请先发起只观察操作")
            if not self.recovery.reserve(body.request_id, observe_only=body.observe_only):
                raise InputRejected("这个操作已经提交，请重新观察")
            job = Job(uuid4().hex, model, frame.stream, frame.seq, desktop.epoch,
                      asyncio.get_running_loop().create_future())
            self.job = job
            offer(model.feed, {"type": "start", "id": job.id, "instruction": body.instruction,
                               "stream": job.stream, "after_seq": job.after_seq, "observe_only": body.observe_only})
            try:
                async with asyncio.timeout(self.settings.decision_timeout):
                    while not job.reply.done():
                        if await request.is_disconnected():
                            raise InputRejected("请求方已断开")
                        await asyncio.wait({job.reply}, timeout=0.15)
                if job.reply.cancelled():
                    raise InputRejected("桌面控制或视频会话已变化")
                payload = job.reply.result()
                if "error" in payload:
                    raise InputRejected(str(payload["error"])[:300])
                try:
                    decision = Decision.model_validate(payload["decision"])
                except (KeyError, ValidationError) as error:
                    raise InputRejected("视觉模型返回了无效动作") from error
                action = None if body.observe_only else decision.action
                async with desktop.input_lock:
                    desktop.require_agent()
                    if await request.is_disconnected() or self.require_model() is not model or desktop.epoch != job.epoch:
                        raise InputRejected("桌面控制或视频会话已变化")
                    live = desktop.require_frame(job.stream, payload["seq"])
                    if action:
                        try:
                            await execute_action(action, live, self.settings.synthetic, self.settings.display)
                        except (InputUnknown, asyncio.CancelledError):
                            self.needs_observation = True
                            raise
                        if await request.is_disconnected():
                            self.needs_observation = True
                            raise InputUnknown("动作已提交，但连接已断开")
                    if body.observe_only:
                        self.recovery.observed()
                        self.needs_observation = False
                return {
                    "observation": decision.observation,
                    "action": action.model_dump(exclude_none=True) if action else None,
                    "stream": job.stream, "seq": payload["seq"], "model_mode": model.mode,
                    "action_status": ("simulated" if self.settings.synthetic else "applied") if action else "none",
                }
            except TimeoutError as error:
                raise InputRejected("等待视觉模型超时") from error
            finally:
                self.job = None
                job.reply.cancel()
                offer(model.feed, {"type": "cancel", "id": job.id})

    def result(self, model: ModelLink, message: dict) -> None:
        job = self.job
        if job is None or job.model is not model or job.id != message.get("id") or job.reply.done():
            return
        seq = message.get("seq")
        if message.get("stream") != job.stream or type(seq) is not int or seq <= job.after_seq:
            job.reply.cancel()
            return
        if model.mode == "full" and (model.progress is None or model.progress.stream != job.stream or
                                     model.progress.processed_seq < seq):
            job.reply.cancel()
            return
        job.reply.set_result(message)


def offer(feed: Feed, message: dict) -> None:
    feed.offer(json.dumps(message, ensure_ascii=False, separators=(",", ":")))


def authorized(header: str | None, token: str) -> bool:
    return secrets.compare_digest((header or "").encode(), f"Bearer {token}".encode())


async def inbound(socket: WebSocket) -> dict:
    data = await asyncio.wait_for(socket.receive_text(), timeout=5)
    if len(data) > 65_536:
        raise ValueError("control message too large")
    result = json.loads(data)
    if not isinstance(result, dict):
        raise ValueError("expected a control object")
    return result


async def send_feed(socket: WebSocket, feed: Feed, timeout_ms: int) -> None:
    while True:
        message = await feed.get()
        if isinstance(message, bytes):
            await asyncio.wait_for(socket.send_bytes(message), timeout=timeout_ms / 1000)
        else:
            await asyncio.wait_for(socket.send_text(message), timeout=timeout_ms / 1000)


async def manage_link(*operations) -> None:
    tasks = [asyncio.create_task(operation) for operation in operations]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def close_socket(socket: WebSocket, code: int) -> None:
    try:
        await socket.close(code=code)
    except (RuntimeError, WebSocketDisconnect, OSError):
        pass  # The peer may already have closed the transport.


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.environment()
    runtime = Runtime(settings)
    desktop = runtime.desktop

    @asynccontextmanager
    async def lifespan(_app):
        source = asyncio.create_task(capture(
            settings.fps, settings.width, settings.height, settings.display, settings.synthetic,
            desktop.publish, desktop.capture_lost,
        ))
        try:
            yield
        finally:
            source.cancel()
            await asyncio.gather(source, return_exceptions=True)
            runtime.recovery.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/v1/health")
    async def health():
        try:
            desktop.require_live()
        except InputRejected:
            return Response(status_code=503)
        return Response(status_code=204)

    @app.get("/v1/status")
    async def status(request: Request):
        if not authorized(request.headers.get("authorization"), settings.desktop_token):
            raise HTTPException(401)
        return runtime.status()

    @app.post("/v1/step")
    async def step(body: StepRequest, request: Request):
        if not authorized(request.headers.get("authorization"), settings.desktop_token):
            raise HTTPException(401)
        try:
            return await runtime.step(body, request)
        except InputRejected as error:
            raise HTTPException(409, {"state": "rejected", "message": str(error)}) from error
        except InputUnknown as error:
            raise HTTPException(502, {"state": "unknown", "message": str(error)}) from error

    @app.websocket("/v1/model")
    async def model_socket(socket: WebSocket):
        if not authorized(socket.headers.get("authorization"), settings.model_token):
            await close_socket(socket, 1008)
            return
        await socket.accept()
        try:
            hello = await inbound(socket)
            if hello.get("type") != "hello" or hello.get("v") != 1 or hello.get("mode") not in {"simulator", "full"}:
                raise ValueError("unsupported model handshake")
        except (TimeoutError, ValueError, WebSocketDisconnect):
            await close_socket(socket, 1002)
            return
        if runtime.model is not None:
            await close_socket(socket, 1013)
            return
        model = ModelLink(desktop.subscribe(), hello["mode"])
        runtime.model = model

        async def receive_model():
            while True:
                data = await inbound(socket)
                if data.get("type") == "progress":
                    model.update(Progress.model_validate(data), desktop)
                elif data.get("type") == "result":
                    runtime.result(model, data)
                else:
                    raise ValueError("unknown model message")

        try:
            await manage_link(send_feed(socket, model.feed, settings.stream_write_timeout_ms), receive_model(), model.feed.failed.wait())
        finally:
            runtime.model = None
            runtime.invalidate()
            desktop.unsubscribe(model.feed)
            await close_socket(socket, 1012)

    @app.websocket("/v1/view")
    async def view(socket: WebSocket):
        if not authorized(socket.headers.get("authorization"), settings.desktop_token):
            await close_socket(socket, 1008)
            return
        await socket.accept()
        feed = desktop.subscribe()

        async def emit_status():
            while True:
                offer(feed, runtime.status(feed))
                await asyncio.sleep(0.5)

        async def receive_viewer():
            last_action = 0
            while True:
                data = await inbound(socket)
                kind = data.get("type")
                if kind == "ping":
                    continue
                reply = {"type": "ack", "id": str(data.get("id", ""))[:64]}
                try:
                    if kind == "take":
                        await desktop.take_control(feed)
                    elif kind == "resume":
                        await desktop.resume_agent(feed)
                    elif kind == "act":
                        async with desktop.input_lock:
                            if desktop.owner is not feed or feed.failed.is_set():
                                raise InputRejected("请先接管桌面")
                            ordinal = data.get("ordinal")
                            if type(ordinal) is not int or ordinal <= last_action or data.get("epoch") != desktop.epoch:
                                raise InputRejected("输入已处理或控制权已变化")
                            desktop.require_live()
                            frame = desktop.require_frame(data["stream"], data["seq"])
                            last_action = ordinal
                            await execute_action(Action.model_validate(data["action"]), frame, settings.synthetic, settings.display)
                    else:
                        raise ValueError("unsupported request")
                    offer(feed, {**reply, "status": "ok"})
                except (InputRejected, InputUnknown, ValueError, KeyError, TypeError) as error:
                    offer(feed, {**reply, "status": "unknown" if isinstance(error, InputUnknown) else "rejected",
                                 "message": str(error)[:250]})
                offer(feed, runtime.status(feed))

        try:
            await manage_link(send_feed(socket, feed, settings.stream_write_timeout_ms), receive_viewer(), emit_status(), feed.failed.wait())
        finally:
            await desktop.viewer_left(feed)
            desktop.unsubscribe(feed)
            await close_socket(socket, 1012)

    return app
