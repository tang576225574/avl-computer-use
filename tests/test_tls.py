"""Start the production Host and verify its outbound cloud TLS connection and retries."""
import asyncio
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import ssl
import subprocess
import tempfile
import time
import unittest

import httpx
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

ROOT = Path(__file__).resolve().parents[1]


class LocalLauncherTests(unittest.TestCase):
    def test_rejects_malformed_device_tokens_before_startup(self):
        with tempfile.TemporaryDirectory() as home:
            for token in ["", "abc ", "abc\r", "密钥", "x" * 513]:
                result = subprocess.run([str(ROOT / "tools/dsh.sh"), "--help"], capture_output=True,
                                        env={"PATH": os.environ["PATH"], "HOME": home, "AVL_MODEL_TOKEN": token},
                                        timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"AVL_MODEL_TOKEN", result.stderr)


@unittest.skipUnless(shutil.which("openssl"), "test certificate generation requires openssl")
class DirectTlsTests(unittest.IsolatedAsyncioTestCase):
    async def test_host_dials_cloud_and_recovers_from_auth_and_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = Path(tmp) / "cert.pem", Path(tmp) / "key.pem"
            await asyncio.to_thread(subprocess.run, ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                            "-days", "1", "-subj", "/CN=localhost", "-addext",
                            "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", str(key),
                            "-out", str(cert)], check=True, capture_output=True)
            token = secrets.token_urlsafe(24)
            attempts = []
            refusal = 401
            complete = asyncio.get_running_loop().create_future()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)

            def admit(connection, request):
                attempts.append((request.path, hmac.compare_digest(request.headers.get("Authorization", ""),
                                                                   "Bearer " + token)))
                if refusal:
                    return connection.respond(refusal, "refused")

            async def cloud(socket):
                try:
                    await socket.send(json.dumps({"type": "hello", "version": 2, "mode": "full"}))
                    for _ in range(2):
                        message = await asyncio.wait_for(socket.recv(), 4)
                        self.assertIsInstance(message, str, "Idle Host sent a video frame")
                        ping = json.loads(message)
                        self.assertEqual(ping["type"], "ping")
                        now = time.monotonic() * 1000
                        await socket.send(json.dumps(dict(ping, type="pong", t1=now, t2=now)))
                except Exception as exc:
                    complete.set_exception(exc)
                else:
                    complete.set_result(None)
                await socket.wait_closed()

            async with serve(cloud, "127.0.0.1", 0, ssl=context, process_request=admit) as server:
                port = server.sockets[0].getsockname()[1]
                env = {k: os.environ[k] for k in ("PATH", "LANG", "USER") if k in os.environ}
                # Both the profile builder and DSH itself must inherit only A's credential fd.
                guard = Path(tmp) / "check-env.cjs"
                guard.write_text("if ('AVL_MODEL_TOKENS' in process.env || 'AVL_MODEL_TOKEN' in process.env) "
                                 "throw Error('Host startup inherited model credentials')", encoding="ascii")
                env.update(HOME=tmp, DSH_PORT="0", AVL_MODEL_TOKEN=token, AVL_SYNTHETIC="1",
                           AVL_MODEL_TOKENS=json.dumps([token]), NODE_OPTIONS=f"--require={guard}",
                           NODE_EXTRA_CA_CERTS=str(cert), AVL_MODEL_WS=f"wss://127.0.0.1:{port}/avl/model")
                with tempfile.TemporaryFile() as log:
                    host = await asyncio.create_subprocess_exec(str(ROOT / "tools/dsh.sh"), env=env,
                                                                cwd=tmp, stdout=log, stderr=log)
                    try:
                        async with asyncio.timeout(45):
                            while True:
                                output = os.pread(log.fileno(), 100000, 0).decode()
                                match = re.search(r"dsh web: (http://[^/]+)(/\?token=\S+)", output)
                                if match:
                                    break
                                self.assertIsNone(host.returncode)
                                await asyncio.sleep(.05)
                            origin, login = match.groups()
                            async with httpx.AsyncClient(base_url=origin, trust_env=False) as client:
                                response = await client.get(login)
                                cookie = "; ".join(x.split(";")[0] for x in response.headers.get_list("set-cookie"))
                                self.assertTrue(cookie, "Owner login failed")
                            async with connect(origin.replace("http:", "ws:") + "/avl/view?watch=0",
                                               origin=origin, additional_headers={"Cookie": cookie}) as viewer:
                                async def expect(state):
                                    while True:
                                        message = json.loads(await viewer.recv())
                                        if message["modelConnection"]["state"] == state:
                                            return
                                await expect("unauthorized")
                                refusal = 409
                                await expect("duplicate")
                                refusal = None
                                await expect("connected")
                                await complete
                            self.assertGreaterEqual(len(attempts), 3)
                            self.assertTrue(all(path == "/avl/model" and valid for path, valid in attempts))
                    finally:
                        if host.returncode is None:
                            host.terminate()
                            try:
                                await asyncio.wait_for(host.wait(), 8)
                            except TimeoutError:
                                host.kill()
                                await host.wait()
                    log.seek(0)
                    output = log.read().decode()
                    self.assertTrue(token not in output, "Host logged its cloud credential")
