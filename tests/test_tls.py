"""Exercise the production launcher and direct authenticated WSS, with a private test CA."""
import asyncio
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

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("openssl"), "test certificate generation requires openssl")
class DirectTlsTests(unittest.TestCase):
    def test_authenticated_model_heartbeat_and_private_idle_stream(self):
        with tempfile.TemporaryDirectory() as tmp:
            cert, key = Path(tmp)/"cert.pem", Path(tmp)/"key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                            "-days", "1", "-subj", "/CN=localhost", "-addext",
                            "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", str(key),
                            "-out", str(cert)], check=True, capture_output=True)
            token = secrets.token_urlsafe(24)
            env = {k: os.environ[k] for k in ("PATH", "LANG", "USER") if k in os.environ}
            env.update(HOME=tmp, DSH_PORT="0", AVL_MODEL_TOKEN=token, AVL_SYNTHETIC="1")
            with tempfile.TemporaryFile("w+") as log:
                host = subprocess.Popen([str(ROOT/"tools/dsh.sh"), "--tls-cert", str(cert),
                                         "--tls-key", str(key)], env=env, cwd=tmp, stdout=log, stderr=log)
                try:
                    for _ in range(300):
                        log.seek(0)
                        match = re.search(r"dsh web: https://127\.0\.0\.1:(\d+)", log.read())
                        if match:
                            break
                        if host.poll() is not None:
                            self.fail("TLS Host exited during startup")
                        time.sleep(.1)
                    self.assertIsNotNone(match, "Timed out waiting for TLS Host")
                    url = f"wss://127.0.0.1:{match[1]}/avl/model"
                    asyncio.run(self.handshake(url, cert, token))
                finally:
                    host.terminate()
                    try:
                        host.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        host.kill()
                        host.wait()

    async def handshake(self, url, cert, token):
        context = ssl.create_default_context(cafile=str(cert))
        with self.assertRaises(InvalidStatus) as denied:
            async with connect(url, ssl=context, open_timeout=3):
                self.fail("Missing token admitted")
        self.assertEqual(denied.exception.response.status_code, 403)
        async with connect(url, ssl=context, open_timeout=3,
                                      additional_headers={"Authorization": "Bearer " + token}) as sock:
            await sock.send(json.dumps({"type":"hello", "version":2, "mode":"full"}))
            for _ in range(2):
                message = await asyncio.wait_for(sock.recv(), 4)
                self.assertIsInstance(message, str, "Idle model received video")
                ping = json.loads(message)
                self.assertEqual(ping["type"], "ping")
                now = time.monotonic() * 1000
                await sock.send(json.dumps(dict(ping, type="pong", t1=now, t2=now)))
