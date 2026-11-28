"""One-shot image initialization. tini waits for this process through exec into DSH."""
import os
import pathlib
import pwd
import re
import secrets
import socket
import subprocess
import sys

LIBEXEC = "/usr/local/libexec/avl"
RUN = pathlib.Path("/run/avl")
ROOT_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"}


def take_credentials(env):
    password = env.pop("AVL_SUDO_PASSWORD", "")
    token = env.pop("AVL_MODEL_TOKEN", "")
    for name in ("SUDO_PW", "ARG_SUDO_INITIAL_PW", "VNC_PW", "AVL_MODEL_TOKENS"):
        env.pop(name, None)
    if any(not v or len(v.encode()) > 512 or any(c in v for c in "\n\r\0")
           for v in (password, token)):
        raise ValueError("Supply one-line AVL_SUDO_PASSWORD and AVL_MODEL_TOKEN, each up to 512 bytes")
    if not re.fullmatch(r"[!-~]{1,512}", token):
        raise ValueError("AVL_MODEL_TOKEN must contain printable ASCII without spaces")
    if password == token:
        raise ValueError("Supply distinct AVL_SUDO_PASSWORD and AVL_MODEL_TOKEN values")
    return password, token


def configure_system(account, password):
    if account.pw_uid == 0 or not re.fullmatch(r"[a-z_][a-z0-9_-]*", account.pw_name):
        raise ValueError("Invalid desktop account")
    operations = pwd.getpwnam("avl-ops")
    RUN.mkdir(mode=0o755, exist_ok=True)
    private = RUN / "credentials"
    private.mkdir(mode=0o711, exist_ok=True)
    # Parent is root-owned. Replace the inode even across a manual container restart.
    target = private / "sudo"
    target.unlink(missing_ok=True)
    with target.open("x", encoding="utf8") as file:
        os.fchmod(file.fileno(), 0o400)
        file.write(password+"\n")
        os.fchown(file.fileno(), operations.pw_uid, operations.pw_gid)
    # Retire baked image passwords even when their old values remain in image history.
    changes = f"{operations.pw_name}:{password}\n{account.pw_name}:{secrets.token_urlsafe(48)}\n"
    subprocess.run(["/usr/sbin/chpasswd"], input=changes, text=True, check=True, env=ROOT_ENV)
    subprocess.run(["/usr/sbin/usermod", "-L", "root"], check=True, env=ROOT_ENV)

    keydir = pathlib.Path("/var/lib/avl-sshd")
    keydir.mkdir(mode=0o700, exist_ok=True)
    host_key = keydir/"host_ed25519"
    if not host_key.exists():
        subprocess.run(["/usr/bin/ssh-keygen","-q","-t","ed25519","-N","","-f",str(host_key)],
                       check=True, env=ROOT_ENV)
    port = int(os.environ.get("AVL_SSHD_PORT","22"))
    if not 1 <= port <= 65535:
        raise ValueError("AVL_SSHD_PORT out of range")
    pathlib.Path("/run/sshd").mkdir(mode=0o755, exist_ok=True)
    (RUN/"sshd_config").write_text(
        f"Port {port}\nHostKey {host_key}\nPidFile /run/sshd/avl.pid\n"
        f"AllowUsers {account.pw_name}\nPermitRootLogin no\nPasswordAuthentication no\n"
        "KbdInteractiveAuthentication no\nPubkeyAuthentication yes\nStrictModes yes\n"
        "UsePAM yes\nSubsystem sftp internal-sftp\n", encoding="ascii")


def drop_to_desktop(account, env, view_password):
    runtime = RUN / "desktop"
    runtime.mkdir(mode=0o700, exist_ok=True)
    os.chown(runtime,account.pw_uid,account.pw_gid)
    os.initgroups(account.pw_name, account.pw_gid)
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    display = env.get("DISPLAY",":1")
    if not re.fullmatch(r":[0-9]+(?:\.0)?",display):
        raise ValueError("DISPLAY must identify a local X server")
    env.update(USER=account.pw_name, LOGNAME=account.pw_name, HOME=account.pw_dir,
               DISPLAY=display, XAUTHORITY=str(runtime/"Xauthority"),
               XDG_RUNTIME_DIR=str(runtime), DBUS_SESSION_BUS_ADDRESS=f"unix:path={runtime}/bus",
               AVL_MANAGE_DESKTOP="1", AVL_MODEL_TOKEN_FD="3")
    if not env.get("DSH_BIND"):
        # DSH binds a concrete interface address. Docker port forwarding targets the container IP.
        env["DSH_BIND"] = socket.gethostbyname(socket.gethostname())
    # xauth reads commands on stdin; the live X cookie is absent from process argv.
    env.pop("XAUTHLOCALHOSTNAME", None)
    subprocess.run(["/usr/bin/xauth","-q","-f",env["XAUTHORITY"]],
                   input=f"add {display} . {secrets.token_hex(16)}\n",text=True,env=env,check=True)
    with (runtime/"vnc.passwd").open("wb") as out:
        subprocess.run(["/usr/bin/vncpasswd","-f"], input=(view_password+"\n").encode(),
                       stdout=out,check=True,env=env)


def main():
    if os.geteuid() != 0:
        raise RuntimeError("The one-shot entrypoint must start as root")
    os.umask(0o077)
    env = dict(os.environ)
    password, token = take_credentials(env)
    view_password = env.pop("AVL_NOVNC_PASSWORD", None) or secrets.token_hex(4)
    if not (6 <= len(view_password) <= 8 and view_password.isascii() and view_password.isprintable()
            and view_password not in (password, token)):
        raise ValueError("AVL_NOVNC_PASSWORD must be a distinct 6-8 character printable ASCII value")
    account = pwd.getpwnam(env["HEADLESS_USER_NAME"])
    configure_system(account,password)
    del password
    # Operations uid needs traverse access. Files inside credentials retain mode 0400.
    os.chmod(RUN,0o755)
    os.chmod(RUN/"credentials",0o711)
    os.chmod("/run/sshd",0o755)
    drop_to_desktop(account,env,view_password)
    os.chdir(account.pw_dir)
    fd = os.memfd_create("avl-model-credential",os.MFD_CLOEXEC)
    os.write(fd,token.encode())
    os.lseek(fd,0,os.SEEK_SET)
    if fd != 3:
        os.dup2(fd,3)
        os.close(fd)
    os.set_inheritable(3,True)
    os.execve("/opt/avl/tools/dsh.sh",["dsh.sh",*sys.argv[1:]],env)


if __name__ == "__main__":
    main()
