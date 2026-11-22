import assert from "node:assert/strict";
import test from "node:test";
import { DesktopSupervision, OpsSsh, createHealthResponse } from "../avl_computer_use/backend/desktop-supervision.mjs";

const healthy = { x11: true, xfce: true, novnc: true, backend: true };

function fixture() {
  const repairs = [];
  const state = { components: { ...healthy }, ssh: "ready", workspace: "ready", now: 0 };
  const watcher = new DesktopSupervision({
    openOps: () => ({
      probe: async () => ({ ssh: state.ssh, components: state.components }),
      repair: async component => { repairs.push(component); return true; },
      close() {},
    }),
    workspace: async () => state.workspace,
    clock: () => state.now,
  });
  return {
    watcher, state, repairs,
    async tick(seconds = 5) {
      state.now += seconds * 1000;
      await watcher.check();
      return watcher.snapshot;
    },
  };
}

test("X11 failure consumes only the X11 repair budget until the display is back", async () => {
  const { state, repairs, tick } = fixture();
  assert.equal((await tick()).state, "healthy");
  state.components = { x11: false, xfce: false, novnc: false, backend: false };
  assert.equal((await tick()).state, "degraded");
  assert.equal((await tick()).state, "recovering");
  assert.deepEqual(repairs, ["x11"]);
  state.components = { ...healthy, backend: false };
  assert.equal((await tick()).state, "degraded");
  await tick();
  assert.deepEqual(repairs, ["x11", "backend"]);
  state.components = healthy;
  assert.equal((await tick()).state, "healthy");
});

test("repairs are bounded and a recovered component can fail independently later", async () => {
  const { state, repairs, tick } = fixture();
  state.components.backend = false;
  await tick();
  await tick();
  await tick();
  await tick(15);
  assert.equal((await tick(15)).state, "failed");
  await tick(100);
  assert.deepEqual(repairs, ["backend", "backend", "backend"]);
  state.components.backend = true;
  await tick();
  state.components.backend = false;
  await tick();
  await tick();
  assert.equal(repairs.length, 4);
});

test("helper loss pauses operations, closes the session and checks fresh on return", async () => {
  let workspace = "unavailable";
  const events = [];
  const watcher = new DesktopSupervision({
    workspace: async () => workspace,
    openOps: () => {
      events.push("open");
      return {
        probe: async () => { events.push("probe"); return { ssh: "ready", components: { ...healthy, backend: false } }; },
        repair: async () => { events.push("repair"); return true; },
        close: async () => { events.push("close"); },
      };
    },
  });
  await watcher.check();
  assert.equal(watcher.snapshot.state, "workspace_offline");
  assert.deepEqual(events, []);
  workspace = "ready";
  await watcher.check();
  workspace = "unavailable";
  await watcher.check();
  await watcher.check();
  assert.deepEqual(events, ["open", "probe", "close"]);
  workspace = "ready";
  await watcher.check();
  assert.equal(watcher.snapshot.state, "degraded");
  assert.deepEqual(events, ["open", "probe", "close", "open", "probe"]);
});

test("a helper lost during the second probe prevents the pending repair", async () => {
  const { state, watcher, repairs, tick } = fixture();
  state.components.backend = false;
  await tick();
  const probe = watcher.ops.probe;
  watcher.ops.probe = async () => {
    const result = await probe();
    state.workspace = "unavailable";
    return result;
  };
  await tick();
  assert.equal(watcher.snapshot.state, "workspace_offline");
  assert.deepEqual(repairs, []);
});

test("disconnect during a repair publishes the warning before the old repair completes", async () => {
  let workspace = "ready";
  const started = Promise.withResolvers();
  const pending = Promise.withResolvers();
  const watcher = new DesktopSupervision({
    workspace: async () => workspace,
    openOps: () => ({
      probe: async () => ({ ssh: "ready", components: { ...healthy, backend: false } }),
      repair() { started.resolve(); return pending.promise; },
      close() {},
    }),
  });
  await watcher.check();
  const repair = watcher.check();
  await started.promise;
  workspace = "unavailable";
  await watcher.check();
  assert.equal(watcher.snapshot.state, "workspace_offline");
  pending.resolve(true);
  await repair;
  assert.equal(watcher.snapshot.state, "workspace_offline");
});

