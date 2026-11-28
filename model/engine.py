"""Run desktop decisions through one local vLLM V1 engine on the vision server."""
import asyncio
from contextlib import aclosing
from io import BytesIO
import json
from uuid import uuid4


DEFAULT_MODEL = "Qwen/Qwen3-VL-8B-Instruct"
DECISION_PROMPT = """Interpret the supplied desktop image for the operator's immediate instruction.
Return one JSON object with an observation string and action. For observation only return action null.
Supported action objects have kind click or move with integer x,y from 0 to 1000 (upper left origin);
click may have button left, middle, or right. scroll uses x,y and dy from -12 to 12 (positive = down);
key uses a single key or chord in key; type uses a text string. Choose at most one action."""


def _decode_jpeg(jpeg):
    from PIL import Image

    with Image.open(BytesIO(jpeg), formats=("JPEG",)) as image:
        # The Host caps X11 dimensions; enforce that limit on the actual image before decoding.
        if max(image.size) > 8192:
            raise ValueError("unsupported desktop dimensions")
        if image.mode != "RGB":
            return image.convert("RGB")
        image.load()
        return image


def _decision(text, observe_only):
    text = text.strip()
    if text.startswith("```") and text.endswith("```"):
        text = text.partition("\n")[2][:-3].strip()
    value = json.loads(text)
    if not isinstance(value, dict) or not isinstance(value.get("observation"), str) or not value["observation"].strip():
        raise ValueError("missing observation")
    action = None if observe_only else value["action"]
    if action is not None and not isinstance(action, dict):
        raise ValueError("invalid action")
    return value["observation"][:4096], action


class VisionEngineDead(RuntimeError):
    """The shared inference engine can no longer accept requests."""


class EmbeddedOmni:
    def __init__(self, engine, chat_params, sampling_params, dead_error_type):
        self.engine = engine
        self.chat_params = chat_params
        self.sampling_params = sampling_params
        self.dead_error_type = dead_error_type

    @classmethod
    async def create(cls, model):
        try:
            from vllm.engine.arg_utils import AsyncEngineArgs
            from vllm.renderers.params import ChatParams
            from vllm.sampling_params import RequestOutputKind, SamplingParams
            from vllm.v1.engine.async_llm import AsyncLLM
            from vllm.v1.engine.exceptions import EngineDeadError
        except ImportError as error:
            raise RuntimeError("Vision inference requires the GPU extra: pip install '.[gpu]'") from error

        chat_params = ChatParams(chat_template_kwargs={"add_generation_prompt": True})
        sampling_params = SamplingParams(temperature=0, max_tokens=512, output_kind=RequestOutputKind.FINAL_ONLY)
        engine = AsyncLLM.from_engine_args(AsyncEngineArgs(model=model))
        return cls(engine, chat_params, sampling_params, EngineDeadError)

    async def decide(self, jpeg, instruction, observe_only):
        image = await asyncio.to_thread(_decode_jpeg, jpeg)
        messages = [
            {"role": "system", "content": DECISION_PROMPT},
            {"role": "user", "content": [
                {"type": "image_pil", "image_pil": image},
                {"type": "text", "text": ("Observation only. " if observe_only else "") + instruction},
            ]},
        ]
        try:
            text = await self._generate(messages)
        except self.dead_error_type as error:
            raise VisionEngineDead("The shared vision engine has stopped") from error
        return _decision(text, observe_only)

    async def _generate(self, messages):
        _, prompts = await self.engine.renderer.render_chat_async([messages], self.chat_params)
        request_id = uuid4().hex
        result = None
        try:
            async with aclosing(self.engine.generate(prompts[0], self.sampling_params, request_id)) as outputs:
                async for result in outputs:
                    pass
        except asyncio.CancelledError:
            # Also covers cancellation during admission, before generate has acquired its output collector.
            await self.engine.abort(request_id)
            raise
        if result is None or not result.outputs:
            raise ValueError("vision engine produced no decision")
        return result.outputs[0].text

    async def close(self):
        self.engine.shutdown()
