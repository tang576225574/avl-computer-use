"""One X11 (or synthetic) FFmpeg capture shared by all receivers."""

import asyncio
import logging
import time
from collections.abc import Callable
from uuid import uuid4

from .wire import MAX_JPEG, Frame

log = logging.getLogger(__name__)


async def read_jpeg(pipe: asyncio.StreamReader) -> bytes:
    if await pipe.readline() != b"--ffmpeg\r\n":
        raise EOFError("capture stream ended or lost framing")
    headers = {}
    while (line := await pipe.readline()) != b"\r\n":
        if not line or b":" not in line:
            raise ValueError("invalid FFmpeg frame headers")
        name, value = line.split(b":", 1)
        headers[name.lower()] = value.strip()
    size = int(headers.get(b"content-length", b"0"))
    if not 0 < size <= MAX_JPEG:
        raise ValueError("invalid FFmpeg image size")
    jpeg = await pipe.readexactly(size)
    if await pipe.readexactly(2) != b"\r\n" or not jpeg.startswith(b"\xff\xd8"):
        raise ValueError("invalid JPEG frame")
    return jpeg


async def capture(
    fps: int, width: int, height: int, display: str, synthetic: bool,
    publish: Callable[[Frame], None], lost: Callable[[], None],
) -> None:
    size = f"{width}x{height}"
    source = ["-re", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={fps}"] if synthetic else [
        "-f", "x11grab", "-framerate", str(fps), "-video_size", size, "-i", display,
    ]
    while True:
        generation = uuid4().hex
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                *source, "-an", "-c:v", "mjpeg", "-q:v", "7", "-threads", "1",
                "-flush_packets", "1", "-f", "mpjpeg", "pipe:1",
                stdout=asyncio.subprocess.PIPE,
            )
            assert process.stdout is not None
            sequence = 0
            while True:
                jpeg = await asyncio.wait_for(read_jpeg(process.stdout), timeout=4)
                sequence += 1
                publish(Frame(generation, sequence, time.monotonic_ns(), width, height, jpeg))
        except (OSError, EOFError, ValueError, asyncio.IncompleteReadError, TimeoutError) as error:
            log.warning("Desktop capture unavailable: %s", error)
        finally:
            lost()
            if process is not None and process.returncode is None:
                process.kill()
                await process.communicate()
        await asyncio.sleep(1)
