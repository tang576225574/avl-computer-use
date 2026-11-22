"""Fixed health and recovery operations inside the desktop container."""

import fcntl
import http.client
import json
import os
import socket
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from functools import cache
from pathlib import Path

from websockets.exceptions import WebSocketException
from websockets.sync.client import connect

SERVICE_CONFIG = "/etc/supervisor/supervisord.conf"
RUN = Path("/run/avl")
DEPENDENTS = ("xfce", "novnc", "backend")
SERVICES = ("x11", *DEPENDENTS)
PROBE_TIMEOUT = 1.5
BACKEND_PORT = 8080


@cache
def probe_config():
    try:
        with Path("/etc/avl/desktop-ops.json").open() as file:
            metadata = os.fstat(file.fileno())
            if metadata.st_uid != 0 or metadata.st_mode & 0o022:
                raise PermissionError("Desktop probe settings must be owned and writable only by root")
            config = json.load(file)
    except FileNotFoundError:
        return {}
    if not isinstance(config, dict):
        raise ValueError("Desktop probe settings must be a JSON object")
    return config


def probe_port(name, default):
    value = probe_config().get(name, default)
    if type(value) is not int or not 1 <= value <= 65535:
        raise ValueError(f"Invalid desktop probe port: {name}")
    return value


def local_command(*argv, env=None):
    return subprocess.run(argv, capture_output=True, text=True, timeout=PROBE_TIMEOUT, env=env).returncode == 0


def http_status(port, path, *, method="GET"):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=PROBE_TIMEOUT)
    try:
        connection.request(method, path)
        return connection.getresponse().status
    finally:
        connection.close()


def x11_live():
    config = probe_config()
    authority = config.get("xauthority")
    display = config.get("display", ":1")
    environment = {**os.environ, "XAUTHORITY": authority} if authority else None
    query = ("/usr/bin/xdpyinfo", "-display", display) if Path("/usr/bin/xdpyinfo").exists() else (
        "/usr/bin/xrandr", "--display", display, "--current",
    )
    if not local_command(*query, env=environment):
        return False
    with socket.create_connection(("127.0.0.1", probe_port("vnc_port", 5901)), timeout=PROBE_TIMEOUT) as connection:
        with connection.makefile("rb") as data:
            return data.read(12).startswith(b"RFB ")


def novnc_live():
    port = probe_port("novnc_port", 6902)
    if http_status(port, "/vnc.html", method="HEAD") != 200:
        return False
    with connect(f"ws://127.0.0.1:{port}/websockify", open_timeout=PROBE_TIMEOUT,
                 close_timeout=0.2, max_size=1024) as link:
        greeting = link.recv(timeout=PROBE_TIMEOUT)
        return isinstance(greeting, bytes) and greeting.startswith(b"RFB ")


def backend_live():
    return http_status(probe_port("backend_port", BACKEND_PORT), "/v1/health") == 204


def supervisor_command(action, name, *, timeout):
    config = probe_config().get("supervisor_config", SERVICE_CONFIG)
    return subprocess.run(
        ("/usr/bin/supervisorctl", "-c", config, action, name),
        capture_output=True, text=True, timeout=timeout,
    )


def supervisor_state(name):
    result = supervisor_command("status", name, timeout=PROBE_TIMEOUT)
    fields = result.stdout.split()
    return fields[1] if len(fields) > 1 and fields[0] == name else None


def healthy(name):
    try:
        if name == "xfce":
            return supervisor_state(name) == "RUNNING"
        return {"x11": x11_live, "novnc": novnc_live, "backend": backend_live}[name]()
    except (OSError, ValueError, http.client.HTTPException, WebSocketException, subprocess.TimeoutExpired):
        return False


def probe():
    with ThreadPoolExecutor(max_workers=len(SERVICES)) as pool:
        return dict(zip(SERVICES, pool.map(healthy, SERVICES)))


def control(action, name):
    if action == "restart":
        control("stop", name)
        control("start", name)
        return
    result = supervisor_command(action, name, timeout=6)
    accepted = "not running" if action == "stop" else "already started"
    if result.returncode and accepted not in result.stdout.lower():
        raise RuntimeError(f"could not {action} {name}: {result.stdout.strip() or result.stderr.strip()}")


def recover(name):
    if name not in SERVICES:
        raise ValueError("unknown component")
    if healthy(name) or (name != "x11" and not healthy("x11")):
        return
    if name != "x11":
        control("restart", name)
        return
    for dependent in reversed(DEPENDENTS):
        control("stop", dependent)
    control("restart", "x11")
    for dependent in DEPENDENTS:
        control("start", dependent)


def parse_operation(command):
    if command == "probe":
        return ("probe",)
    for service in SERVICES:
        if command == f"recover {service}":
            return ("recover", service)
    return None


def recover_locked(name):
    RUN.mkdir(mode=0o700, exist_ok=True)
    with (RUN / "recovery.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        recover(name)


def main():
    if len(sys.argv) > 1:
        operation = parse_operation(" ".join(sys.argv[1:]))
    else:
        line = sys.stdin.readline(128)
        operation = parse_operation(line.removesuffix("\n")) if line.endswith("\n") else None
    if not operation:
        return 2
    if operation == ("probe",):
        print(json.dumps(probe()))
        return 0
    try:
        recover_locked(operation[1])
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"Desktop recovery failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
