"""Live DSH Web smoke using disposable local workspaces and stored session history."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue
from threading import Thread

import httpx

ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def isolated_host(home, expected_onboarding=None, **settings):
    # Keep ambient user credentials, proxy configuration and project .env out of this test.
    env = {k: os.environ[k] for k in ("PATH", "LANG", "USER") if k in os.environ}
    env.update(HOME=str(home), DSH_HOME=str(home / "dsh"), DSH_PORT="0",
               AVL_SYNTHETIC="1", AVL_MODEL_TOKEN="local-test-only", **settings)
    with tempfile.TemporaryFile("w+") as log:
        proc = subprocess.Popen([str(ROOT / "tools/dsh.sh")], cwd=home, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(400):
                log.seek(0)
                entry = re.search(r"dsh web: (http://\S+)", log.read())
                if entry:
                    break
                if proc.poll() is not None:
                    raise RuntimeError("DSH exited before starting")
                time.sleep(.1)
            else:
                raise RuntimeError("DSH listen timeout")
            url = entry[1]
            with httpx.Client(base_url=url.split("/?")[0], follow_redirects=True, trust_env=False) as client:
                assert client.get("/avl/health").status_code == 403
                page = client.get(url)
                page.raise_for_status()
                if expected_onboarding is not None:
                    assert re.search(r'"credentialOnboarding"\s*:\s*' + json.dumps(expected_onboarding), page.text)
                assert client.get("/avl/health").json()["state"] == "disabled"
                def rpc(method, request):
                    response = client.post("/api/" + method, json={
                        "type": "client-request", "rpcId": "smoke", "method": method,
                        "payload": {"args": {"request": request}},
                    })
                    response.raise_for_status()
                    result = response.json()["result"]
                    if not result["ok"]:
                        raise AssertionError(json.dumps(result["error"]))
                    return result["value"]
                yield rpc
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


class WorkspaceTests(unittest.TestCase):
    def test_main_model_environment_routes_new_chat(self):
        requests = Queue()

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.put((self.path, self.headers.get("Authorization"), body))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                chunk = {"choices":[{"index":0,"delta":{"role":"assistant","content":"ready"},"finish_reason":"stop"}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode())

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Model) as server, tempfile.TemporaryDirectory() as folder:
            Thread(target=server.serve_forever, daemon=True).start()
            try:
                home = Path(folder)
                with isolated_host(home, expected_onboarding=False, AVL_MAIN_BASE_URL=f"http://127.0.0.1:{server.server_port}/v1",
                                   AVL_MAIN_MODEL="desktop-test", AVL_MAIN_API_KEY="fixture-main-key") as rpc:
                    wid = rpc("workspace/create", {"path":folder})["workspace"]["workspaceId"]
                    sid = rpc("session/create", {"workspaceId":wid})["sessionId"]
                    rpc("session/prompt", {"sessionId":sid, "requestId":"test-main", "mode":"queue",
                                          "content":[{"type":"text", "text":"Reply ready"}]})
                    path, auth, body = requests.get(timeout=15)
                    self.assertEqual((path, auth, body["model"]), ("/v1/chat/completions", "Bearer fixture-main-key", "desktop-test"))
                    self.assertTrue(body["tools"])
                    self.assertNotIn("fixture-main-key", (home/"dsh/run/avl-profile.yml").read_text())
            finally:
                server.shutdown()

    def test_two_workspaces_and_sessions_survive_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            workspaces = {}
            for name in ("research", "reports"):
                (home/name).mkdir()
            with isolated_host(home) as rpc:
                for name in ("research", "reports"):
                    workspace = rpc("workspace/create", {"path": str(home/name)})["workspace"]
                    session = rpc("session/create", {"workspaceId": workspace["workspaceId"]})
                    workspaces[name] = workspace["workspaceId"], session["sessionId"]
                self.assertNotEqual(workspaces["research"][0], workspaces["reports"][0])
                self.assertNotEqual(workspaces["research"][1], workspaces["reports"][1])
            with isolated_host(home) as rpc:
                for name, (wid, sid) in workspaces.items():
                    value = rpc("workspace/create", {"path": str(home/name)})
                    self.assertFalse(value["created"])
                    self.assertEqual(value["workspace"]["workspaceId"], wid)
                    self.assertIn(sid, value["workspace"]["sessionIds"])
