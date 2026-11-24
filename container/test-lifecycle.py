"""Usage: python3 container/test-lifecycle.py IMAGE (disposable Docker containers only)."""
import os
import secrets
import shutil
import subprocess
import sys
import time
import uuid


def docker(*args, check=True, capture=True, env=None):
    return subprocess.run(["docker", *args],check=check,text=True,capture_output=capture,env=env,timeout=120)


def inside(name, command, check=True):
    return docker("exec","--user","root",name,"/bin/sh","-ec",command,check=check)


def wait_ready(name, test):
    deadline = time.monotonic()+100
    while time.monotonic()<deadline:
        if inside(name,test,False).returncode==0:
            return
        time.sleep(1)
    raise RuntimeError("Container readiness check timed out")


def run(image,signal):
    password = secrets.token_urlsafe(24)
    env = {**os.environ,"AVL_SUDO_PASSWORD":password,"AVL_MODEL_TOKEN":secrets.token_urlsafe(32)}
    name = "avl-lifecycle-"+uuid.uuid4().hex
    try:
        docker("run","--detach","--name",name,"--env","AVL_SUDO_PASSWORD","--env","AVL_MODEL_TOKEN",image,env=env)
        # Owned container only. Require both the API process and independent desktop components.
        wait_ready(name, 'pgrep -x Xvnc && pgrep -x xfce4-terminal && test -s /run/sshd/avl.pid')
        init_child = inside(name, 'cat /proc/1/task/1/children').stdout.split()
        hosts = [pid for pid in init_child if inside(name, f'readlink /proc/{int(pid)}/exe',False).stdout.strip()=='/usr/local/bin/node']
        if len(hosts)!=1:
            raise RuntimeError("tini has no unique direct Node child")
        secretfile = '/run/avl/credentials/sudo'
        inside(name, f'test ! -e /dockerstartup/.initial_sudo_password && '
                    f'! runuser -u "$HEADLESS_USER_NAME" -- test -r {secretfile}')
        # The runtime credential must not be present in any desktop-user process environment.
        output = inside(name, 'for p in $(pgrep -u "$HEADLESS_USER_NAME"); do cat "/proc/$p/environ" 2>/dev/null || :; done').stdout
        if password in output:
            raise RuntimeError("Desktop process inherited the sudo credential")
        if signal=="TERM":
            pid=inside(name,"pgrep -x Xvnc").stdout.strip()
            inside(name,f"kill -KILL {int(pid)}")
            wait_ready(name,f'test "$(pgrep -x Xvnc)" != {int(pid)} && pgrep -x Xvnc && pgrep -x xfce4-terminal')
            pid=inside(name,"cat /run/sshd/avl.pid").stdout.strip()
            inside(name,f"kill -KILL {int(pid)}")
            wait_ready(name,f'test "$(cat /run/sshd/avl.pid)" != {int(pid)} && kill -0 "$(cat /run/sshd/avl.pid)"')
            docker("stop","-t","15",name)
        else:
            inside(name,f"kill -KILL {hosts[0]}",False)
        status=int(docker("wait",name).stdout.strip())
        if status not in ((0,143) if signal=="TERM" else (137,)):
            raise RuntimeError(f"Unexpected container exit for {signal}: {status}")
        print(f"{signal}: container exited {status}")
    finally:
        docker("rm","-f",name,check=False)


if __name__=="__main__":
    if sys.argv[1:] in (["--help"], ["-h"]):
        print(__doc__)
        sys.exit(0)
    if len(sys.argv)!=2 or not shutil.which("docker"):
        sys.exit("Supply a built image and run on a Docker host")
    image = sys.argv[1]
    env = {**os.environ, "AVL_SUDO_PASSWORD":secrets.token_urlsafe(24), "AVL_MODEL_TOKEN":secrets.token_urlsafe(32)}
    missing = docker("run","--rm","--env","AVL_SUDO_PASSWORD=","--env","AVL_MODEL_TOKEN=",image,check=False)
    if missing.returncode != 1 or "Supply one-line AVL_SUDO_PASSWORD" not in missing.stderr:
        sys.exit("Unexpected startup-failure exit status")
    docker("run","--rm","--env","AVL_SUDO_PASSWORD","--env","AVL_MODEL_TOKEN",image,"--help",env=env)
    print("Initialization failure and normal DSH exit propagated")
    for case in ("TERM","KILL"):
        run(image,case)
