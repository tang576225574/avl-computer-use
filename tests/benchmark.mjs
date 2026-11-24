// Run explicitly with node tests/benchmark.mjs. The delay bridge is confined to this test process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const duration = Number(process.env.AVL_BENCH_SECONDS ?? 8);
assert.ok(Number.isFinite(duration) && duration >= 3, "AVL_BENCH_SECONDS must be >= 3");
const bridgeDelay = Number(process.env.AVL_BENCH_DELAY_MS ?? 35);
assert.ok(Number.isFinite(bridgeDelay) && bridgeDelay >= 0 && bridgeDelay <= 1000);

async function until(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await check();
    if (result) return result;
    await sleep(30);
  }
  throw new Error("Timed out waiting for " + label);
}

// This temporary DSH plugin calls the published tool from inside the isolated Host.
// It exposes no network route; the private directory holds one command at a time.
const driverCode = `
import { readFile, writeFile, rm, rename } from "node:fs/promises";
export const inject = ["tools", "agents"];
export function apply(ctx) {
  ctx.effect(() => {
    let handle;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        let command;
        try { command = JSON.parse(await readFile("request", "utf8")); }
        catch (err) { if (err.code === "ENOENT") return; throw err; }
        await rm("request");
        const tool = ctx.tools.get(command.name);
        let response;
        try {
          if (!["desktop_stream_start","desktop_stream_stop","desktop_step"].includes(command.name) || !tool) throw Error("Missing desktop tool");
          handle ??= await ctx.agents.create({ sessionId: "bench", meta: { cwd: process.cwd() } });
          response = { value: await tool.execute(command.args, { agent: handle.agent, signal: AbortSignal.timeout(3000) }) };
        } catch (e) { response = {error: String(e)}; }
        await writeFile("reply.tmp", JSON.stringify(response));
        await rename("reply.tmp", "reply");
      } finally { busy = false; }
    }, 30);
    return () => clearInterval(timer);
  });
}
`;

async function invoke(dir, name, args={}) {
  await writeFile(join(dir, "request.tmp"), JSON.stringify({name,args}));
  await rename(join(dir, "request.tmp"), join(dir, "request"));
  const raw = await until(() => readFile(join(dir, "reply"), "utf8").catch(() => null), name);
  await rm(join(dir, "reply"));
  const result = JSON.parse(raw);
  assert.ok(!result.error, result.error);
  return JSON.parse(result.value);
}

async function terminate(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, "exit");
  proc.kill("SIGTERM");
  const force = setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
  try { await exited; } finally { clearTimeout(force); }
}

