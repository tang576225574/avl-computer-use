"""Version 1 of the live desktop/model wire format."""

import json
import struct
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_JPEG = 8 * 1024 * 1024
MAX_HEADER = 1024


@dataclass(frozen=True, slots=True)
class Frame:
    stream: str
    seq: int
    captured_ns: int
    width: int
    height: int
    jpeg: bytes

    def encode(self) -> bytes:
        header = json.dumps({
            "v": 1, "stream": self.stream, "seq": self.seq,
            "captured_ns": self.captured_ns, "width": self.width, "height": self.height,
        }, separators=(",", ":")).encode()
        return struct.pack("!I", len(header)) + header + self.jpeg


def decode_frame(packet: bytes) -> Frame:
    if len(packet) <= 4:
        raise ValueError("incomplete frame")
    (length,) = struct.unpack_from("!I", packet)
    if not 0 < length <= MAX_HEADER or not 4 + length < len(packet) <= 4 + length + MAX_JPEG:
        raise ValueError("invalid frame length")
    header = json.loads(packet[4:4 + length])
    if not isinstance(header, dict) or header.get("v") != 1:
        raise ValueError("unsupported frame version")
    stream = header.get("stream")
    seq, timestamp, width, height = (header.get(name) for name in ("seq", "captured_ns", "width", "height"))
    if not isinstance(stream, str) or not stream or any(
        type(value) is not int or value < 1 for value in (seq, timestamp, width, height)
    ):
        raise ValueError("invalid frame metadata")
    return Frame(stream, seq, timestamp, width, height, packet[4 + length:])


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: str
    x: int | None = Field(default=None, ge=0, le=1000)
    y: int | None = Field(default=None, ge=0, le=1000)
    button: int | None = Field(default=None, ge=1, le=3)
    key: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+){0,3}$", max_length=80)
    text: str | None = Field(default=None, min_length=1, max_length=2048)
    delta: int | None = Field(default=None, ge=-12, le=12)

    @model_validator(mode="after")
    def validate_parameters(self):
        fields = self.model_fields_set - {"kind"}
        if self.kind == "click" and self.x is not None and self.y is not None and fields <= {"x", "y", "button"}:
            return self
        if self.kind == "key" and fields == {"key"} and self.key:
            return self
        if self.kind == "type" and fields == {"text"} and self.text and "\0" not in self.text:
            return self
        if self.kind == "scroll" and fields == {"delta"} and self.delta:
            return self
        raise ValueError("unsupported input or invalid parameters")


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    observation: str = Field(min_length=1, max_length=4000)
    action: Action | None
