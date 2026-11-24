import test from "node:test";
import assert from "node:assert/strict";
import { Desktop } from "../host/desktop.mjs";
import { FrameStats } from "../host/metrics.mjs";
import { FrameSender } from "../host/transport.mjs";

function peer() {
  return {
    controls: [],
    frames: [],
    send(m) {
      this.controls.push(m);
    },
    frame(b) {
      this.frames.push(b);
    },
    discard() {},
  };
}
function fixture(options = {}) {
  const model = peer(),
    viewer = peer(),
    inputs = [];
  let now = 1000,
    run = false;
  const desktop = new Desktop({
    now: () => now,
    demand: (value) => {
      run = value;
    },
    input: async (action) => inputs.push(action),
    idleMs: 60000,
    ...options,
  });
  desktop.attachModel(model, "simulator");
  return {
    desktop,
    model,
    viewer,
    inputs,
    advance(ms) {
      now += ms;
    },
    running: () => run,
  };
}

test("viewer-only and model idle generate zero model frames; task starts/stops independently", async () => {
  const { desktop: d, model, viewer, running } = fixture();
  d.addViewer(viewer);
  d.publish(Buffer.from("jpeg"), 20, 10);
  assert.equal(model.frames.length, 0);
  assert.equal(viewer.frames.length, 1);
  const { leaseId } = await d.start("s1");
  d.publish(Buffer.from("jpeg"), 20, 10);
  assert.equal(model.frames.length, 1);
  await d.stop("s1", leaseId);
  assert.equal(running(), true);
  d.publish(Buffer.from("jpeg"), 20, 10);
  assert.equal(model.frames.length, 1);
  d.removeViewer(viewer);
  assert.equal(running(), false);
});

test("takeover cancels an active job; disconnect pauses; no stale model result can act", async () => {
  const { desktop: d, model, viewer, inputs } = fixture();
  d.addViewer(viewer);
  const { stream, leaseId } = await d.start("s");
  const pending = d.step("s", leaseId, "observe", true, new AbortController().signal);
  const { id } = model.controls.findLast((m) => m.type === "step");
  const rejected = assert.rejects(pending);
  await d.viewerCommand(viewer, { type: "take", id: "take", leaseId });
  await rejected;
  d.result({ id, stream, seq: 1, action: { kind: "click", x: 5, y: 5 } });
  assert.equal(d.status(viewer).owner, true);
  d.removeViewer(viewer);
  assert.equal(d.status().control, "paused");
  assert.equal(d.status().holder, null);
  assert.deepEqual(inputs, []);
});

test("idle video stops while the reasoning agent retains its lease until release", { timeout: 2000 }, async () => {
  const { desktop: d, advance, model } = fixture();
  const first = await d.start("first");
  const queued = d.start("second");
  advance(60001);
  await d.tick();
  assert.equal(d.status().subscribed, false);
  assert.equal(d.status().holder, "first");
  assert.equal(d.status().leaseId, first.leaseId);
  assert.equal(d.status().queueLength, 1);
  d.publish(Buffer.from("frame"), 100, 100);
  assert.equal(model.frames.length, 0);
  const signal = new AbortController().signal;
  await assert.rejects(d.step("first", first.leaseId, "click", false, signal));
  const observed = d.step("first", first.leaseId, "observe after reasoning", true, signal);
  const request = model.controls.findLast((m) => m.type === "step");
  assert.notEqual(request.stream, first.stream);
  d.publish(Buffer.from("frame"), 100, 100);
  const seq = d.seq;
  d.metrics.progress({ seq, received: seq, processed: seq, processedSeq: seq }, d.now());
  d.result({ id: request.id, stream: request.stream, seq, observation: "ready", action: null });
  assert.equal((await observed).observation, "ready");
  assert.equal(d.status().holder, "first");
  await d.stop("first", first.leaseId);
  const second = await queued;
  await d.stop("first", first.leaseId);
  assert.equal(d.status().leaseId, second.leaseId);
  assert.equal(d.status().subscribed, true);
});