test("remote probe errors are distinguished from SSH transport loss", async () => {
  const ssh = new OpsSsh("avl-ops", {
    command: async (_file, args) => {
      assert.deepEqual(args.slice(-2), ["avl-ops", "probe"]);
      if (args.includes("-S")) throw Object.assign(new Error("transport"), { code: 255 });
      return { stdout: JSON.stringify(healthy) };
    },
  });
  try {
    assert.deepEqual(await ssh.probe(), { ssh: "unreachable" });
  } finally {
    await ssh.close();
  }
  const invalid = new OpsSsh("avl-ops", { command: async () => ({ stdout: "{}" }) });
  try {
    assert.deepEqual(await invalid.probe(), { ssh: "probe_failed" });
  } finally {
    await invalid.close();
  }
});

test("only the DSH owner can read the health snapshot", async () => {
  const snapshot = { state: "failed", components: { backend: "failed" } };
  assert.equal(createHealthResponse(snapshot, undefined).status, 403);
  assert.equal(createHealthResponse(snapshot, { principal: { kind: "guest" }, signal: new AbortController().signal }).status, 403);
  const response = createHealthResponse(snapshot, { principal: { kind: "owner" }, signal: new AbortController().signal });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), snapshot);
});

test("the plugin serves the host snapshot without contacting the desktop endpoint", async () => {
  const { apply } = await import("../avl_computer_use/backend/dsh.mjs");
  const keys = ["AVL_DESKTOP_URL", "AVL_DESKTOP_TOKEN", "AVL_OPS_SSH_HOST", "AVL_WORKSPACE", "AVL_SSH_HOST"];
  const prior = keys.map(key => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  process.env.AVL_DESKTOP_URL = "http://127.0.0.1:1";
  process.env.AVL_DESKTOP_TOKEN = "test-token";
  const routes = [];
  const cleanup = [];
  try {
    await apply({
      effect: callback => cleanup.push(callback()),
      inject() {},
      webServer: {
        register: route => { routes.push(route); return () => {}; },
        registerUpgrade: () => () => {},
      },
      tools: { register: () => () => {} },
    });
    const route = routes.find(route => route.path === "/avl-desktop/health");
    assert.ok(route);
    const request = new Request("http://127.0.0.1/avl-desktop/health");
    const peer = { principal: { kind: "owner" }, signal: new AbortController().signal };
    const response = await route.resource(request, peer);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "disabled");
  } finally {
    cleanup.reverse().forEach(stop => stop?.());
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("sudo credentials go over SSH stdin with only the fixed operation in argv", async () => {
  const calls = [];
  const writes = [];
  const password = "special $characters and 'quotes'";
  const ssh = new OpsSsh("avl-ops", {
    sudoPassword: password,
    command: (_file, argv) => {
      calls.push(argv);
      const pending = Promise.resolve({ stdout: JSON.stringify(healthy) });
      pending.child = { stdin: { on() {}, end(data) { writes.push(data); } } };
      return pending;
    },
  });
  try {
    assert.equal((await ssh.probe()).ssh, "ready");
    assert.equal(await ssh.repair("backend"), true);
    assert.deepEqual(writes, [password + "\n", password + "\n"]);
    assert.ok(calls.every(argv => !argv.join(" ").includes(password)));
    assert.match(calls[0].at(-1), /\/opt\/avl\/desktop\/privileged-ops\.sh probe$/);
    assert.match(calls[1].at(-1), /\/opt\/avl\/desktop\/privileged-ops\.sh recover backend$/);
  } finally {
    await ssh.close();
  }
});
