import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { createViewerSender } from "../avl_computer_use/backend/dsh.mjs";

test("a slow browser keeps the latest pending frame and all control messages in order", () => {
  const sent = [];
  const completions = [];
  const sender = createViewerSender({
    readyState: WebSocket.OPEN,
    send(data, { binary }, callback) {
      sent.push([data, binary]);
      completions.push(callback);
    },
  }, () => assert.fail("brief congestion must not close a viewer"));
  try {
    sender.offer("first frame", true);
    for (let n = 0; n < 50; n++) sender.offer("obsolete frame " + n, true);
    sender.offer("status", false);
    sender.offer("latest frame", true);
    sender.offer("ack", false);

    assert.deepEqual(sent, [["first frame", true]]);
    while (completions.length) completions.shift()();
    assert.deepEqual(sent, [
      ["first frame", true], ["status", false], ["ack", false], ["latest frame", true],
    ]);
  } finally {
    sender.stop();
  }
});

test("browser relay uses the configured write deadline", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = process.env.AVL_STREAM_WRITE_TIMEOUT_MS;
  process.env.AVL_STREAM_WRITE_TIMEOUT_MS = "2500";
  let closed = false;
  try {
    const sender = createViewerSender({ readyState: WebSocket.OPEN, send() {} }, () => { closed = true; });
    sender.offer("frame", true);
    t.mock.timers.tick(2499);
    assert.equal(closed, false);
    t.mock.timers.tick(1);
    assert.equal(closed, true);
    sender.stop();
  } finally {
    if (previous === undefined) delete process.env.AVL_STREAM_WRITE_TIMEOUT_MS;
    else process.env.AVL_STREAM_WRITE_TIMEOUT_MS = previous;
  }
});