test("cross-clock estimates and confirmed round trip are distinct, counts use receiver time", () => {
  const stats = new FrameStats();
  stats.reset(0);
  for (let seq = 1; seq <= 24; seq++) stats.capture(seq, seq * 40);
  stats.clock(0, 5005, 5006, 11);
  stats.progress(
    {
      seq: 24,
      received: 24,
      processed: 12,
      processedSeq: 20,
      sampled: 12,
      dropped: 12,
      samples: [{ seq: 20, receivedMs: 5810, processedMs: 5840 }],
    },
    855,
  );
  const m = stats.view(1000);
  assert.equal(m.rxP95, 10);
  assert.equal(m.processedP95, 40);
  assert.equal(m.ackP95, 55);
  assert.equal(m.processingP95, 30);
});

test("slow socket replaces queued JPEG without dropping ordered control messages", () => {
  const sent = [],
    callbacks = [];
  const s = new FrameSender(
    {
      readyState: 1,
      send(data, opts, cb) {
        sent.push(data);
        callbacks.push(cb);
      },
      terminate() {},
    },
    1000,
  );
  s.frame(Buffer.from("first"));
  s.frame(Buffer.from("old"));
  s.send({ type: "control" });
  s.frame(Buffer.from("new"));
  while (callbacks.length) callbacks.shift()();
  assert.deepEqual(sent.map(String), ["first", '{"type":"control"}', "new"]);
  s.close();
});

// The fake input acknowledges abort immediately but exits only when the test allows
// it. This makes the interval between interrupt and physical quiescence observable.
async function activeInput({ rootId = "a", ...options } = {}) {
  const started = Promise.withResolvers();
  const exited = Promise.withResolvers();
  const actions = [];
  const interrupts = [];
  const alerts = [];
  const f = fixture({
    input: async (action, _size, signal) => {
      actions.push(action);
      started.resolve(signal);
      await exited.promise;
    },
    onInterrupt: (...args) => interrupts.push(args),
    onAlert: (reason) => alerts.push(reason),
    ...options,
  });
  const d = f.desktop;
  d.addViewer(f.viewer);
  const { stream, leaseId } = await d.start("a", undefined, rootId);
  function step(observeOnly) {
    const pending = d.step("a", leaseId, "inspect desktop", observeOnly, new AbortController().signal);
    const id = f.model.controls.findLast((m) => m.type === "step").id;
    f.advance(40);
    d.publish(Buffer.from("frame"), 100, 100);
    const seq = d.seq;
    d.metrics.progress({ seq, received: seq, processed: seq, processedSeq: seq }, d.now());
    d.result({ stream, id, seq, observation: "ready", action: observeOnly ? null : { kind: "key", key: "Return" } });
    return pending;
  }
  await step(true);
  const rejected = assert.rejects(step(false), /未知/);
  const signal = await started.promise;
  return { ...f, signal, exited, rejected, leaseId, actions, interrupts, alerts };
}

test("stop waits for physical input to exit before granting the FIFO successor", { timeout: 2000 }, async () => {
  const { desktop: d, leaseId, signal, exited, rejected, model } = await activeInput();
  const next = d.start("b");
  const firstStop = d.stop("a", leaseId);
  const duplicateStop = Promise.allSettled([d.stop("a", leaseId)]);
  await new Promise(setImmediate);
  assert.equal(signal.aborted, true);
  assert.equal(d.status().control, "interrupting");
  assert.equal(model.controls.filter((m) => m.type === "start").length, 1);
  exited.resolve();
  const [, successor] = await Promise.all([firstStop, next, duplicateStop, rejected]);
  assert.equal(d.status().leaseId, successor.leaseId);
  assert.equal(d.status().holder, "b");
  assert.equal(d.status().needsObservation, true);
});

test("viewer disconnect during interrupt leaves desktop paused after input exits", { timeout: 2000 }, async () => {
  const { desktop: d, viewer, leaseId, signal, exited, rejected } = await activeInput();
  const take = Promise.allSettled([d.viewerCommand(viewer, { type: "take", leaseId })]);
  await new Promise(setImmediate);
  assert.equal(d.status(viewer).control, "interrupting");
  assert.equal(signal.aborted, true);
  d.removeViewer(viewer);
  const replacement = peer();
  d.addViewer(replacement);
  exited.resolve();
  await Promise.all([take, rejected]);
  assert.equal(d.status(replacement).control, "paused");
  assert.equal(d.status(replacement).owner, false);
});

