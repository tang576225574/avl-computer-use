import test from "node:test";
import assert from "node:assert/strict";
import { desktopControls, parseFrame, FramePainter, pointOnScreen, keyAction, CommandChannel } from "../src/viewer.js";

function encode(seq, stream = "generation-a") {
  const header = new TextEncoder().encode(JSON.stringify({ stream, seq, width: 640, height: 480, capturedMs: 320.5 }));
  const bytes = new Uint8Array(4 + header.length + 4);
  new DataView(bytes.buffer).setUint32(0, header.length);
  bytes.set(header, 4);
  bytes.set([255, 216, 255, 217], 4 + header.length);
  return bytes.buffer;
}

test("decode validates lengths and exposes the JPEG without copying it", () => {
  const data = encode(123);
  const { header, jpeg } = parseFrame(data);
  assert.equal(header.seq, 123);
  assert.equal(jpeg.buffer, data);
  assert.deepEqual([...jpeg], [255, 216, 255, 217]);
  assert.throws(() => parseFrame(data.slice(0, 9)));
  const corrupt = encode(2);
  new Uint8Array(corrupt)[corrupt.byteLength - 1] = 0;
  assert.throws(() => parseFrame(corrupt));
});

test("an in-flight decode retains only the latest waiting frame, closes every bitmap", async () => {
  const decodes = [], shown = [], released = [];
  const painter = new FramePainter(() => new Promise(resolve => decodes.push(resolve)), (image, header) => shown.push(header.seq));
  painter.offer(parseFrame(encode(1)));
  painter.offer(parseFrame(encode(2)));
  painter.offer(parseFrame(encode(3)));
  decodes.shift()({close: () => released.push(1)});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(shown, [1]);
  assert.equal(decodes.length, 1);
  decodes.shift()({close: () => released.push(3)});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(shown, [1, 3]);
  assert.deepEqual(released, [1, 3]);
});

test("a disconnected canvas cannot be repainted by an earlier decode", async () => {
  let finish, shown = false, released = false;
  const painter = new FramePainter(() => new Promise(resolve => { finish = resolve; }), () => { shown = true; });
  painter.offer(parseFrame(encode(1)));
  painter.close();
  finish({close: () => { released = true; }});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shown, false);
  assert.equal(released, true);
});

test("normalize clicks on letterboxed and pillarboxed displays; ignore padding", () => {
  const frame = {width: 1920, height: 1080};
  const box = {left: 110, top: 50, width: 600, height: 900};
  assert.equal(pointOnScreen(box, frame, 110, 51), null);
  assert.deepEqual(pointOnScreen(box, frame, 410, 500), {x: 500,y: 500});
  assert.equal(pointOnScreen({left: 0,top: 0,width: 1000,height: 100},frame,3,50), null);
});

test("keys and shortcuts have distinct input semantics", () => {
  assert.deepEqual(keyAction({key:"Enter"}), {kind:"key",key:"Return"});
  assert.deepEqual(keyAction({key:"c",ctrlKey:true}), {kind:"key", key:"ctrl+c"});
  assert.deepEqual(keyAction({key:"好"}), {kind:"type",text:"好"});
  assert.equal(keyAction({key:"Control",ctrlKey:true}), null);
  assert.equal(keyAction({key:"Process",isComposing:true}), null);
});

test("close rejects pending commands, and a new link never replays input", async () => {
  const messages = [];
  const link = new CommandChannel(data => messages.push(data), 1000);
  const input = link.send({type:"act", action:{kind:"key",key:"Tab"}});
  link.close();
  await assert.rejects(input, /回执/);
  await assert.rejects(link.send({type:"act"}));
  const next = new CommandChannel(data => messages.push(data), 1000);
  assert.equal(messages.length, 1);
  const request = next.send({type:"take"});
  next.ack({id: messages[1].id,ok:true});
  await request;
  next.close();
});

test("takeover targets the displayed lease, including when the frame is stale", () => {
  const status = {control:"agent", holder:"workspace-a/agent", leaseId:"first", owner:false};
  const locked = desktopControls(status, false);
  assert.deepEqual(locked.take, {type:"take", leaseId:"first"});
  assert.equal(locked.canAct, false);
  assert.equal(locked.canResume, false);
  const next = desktopControls({...status, leaseId:"second"}, true);
  assert.deepEqual(next.take, {type:"take", leaseId:"second"});
  assert.deepEqual(locked.take, {type:"take", leaseId:"first"});
  assert.equal(next.canAct, false);

  const idle = desktopControls({...status, holder:null, leaseId:null}, false);
  assert.deepEqual(idle.take, {type:"take", leaseId:null});
});

test("only a granted viewer with a fresh frame can issue desktop input", () => {
  const human = {control:"human", owner:true, holder:null, leaseId:null};
  const active = desktopControls(human, true);
  assert.equal(active.canAct, true);
  assert.equal(active.take, null);
  assert.equal(active.canResume, true);
  const stale = desktopControls(human, false);
  assert.equal(stale.canAct, false);
  assert.equal(stale.canResume, true);

  for (const status of [
    null, {...human, owner:false}, {...human, control:"interrupting"},
    {control:"agent", holder:"unidentified lease"}, {control:"paused", owner:false, leaseId:null, controlError:"输入仍在执行"}
  ]) {
    const controls = desktopControls(status, true);
    assert.equal(controls.canAct, false);
    assert.equal(controls.take, null);
    assert.equal(controls.canResume, false);
  }
  const paused = desktopControls({control:"paused", leaseId:null, controlError:null}, false);
  assert.deepEqual(paused.take, {type:"take", leaseId:null});
  assert.equal(paused.canResume, true);
  assert.equal(paused.canAct, false);
});
