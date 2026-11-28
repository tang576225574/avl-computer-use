"""Loopback-only benchmark fixture. Substitute inference while running the real cloud protocol."""
import asyncio
import os
import signal
import sys

from model.adapter import token_digests, vision_server


class SlowEngine:
    async def decide(self, jpeg, instruction, observe_only):
        assert jpeg[:2] == b"\xff\xd8" and jpeg[-2:] == b"\xff\xd9"
        await asyncio.sleep(0.1)
        return instruction, None


async def main():
    stopped = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stopped.set)
    engine = SlowEngine() if sys.argv[1] == "slow" else None
    async with vision_server(engine, token_digests(os.environ["AVL_MODEL_TOKENS"]),
                             port=int(sys.argv[2]) if len(sys.argv) > 2 else 0, max_concurrency=1) as server:
        print(server.sockets[0].getsockname()[1], flush=True)
        await stopped.wait()


if __name__ == "__main__":
    asyncio.run(main())