async function benchmark(fps, lag, mockQwen=false) {
  const dir = await mkdtemp(join(tmpdir(), "avl-v2-bench-"));
  const token = randomUUID();
  const env = { PATH: process.env.PATH, HOME: dir, USER: process.env.USER, LANG: "C.UTF-8" };
  const captureEnv = process.env.AVL_BENCH_DISPLAY
    ? { DISPLAY:process.env.AVL_BENCH_DISPLAY, XAUTHORITY:process.env.XAUTHORITY }
    : { AVL_SYNTHETIC:"1" };
  let dsh, model, viewer, bridge, forward, completions;
  let sentFrames = 0, payloadBytes = 0, firstFrameMs, lastFrameMs, qwenCalls=0;
  const timers = new Set();
  try {
    await writeFile(join(dir,"driver.mjs"), driverCode);
    const patch = [{insert: [
      {id:"avl-desktop",name:join(root,"host","plugin.mjs")},
      {id:"bench-driver",name:join(dir,"driver.mjs")},
    ]}];
    await writeFile(join(dir,"patch.yml"), JSON.stringify(patch));
    dsh = spawn(process.execPath, [
      join(root,"node_modules/@deepseek-ai/dsh/lib/bin.js"), "--profile","web","--patch",join(dir,"patch.yml"),
      "--host","127.0.0.1","--port","0","--no-open",
    ], {cwd:dir,env:{...env, DSH_HOME:join(dir,"dsh"),AVL_MODEL_TOKEN:token,AVL_CAPTURE_FPS:String(fps),
                      ...captureEnv},stdio:["ignore","pipe","pipe"]});
    let url, logs = "";
    for (const stream of [dsh.stdout,dsh.stderr]) {
      stream.on("data", data => {
        logs = (logs + data.toString()).slice(-8192);
        url ??= logs.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
      });
    }
    const login = await until(() => {
      if (dsh.exitCode !== null) throw Error("Benchmark DSH exited before login");
      return url;
    }, "DSH Web", 30000);
    const origin = new URL(login).origin;
    const first = await fetch(login, {redirect:"manual"});
    const cookie = first.headers.getSetCookie().map(v => v.split(";")[0]).join("; ");
    assert.ok(cookie.length, "DSH owner cookie missing");
    const hostWs = origin.replace("http:", "ws:");
    viewer = new WebSocket(hostWs + "/avl/view", {headers:{Cookie:cookie, Origin:origin}});
    let status, viewerFrames = 0, doneStatus = false;
    viewer.on("error", () => {});
    viewer.on("message", (msg,binary) => {
      if (binary) { viewerFrames += 1; return; }
      const data = JSON.parse(msg);
      if (data.type === "status") {status = data; doneStatus = !status.subscribed;}
    });
    // Observe every model-bound binary packet on an instrumented loopback link.
    bridge = new WebSocketServer({host:"127.0.0.1",port:0,perMessageDeflate:false});
    await once(bridge,"listening");
    bridge.on("connection",(receiver,req) => {
      forward = new WebSocket(hostWs + "/avl/model",{headers:{Authorization:req.headers.authorization},perMessageDeflate:false});
      const queue=[];
      function deliver(source,dest,count) {
        source.on("message",(msg,binary)=>{
          if (count && binary) {
            sentFrames++;
            firstFrameMs ??= performance.now();
            lastFrameMs = performance.now();
            if (sentFrames>1) payloadBytes += msg.length;
          }
          const write=()=>{if(dest.readyState===WebSocket.OPEN) dest.send(msg,{binary});};
          if (dest.readyState===WebSocket.CONNECTING) queue.push(write);
          else if (lag) {
            const timer=setTimeout(()=>{timers.delete(timer);write();},lag);
            timers.add(timer);
          } else write();
        });
      }
      deliver(receiver,forward,false); deliver(forward,receiver,true);
      forward.on("open",()=>{while(queue.length) queue.shift()();});
      forward.on("error",()=>receiver.terminate());
      receiver.on("error",()=>forward.terminate());
      forward.on("close",()=>receiver.terminate());
      receiver.on("close",()=>forward.terminate());
    });
    const modelArgs = ["-m","model.adapter"];
    if (mockQwen) {
      // The HTTP response is synthetic; the adapter, HTTP client and inference scheduling are real.
      completions = createServer(async (req,res) => {
        let body="";
        for await (const chunk of req) body += chunk;
        const request=JSON.parse(body);
        const image=request.messages.at(-1).content.find(c => c.type==="image_url");
        if (!image?.image_url.url.startsWith("data:image/jpeg;base64,")) {res.writeHead(400);res.end();return;}
        qwenCalls++;
        await sleep(100);
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({observation:"Synthetic fixture",action:null})}}]}));
      });
      completions.listen(0,"127.0.0.1");
      await once(completions,"listening");
      modelArgs.push("--qwen-url",`http://127.0.0.1:${completions.address().port}/v1`);
    } else modelArgs.push("--benchmark");
    model = spawn(process.env.PYTHON ?? "python3", modelArgs, {
      cwd:root,env:{...env,AVL_MODEL_TOKEN:token,AVL_MODEL_WS:`ws://127.0.0.1:${bridge.address().port}/avl/model`},
      stdio:["ignore","ignore","pipe"],
    });
    model.stderr.resume();
    await until(()=>status?.modelMode===(mockQwen?"simulator":"benchmark") && viewerFrames >= 5,"active viewer and connected idle model");
    assert.equal(sentFrames,0,"idle viewer leaked video to model before task");
    const { leaseId } = await invoke(dir,"desktop_stream_start");
    assert.ok(leaseId, "start must return a lease ID");
    await until(()=>status?.subscribed && status.metrics.received>0,"model receiving real frames");
    if (mockQwen) {
      const result=await invoke(dir,"desktop_step",{leaseId,instruction:"Observe the fixture",observe_only:true});
      assert.equal(result.observation,"Synthetic fixture");
      assert.equal(result.action,null);
    }
    await sleep(duration*1000);
    const metrics=status.metrics;
    assert.ok(metrics.received>=fps*duration*.75,"unexpectedly low local throughput");
    if (mockQwen) assert.ok(qwenCalls>1 && metrics.processed>0 && metrics.visualAckP95>0);
    else assert.equal(metrics.processed,0,"benchmark must not claim model inference");
    assert.ok(metrics.modelBytes>0 && metrics.ackP95>0);
    await invoke(dir,"desktop_stream_stop",{leaseId});
    await until(()=>doneStatus,"stopped task");
    await sleep(lag*2+100);
    const atStop=sentFrames, viewed=viewerFrames;
    await sleep(600);
    assert.equal(sentFrames,atStop,"model received video after stop");
    assert.ok(viewerFrames>viewed,"independent viewer stalled after model stop");
    const payloadMbps = payloadBytes * 8 / (lastFrameMs-firstFrameMs) / 1000;
    console.log(JSON.stringify({mode:mockQwen?"mock-100ms-Qwen":"receive-only", fps,delayEachDirectionMs:lag,
      windowSeconds:duration,modelBoundFrames:atStop,payloadMbps,...metrics}));
  } finally {
    viewer?.terminate();
    forward?.terminate();
    for(const item of bridge?.clients??[]) item.terminate();
    for(const timer of timers) clearTimeout(timer);
    if(bridge) await new Promise(resolve=>bridge.close(resolve));
    if(completions) await new Promise(resolve=>completions.close(resolve));
    await Promise.all([terminate(model),terminate(dsh)]);
    await rm(dir,{recursive:true,force:true});
  }
}
for (const [fps,lag,mock] of [[12,0,false],[24,0,false],[24,bridgeDelay,false],[24,0,true]]) await benchmark(fps,lag,mock);
