"""Exercise production FFmpeg and xdotool against a private, disposable X server."""
import os
import secrets
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


class X11Tests(unittest.TestCase):
    @unittest.skipUnless(all(shutil.which(x) for x in ("Xvnc","vncpasswd","xauth","xdotool","ffmpeg")), "requires desktop image tools")
    def test_capture_and_input_on_private_display(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="avl-display-") as folder:
            private = Path(folder)
            display = next(n for n in range(210, 400) if not Path(f"/tmp/.X{n}-lock").exists()
                           and not Path(f"/tmp/.X11-unix/X{n}").exists())
            env = {**os.environ, "DISPLAY": f":{display}", "XAUTHORITY": str(private/"auth")}
            subprocess.run(["xauth","-q","-f",env["XAUTHORITY"]],env=env,check=True,capture_output=True,
                           input=f"add :{display} . {secrets.token_hex(16)}\n",text=True)
            with (private/"password").open("wb") as pw:
                subprocess.run(["vncpasswd","-f"],input=secrets.token_bytes(8).hex().encode()+b"\n",stdout=pw,check=True)
            server = subprocess.Popen(["Xvnc",env["DISPLAY"],"-auth",env["XAUTHORITY"],"-geometry","640x360","-depth","24",
                "-rfbport","-1","-rfbunixpath",str(private/"rfb"),"-localhost","-nolisten","tcp",
                "-SecurityTypes","VncAuth","-PasswordFile",str(private/"password")],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        self.fail("isolated X server failed to start")
                    if subprocess.run(["xdotool","getdisplaygeometry"],env=env,capture_output=True).returncode == 0:
                        break
                    time.sleep(.05)
                program = """
import assert from 'node:assert/strict';
import { Capture,x11Input } from './host/x11.mjs';
const {promise,resolve,reject}=Promise.withResolvers();
const capture=new Capture({fps:12,publish:(frame,w,h)=>resolve([frame,w,h]),lost:reject});
const timeout=setTimeout(()=>reject(Error('no X11 frame')),5000);
capture.demand(true);
try {
  const [frame,width,height]=await promise;
  assert.equal(frame.readUInt16BE(),0xffd8);
  assert.deepEqual([width,height],[640,360]);
  await x11Input({kind:'move',x:500,y:500},{width,height});
} finally {clearTimeout(timeout);capture.demand(false);}

// Dispatch a real long key sequence and check the OS child is gone by the takeover acknowledgement.
const { Desktop } = await import('./host/desktop.mjs');
const { readFileSync, existsSync } = await import('node:fs');
const desktop = new Desktop({input:x11Input, demand() {}});
const controls = [];
const model = {send:m=>controls.push(m),frame(){},discard(){}};
const viewer = {frame(){},discard(){}};
desktop.addViewer(viewer);
desktop.attachModel(model, 'simulator');
const {leaseId, stream} = await desktop.start('agent');
function step(observeOnly, seq) {
  const result = desktop.step('agent',leaseId,'desktop test',observeOnly,new AbortController().signal);
  desktop.publish(Buffer.from('frame'),640,360);
  desktop.metrics.progress({seq,received:seq,processed:seq,processedSeq:seq},performance.now());
  desktop.result({stream,id:controls.at(-1).id,seq,observation:'test',action:observeOnly ? null : {kind:'type',text:'x'.repeat(4096)}});
  return result;
}
await step(true,1);
const stopped = assert.rejects(step(false,2), /中断|未知/);
await new Promise(r=>setImmediate(r));
const childIds=readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/ +/);
const live=childIds.filter(pid=>{
  try {return readFileSync(`/proc/${pid}/comm`,'utf8').trim()==='xdotool';} catch {return false;}
});
assert.equal(live.length,1,'expected one active xdotool input');
await desktop.viewerCommand(viewer,{type:'take',leaseId});
assert.equal(desktop.status(viewer).owner,true);
assert.equal(existsSync(`/proc/${live[0]}`),false,'xdotool child survived transfer');
await stopped;
"""
                subprocess.run(["node","--input-type=module","-e",program],env=env,cwd=root,check=True,timeout=15)
                point=subprocess.check_output(["xdotool","getmouselocation","--shell"],env=env,text=True)
                self.assertIn("X=320\n",point)
                self.assertIn("Y=180\n",point)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