test("stuck input produces a visible error and never hands control to a viewer", { timeout: 2000 }, async () => {
  const { desktop: d, viewer, leaseId, exited, rejected, alerts } = await activeInput({ drainMs: 10 });
  const take = d.viewerCommand(viewer, { type: "take", leaseId });
  await assert.rejects(take);
  assert.equal(d.status(viewer).control, "paused");
  assert.equal(d.status(viewer).owner, false);
  assert.ok(d.status().controlError);
  assert.ok(alerts.length > 0);
  await rejected;
  await assert.rejects(d.viewerCommand(viewer, { type: "resume" }));
  exited.resolve();
  await new Promise(setImmediate);
  assert.equal(d.status().control, "paused");
});

test("zero model FPS after a stall and no single-direction estimate for uncertain clocks", () => {
  const stats = new FrameStats();
  stats.reset(0);
  for (let seq = 1; seq <= 24; seq++) stats.capture(seq, seq * 40);
  stats.clock(0, 5100, 5100, 200);
  stats.progress(
    {
      seq: 24,
      received: 24,
      processed: 0,
      processedSeq: 0,
      samples: [{ seq: 24, receivedMs: 6060 }],
    },
    1170,
  );
  assert.equal(stats.view(1170).rxP95, null);
  assert.equal(stats.view(1170).ackP95, 210);
  assert.equal(stats.view(3470).rxFps, 0);
});

test("display replacement revokes a manual lease before new frames arrive", async () => {
  const { desktop: d, viewer } = fixture();
  d.addViewer(viewer);
  await d.viewerCommand(viewer, { type: "take", leaseId: null });
  await d.interrupted("display reset");
  d.publish(Buffer.from("new"), 640, 360);
  assert.equal(d.status(viewer).control, "paused");
  await assert.rejects(
    d.viewerCommand(viewer, {
      type: "act",
      stream: d.stream,
      seq: d.seq,
      action: { kind: "click", x: 50, y: 50 },
    }),
  );
});

test("a stalled writer closes only its own socket at the configured deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closed = 0;
  const slow = new FrameSender(
    {
      readyState: 1,
      send() {},
      terminate() {
        closed++;
      },
    },
    200,
  );
  const fast = [];
  const live = new FrameSender(
    {
      readyState: 1,
      send(data, _opts, done) {
        fast.push(data);
        done();
      },
      terminate() {
        throw Error("unexpected close");
      },
    },
    200,
  );
  slow.frame(Buffer.from("blocked"));
  t.mock.timers.tick(199);
  live.frame(Buffer.from("delivered"));
  assert.equal(closed, 0);
  t.mock.timers.tick(1);
  assert.equal(closed, 1);
  assert.equal(fast[0].toString(), "delivered");
  slow.close();
  live.close();
});

test("full model cannot issue input using a slow processed stream", async () => {
  let time = 100;
  const inputs = [],
    d = new Desktop({
      now: () => time,
      demand() {},
      input: async (action) => inputs.push(action),
    }),
    model = peer();
  d.attachModel(model, "full");
  const { stream, leaseId } = await d.start("s");
  for (const observeOnly of [true, false]) {
    const pending = d.step(
      "s",
      leaseId,
      "click the button",
      observeOnly,
      new AbortController().signal,
    );
    const id = model.controls.findLast((x) => x.type === "step").id;
    time += 1000;
    d.publish(Buffer.from("jpeg"), 100, 100);
    d.metrics.progress(
      { seq: d.seq, received: d.seq, processed: d.seq, processedSeq: d.seq },
      time,
    );
    d.result({
      stream,
      id,
      seq: d.seq,
      observation: "slow",
      action: { kind: "click", x: 50, y: 50 },
    });
    if (observeOnly) await pending;
    else await assert.rejects(pending, /12 fps/);
  }
  assert.deepEqual(inputs, []);
});

