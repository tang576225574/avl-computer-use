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

import httpx

ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def isolated_host(home):
    # Keep ambient user credentials, proxy configuration and project .env out of this test.
    env = {k: os.environ[k] for k in ("PATH", "LANG", "USER") if k in os.environ}
    env.update(HOME=str(home), DSH_HOME=str(home / "dsh"), DSH_PORT="0",
               AVL_SYNTHETIC="1", AVL_MODEL_TOKEN="local-test-only")
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
                client.get(url).raise_for_status()
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
