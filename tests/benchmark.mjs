// Run explicitly with node tests/benchmark.mjs. The delay bridge is confined to this test process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

async function invoke(dir, name, args = {}) {
  await writeFile(join(dir, "request.tmp"), JSON.stringify({ name, args }));
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
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

function hostProcess(dir, token, fps, endpoint) {
  const capture = process.env.AVL_BENCH_DISPLAY
    ? { DISPLAY: process.env.AVL_BENCH_DISPLAY, XAUTHORITY: process.env.XAUTHORITY }
    : { AVL_SYNTHETIC: "1" };
  return spawn(
    process.execPath,
    [
      join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
      "--profile",
      "web",
      "--patch",
      join(dir, "patch.yml"),
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-open",
    ],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        USER: process.env.USER,
        LANG: "C.UTF-8",
        DSH_HOME: join(dir, "dsh"),
        AVL_MODEL_TOKEN: token,
        AVL_MODEL_WS: endpoint,
        AVL_CAPTURE_FPS: String(fps),
        ...capture,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

// This loopback proxy measures the A→C binary stream and optionally delays both directions.
async function bridgeToCloud(port, lag, cleanup) {
  const bridge = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await once(bridge, "listening");
  const sockets = new Set(),
    timers = new Set();
  const stats = { frames: 0, bytes: 0, first: 0, last: 0 };
  cleanup.push(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.terminate();
    await new Promise((done) => bridge.close(done));
  });
  bridge.on("connection", (host, req) => {
    const cloud = new WebSocket(`ws://127.0.0.1:${port}/avl/model`, {
      headers: { Authorization: req.headers.authorization },
      perMessageDeflate: false,
    });
    for (const socket of [host, cloud]) sockets.add(socket);
    function relay(from, to, countFrames) {
      from.on("message", (data, binary) => {
        if (countFrames && binary) {
          stats.last = performance.now();
          if (!stats.frames++) stats.first = stats.last;
          else stats.bytes += data.length;
        }
        const write = () => {
          if (to.readyState === WebSocket.OPEN) to.send(data, { binary });
        };
        if (lag) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            write();
          }, lag);
          timers.add(timer);
        } else write();
      });
      from.on("error", () => to.terminate());
      from.on("close", () => {
        sockets.delete(from);
        to.terminate();
      });
    }
    // C sends hello first. A cannot send a frame until the C socket is ready.
    relay(cloud, host, false);
    relay(host, cloud, true);
  });
  return { stats, endpoint: `ws://127.0.0.1:${bridge.address().port}/avl/model` };
}

async function openDesktop(dir, token, fps, port, lag, mode, cleanup) {
  await mkdir(dir);
  const { stats, endpoint } = await bridgeToCloud(port, lag, cleanup);
  await writeFile(join(dir, "driver.mjs"), driverCode);
  const patch = [
    {
      insert: [
        { id: "avl-desktop", name: join(root, "host/plugin.mjs") },
        { id: "bench-driver", name: join(dir, "driver.mjs") },
      ],
    },
  ];
  await writeFile(join(dir, "patch.yml"), JSON.stringify(patch));
  const dsh = hostProcess(dir, token, fps, endpoint);
  cleanup.push(() => terminate(dsh));
  let login,
    logs = "";
  for (const stream of [dsh.stdout, dsh.stderr])
    stream.on("data", (data) => {
      logs = (logs + data).slice(-8192);
      login ??= logs.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
    });
  await until(
    () => {
      if (dsh.exitCode !== null) throw Error("DSH exited during benchmark startup");
      return login;
    },
    "DSH login",
    30000,
  );
  const origin = new URL(login).origin;
  const first = await fetch(login, { redirect: "manual" });
  const cookie = first.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  const viewer = new WebSocket(origin.replace("http:", "ws:") + "/avl/view", {
    headers: { Cookie: cookie, Origin: origin },
  });
  cleanup.push(() => viewer.terminate());
  const a = { dir, stats, viewerFrames: 0, stopHost: () => terminate(dsh) };
  viewer.on("error", () => {});
  viewer.on("message", (msg, binary) => {
    if (binary) {
      a.viewerFrames++;
      return;
    }
    const data = JSON.parse(msg);
    if (data.type === "status") a.status = data;
  });
  await until(() => a.status?.modelMode === mode && a.viewerFrames >= 5, "connected idle model");
  assert.equal(stats.frames, 0, "watching the desktop sent frames to C");
  return a;
}