test("a higher processed sequence does not confirm skipped model frames", () => {
  const stats = new FrameStats();
  stats.reset(0);
  for (let seq=1; seq<=5; seq++) stats.capture(seq, seq*40);
  stats.progress({seq:5,received:5,processed:2,processedSeq:5,
    samples:[{seq:2,receivedMs:80,processedMs:100}]},220);
  assert.equal(stats.confirmed(2), true);
  assert.equal(stats.confirmed(3), false);
  assert.equal(stats.confirmed(5), true);
});

test("FIFO tickets deduplicate by agent and preserve independent caller cancellation", { timeout: 2000 }, async () => {
  const { desktop: d, model } = fixture();
  const a = await d.start("a");
  assert.equal((await d.start("a")).leaseId, a.leaseId);
  const first = new AbortController();
  const firstRequest = assert.rejects(d.start("b", first.signal));
  const c = new AbortController();
  const removed = assert.rejects(d.start("c", c.signal));
  const otherRequest = d.start("b");
  const next = d.start("d");
  assert.equal(d.status().queueLength, 3);
  first.abort();
  c.abort();
  await Promise.all([firstRequest, removed]);
  assert.equal(d.status().queueLength, 2);
  await d.stop("a", a.leaseId);
  const b = await otherRequest;
  assert.equal(d.status().holder, "b");
  assert.equal(d.status().queueLength, 1);
  assert.notEqual(b.leaseId, a.leaseId);
  await d.stop("b", b.leaseId);
  const last = await next;
  assert.equal(d.status().holder, "d");
  assert.equal(d.status().queueLength, 0);
  assert.equal(model.controls.filter((m) => m.type === "start").length, 3);
  await d.stop("d", last.leaseId);
  assert.equal(d.status().holder, null);
});

test("reacquiring cannot revive an old step, release, or takeover", async () => {
  const { desktop: d, viewer, model } = fixture();
  d.addViewer(viewer);
  const old = await d.start("a");
  await d.stop("a", old.leaseId);
  const active = await d.start("a");
  assert.notEqual(old.leaseId, active.leaseId);
  await assert.rejects(d.step("a", old.leaseId, "stale request", true, new AbortController().signal));
  for (const leaseId of [old.leaseId, null, undefined]) {
    await assert.rejects(d.viewerCommand(viewer, { type: "take", leaseId }));
  }
  await assert.rejects(d.stop("b", active.leaseId));
  await d.stop("a", old.leaseId);
  assert.equal(d.status().leaseId, active.leaseId);
  assert.equal(model.controls.filter((m) => m.type === "step").length, 0);
});

test("ending a queued session removes it before the next grant", { timeout: 2000 }, async () => {
  const { desktop: d } = fixture();
  await d.start("a");
  const disposed = assert.rejects(d.start("b"));
  const c = d.start("c");
  await d.endSession("b", "disposed");
  await disposed;
  assert.equal(d.status().queueLength, 1);
  await d.endSession("a", "disposed");
  assert.equal((await c).leaseId, d.status().leaseId);
  assert.equal(d.status().holder, "c");
});

test("model reconnect serves the queued agent using a fresh lease", { timeout: 2000 }, async () => {
  const { desktop: d, model } = fixture();
  const a = await d.start("a");
  const b = d.start("b");
  await d.detachModel(model);
  assert.equal(d.status().subscribed, false);
  assert.equal(d.status().queueLength, 1);
  const replacement = peer();
  d.attachModel(replacement, "simulator");
  const successor = await b;
  assert.notEqual(successor.leaseId, a.leaseId);
  assert.equal(d.status().holder, "b");
  assert.deepEqual(replacement.controls.filter((m) => m.type === "start").map((m) => m.stream), [successor.stream]);
});

test("host close revokes the lease and rejects every queued request", { timeout: 2000 }, async () => {
  const { desktop: d, viewer } = fixture();
  d.addViewer(viewer);
  await d.start("a");
  const pending = ["b", "c"].map((id) => assert.rejects(d.start(id)));
  await d.close("host stopped");
  await Promise.all(pending);
  assert.equal(d.status().subscribed, false);
  assert.equal(d.status().holder, null);
  assert.equal(d.status().queueLength, 0);
  await assert.rejects(d.viewerCommand(viewer, { type: "take", leaseId: null }));
});

