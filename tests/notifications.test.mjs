import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInterruptNotifications } from "../host/notifications.mjs";

test("retry after a failed checkpoint and restart delivers once to each recipient", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "avl-notice-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const histories = new Map([["root", []], ["child", []], ["unrelated", []]]);
  let failures = true;
  const warnings = [];
  const online = {
    id: "child",
    session: { snapshotEvents: () => histories.get("child") },
    inject(message) {
      histories.get("child").push({ type: "agent/inbox/spliced", data: { inserted: [message] } });
    },
  };
  const ctx = {
    logger: { warn: (...message) => warnings.push(message) },
    agents: { get: (id) => id === "child" ? online : undefined },
    sessions: { flush: async () => { if (failures) throw Error("checkpoint busy"); return true; } },
    sessionPersistence: {
      async open(id, mode) {
        assert.equal(mode, "write");
        if (failures) throw Error("writer busy");
        return {
          read: async () => ({ events: histories.get(id) }),
          append: async (events) => histories.get(id).push(...events),
          flush: async () => {},
          close: async () => {},
        };
      },
    },
  };
  const path = join(dir, "outbox.sqlite");
  const first = createInterruptNotifications(ctx, path);
  first.interrupt("child", "lease-1", "用户中断", "root");
  await first.close();
  assert.ok(warnings.length > 0);
  failures = false;
  const restarted = createInterruptNotifications(ctx, path);
  await restarted.close();
  for (const id of ["child", "root"]) {
    const events = histories.get(id);
    assert.equal(events.length, 1);
    assert.match(events[0].data.inserted[0].content[0].text, /用户中断/);
  }
  assert.deepEqual(histories.get("unrelated"), []);
});