async function startCloud(dir, tokens, slow, cleanup, port = 0) {
  const proc = spawn(
    process.env.PYTHON ?? "python3",
    [join(root, "tests/benchmark_cloud.py"), slow ? "slow" : "receive", String(port)],
    {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        PYTHONPATH: root,
        AVL_MODEL_TOKENS: JSON.stringify(tokens),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  cleanup.push(() => terminate(proc));
  let boundPort;
  proc.stdout.on("data", (data) => {
    boundPort = Number(String(data).trim());
  });
  await until(() => {
    if (proc.exitCode !== null) throw Error("Cloud fixture exited");
    return boundPort;
  }, "cloud listener");
  return { proc, port: boundPort };
}

async function benchmark(fps, lag, slow, count = 1) {
  const dir = await mkdtemp(join(tmpdir(), "avl-cloud-bench-"));
  const cleanup = [() => rm(dir, { recursive: true, force: true })];
  const tokens = Array.from({ length: count }, () => randomUUID());
  try {
    const cloud = await startCloud(dir, tokens, slow, cleanup);
    const { port } = cloud;
    const desktops = [];
    for (const [i, token] of tokens.entries()) {
      desktops.push(
        await openDesktop(
          join(dir, String(i)),
          token,
          fps,
          port,
          lag,
          slow ? "simulator" : "benchmark",
          cleanup,
        ),
      );
    }
    await Promise.all(
      desktops.map(async (a, i) => {
        const { leaseId } = await invoke(a.dir, "desktop_stream_start");
        a.leaseId = leaseId;
        await until(() => a.status.subscribed && a.status.metrics.received > 0, "real frames");
        if (slow) {
          const instruction = `Observe desktop ${i}`;
          const r = await invoke(a.dir, "desktop_step", {
            leaseId,
            instruction,
            observe_only: true,
          });
          assert.equal(r.observation, instruction, "a result crossed desktop connections");
          assert.equal(r.action, null);
        }
      }),
    );
    await sleep(duration * 1000);
    for (const [i, a] of desktops.entries()) {
      const m = a.status.metrics;
      assert.ok(m.received >= fps * duration * 0.75, "unexpectedly low local throughput");
      assert.ok(m.modelBytes > 0 && m.ackP95 > 0);
      if (slow) assert.ok(m.processed > 0 && m.visualAckP95 > 0 && m.queueP95 != null);
      else assert.equal(m.processed, 0);
      const payloadMbps = (a.stats.bytes * 8) / (a.stats.last - a.stats.first) / 1000;
      console.log(
        JSON.stringify({
          mode: slow ? "embedded-test-double" : "receive-only",
          desktop: i + 1,
          users: count,
          fps,
          delayEachDirectionMs: lag,
          windowSeconds: duration,
          payloadMbps,
          ...m,
        }),
      );
    }
    if (slow && count === 1) {
      const [desktop] = desktops;
      const oldLease = desktop.leaseId;
      await terminate(cloud.proc);
      await until(
        () => !desktop.status.subscribed && !desktop.status.modelMode,
        "lost vision service",
      );
      const frames = desktop.viewerFrames;
      await until(() => desktop.viewerFrames > frames, "viewer while C offline");
      await startCloud(dir, tokens, slow, cleanup, port);
      await until(
        () => desktop.status.modelMode === "simulator",
        "Host reconnected to restarted C",
      );
      await assert.rejects(
        invoke(desktop.dir, "desktop_step", {
          leaseId: oldLease,
          instruction: "Old lease",
          observe_only: true,
        }),
        /开启本会话/,
      );
      const { leaseId } = await invoke(desktop.dir, "desktop_stream_start");
      assert.notEqual(leaseId, oldLease);
      desktop.leaseId = leaseId;
      const observed = await invoke(desktop.dir, "desktop_step", {
        leaseId,
        instruction: "After restart",
        observe_only: true,
      });
      assert.equal(observed.observation, "After restart");
    }
    if (count > 1) {
      await desktops[0].stopHost();
      const survivor = desktops[1],
        before = survivor.stats.frames;
      const r = await invoke(survivor.dir, "desktop_step", {
        leaseId: survivor.leaseId,
        instruction: "Still connected",
        observe_only: true,
      });
      assert.equal(r.observation, "Still connected");
      await until(() => survivor.stats.frames > before, "frames after another Host exited");
    }
    for (const a of count > 1 ? desktops.slice(1) : desktops) {
      await invoke(a.dir, "desktop_stream_stop", { leaseId: a.leaseId });
      await until(() => !a.status.subscribed, "released task");
      await sleep(lag * 2 + 100);
      const stopped = a.stats.frames,
        viewed = a.viewerFrames;
      await sleep(600);
      assert.equal(a.stats.frames, stopped, "video continued after stop");
      assert.ok(a.viewerFrames > viewed, "viewer stalled after cloud stop");
    }
  } finally {
    for (const dispose of cleanup.reverse()) await dispose();
  }
}
for (const args of [
  [12, 0, false],
  [24, 0, false],
  [24, bridgeDelay, false],
  [24, 0, true],
  [24, 0, true, 2],
]) {
  await benchmark(...args);
}