test("repeated takeover interrupts only once and pending agents wait for explicit resume", { timeout: 2000 }, async () => {
  const { desktop: d, viewer, leaseId, exited, rejected, interrupts, model } = await activeInput();
  const b = d.start("b");
  const take = d.viewerCommand(viewer, { type: "take", leaseId });
  const retry = d.viewerCommand(viewer, { type: "take", leaseId });
  const release = d.stop("a", leaseId);
  const anotherViewer = peer();
  d.addViewer(anotherViewer);
  await new Promise(setImmediate);
  assert.equal(d.status(viewer).owner, false);
  assert.equal(d.status().holder, "a");
  assert.equal(d.status().subscribed, false);
  await assert.rejects(d.viewerCommand(anotherViewer, { type: "take", leaseId }));
  await assert.rejects(d.viewerCommand(viewer, { type: "resume" }));
  await assert.rejects(d.viewerCommand(viewer, {
    type: "act", stream: d.stream, seq: d.seq, action: { kind: "key", key: "Return" },
  }));
  assert.equal(model.controls.filter((m) => m.type === "stop").length, 1);
  assert.equal(model.controls.filter((m) => m.type === "start").length, 1);
  exited.resolve();
  await Promise.all([take, retry, release, rejected]);
  assert.equal(d.status(viewer).control, "human");
  assert.equal(d.status(viewer).owner, true);
  assert.equal(d.status(viewer).holder, null);
  assert.equal(d.status(viewer).queueLength, 1);
  assert.deepEqual(interrupts.map(([agent, id]) => [agent, id]), [["a", leaseId]]);
  assert.equal(model.controls.filter((m) => m.type === "start").length, 1);
  await d.viewerCommand(viewer, { type: "resume" });
  const successor = await b;
  assert.equal(d.status().leaseId, successor.leaseId);
  assert.equal(d.status().holder, "b");
});

test("takeover between steps tells the holder once even when the viewer retries", async () => {
  const notices = [];
  const { desktop: d, viewer } = fixture({ onInterrupt: (...notice) => notices.push(notice) });
  d.addViewer(viewer);
  const { leaseId } = await d.start("a");
  await d.viewerCommand(viewer, { type: "take", leaseId });
  await d.viewerCommand(viewer, { type: "take", leaseId });
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].slice(0, 2), ["a", leaseId]);
  assert.match(notices[0][2], /用户强行中断了桌面插件调用/);
});

test("a late model reply cannot complete the next lease's observation", { timeout: 2000 }, async () => {
  const { desktop: d, model, inputs } = fixture();
  const signal = new AbortController().signal;
  const first = await d.start("a");
  const cancelled = assert.rejects(d.step("a", first.leaseId, "first request", true, signal));
  const old = model.controls.at(-1);
  await d.stop("a", first.leaseId);
  await cancelled;
  const second = await d.start("a");
  const next = d.step("a", second.leaseId, "second request", true, signal);
  const fresh = model.controls.at(-1);
  d.publish(Buffer.from("frame"), 32, 32);
  const seq = d.seq;
  d.metrics.progress({ seq, received: seq, processed: seq, processedSeq: seq }, d.now());
  const result = { seq, observation: "obsolete", action: { kind: "click", x: 5, y: 5 } };
  d.result({ ...result, stream: old.stream, id: old.id });
  d.result({ ...result, stream: old.stream, id: fresh.id });
  d.result({ ...result, stream: fresh.stream, id: old.id });
  d.result({ ...result, stream: fresh.stream, id: fresh.id, observation: "fresh", action: null });
  assert.equal((await next).observation, "fresh");
  assert.deepEqual(inputs, []);
});

test("service repair honors lease ownership and drains before human takeover", { timeout: 2000 }, async () => {
  const { desktop: d, viewer } = fixture();
  d.addViewer(viewer);
  const { leaseId } = await d.start("a");
  let repairs = 0;
  const exit = Promise.withResolvers();
  const repair = () => { repairs++; return exit.promise; };
  await assert.rejects(d.recover("b", leaseId, repair));
  await assert.rejects(d.recover("a", "obsolete", repair));
  const running = d.recover("a", leaseId, repair);
  await assert.rejects(d.recover("a", leaseId, repair));
  await assert.rejects(d.step("a", leaseId, "observe", true, new AbortController().signal));
  const take = d.viewerCommand(viewer, { type: "take", leaseId });
  assert.equal(d.status(viewer).control, "interrupting");
  assert.equal(d.status(viewer).owner, false);
  exit.resolve();
  await Promise.all([running, take]);
  assert.equal(d.status(viewer).owner, true);
  await assert.rejects(d.recover("a", null, repair));
  assert.equal(repairs, 1);
});

test("takeover during a disposed agent's input drain retains its original root recipient", { timeout: 2000 }, async () => {
  const { desktop: d, viewer, leaseId, exited, rejected, interrupts } = await activeInput({ rootId: "original-root" });
  d.endSession("a", "agent disposed");
  assert.equal(d.status().control, "interrupting");
  await assert.rejects(d.start("a", undefined, "new-root"));
  const take = d.viewerCommand(viewer, { type: "take", leaseId });
  exited.resolve();
  await Promise.all([take, rejected]);
  assert.equal(interrupts.length, 1);
  const [holder, id, reason, root] = interrupts[0];
  assert.deepEqual([holder, id, root], ["a", leaseId, "original-root"]);
  assert.match(reason, /用户强行中断/);
  await d.viewerCommand(viewer, { type: "resume" });
  assert.notEqual((await d.start("a", undefined, "new-root")).leaseId, leaseId);
});

test("host shutdown remains pending after the drain deadline until input exits", { timeout: 2000 }, async () => {
  const alert = Promise.withResolvers();
  const { desktop: d, leaseId, viewer, rejected, exited } = await activeInput({ drainMs: 10, onAlert: alert.resolve });
  let closed = false;
  const shutdown = d.close("shutting down").then(() => { closed = true; });
  await Promise.all([alert.promise, rejected]);
  await new Promise(setImmediate);
  assert.equal(d.status().control, "paused");
  assert.equal(closed, false);
  await assert.rejects(d.viewerCommand(viewer, { type: "take", leaseId }));
  exited.resolve();
  await shutdown;
  assert.equal(closed, true);
});

test("hidden owner retains exclusive control while video demand is independent", async () => {
  const {desktop:d, viewer:a, model, running, inputs} = fixture();
  const b = peer();
  d.addViewer(a, false);
  assert.equal(running(), false);
  const watch = (peer, enabled) => d.viewerCommand(peer, {type:"watch",enabled});
  const frame = () => d.publish(Buffer.from("jpeg"), 20, 10);
  const click = (peer, seq) => d.viewerCommand(peer, {type:"act", stream:d.stream, seq, action:{kind:"click",x:20,y:20}});
  await watch(a, true);
  d.addViewer(b);
  frame();
  assert.strictEqual(a.frames[0], b.frames[0]);
  await d.viewerCommand(a, {type:"take",leaseId:null});
  const next = d.start("queued");
  await watch(a, false);
  assert.equal(d.status(a).owner, true);
  assert.equal(d.status().queueLength, 1);
  frame();
  assert.equal(a.frames.length, 1);
  assert.equal(b.frames.length, 2);
  await assert.rejects(click(a, d.seq));
  await assert.rejects(click(b, d.seq));
  await assert.rejects(d.viewerCommand(b, {type:"take",leaseId:null}));
  d.removeViewer(b);
  assert.equal(running(), false);
  const prev = d.seq;
  await watch(a, true);
  await assert.rejects(click(a, prev));
  frame();
  await click(a, d.seq);
  assert.equal(inputs.length, 1);
  await watch(a, false);
  d.removeViewer(a);
  assert.equal(d.status().control, "paused");
  d.addViewer(b);
  await d.viewerCommand(b, {type:"resume"});
  assert.ok((await next).leaseId);
  await watch(b,false);
  assert.equal(running(),true);
  frame();
  assert.equal(model.frames.length,1);
});
