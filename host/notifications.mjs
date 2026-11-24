import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";

function interruptionMessage({ lease, holder, reason }, recipient) {
  const summary = "用户强制中断了 Agent 的桌面操作";
  const text = [
    reason,
    "被中断的 Agent 会话 ID 为 " + JSON.stringify(holder) + "。",
    "该桌面租约已失效。请停止这项桌面任务，等待用户指示。",
  ].join("\n");
  return {
    id: createHash("sha256").update(JSON.stringify([lease, recipient])).digest("hex"),
    role: "user",
    source: { kind: "avl-computer-use", form: "notice", summary },
    content: [{ type: "text", text }],
  };
}

function alreadyInserted(events, message) {
  return events.some(event => event.type === "agent/inbox/spliced" &&
    event.data.inserted.some(item => item.id === message.id));
}

async function deliver(ctx, recipient, message) {
  const agent = ctx.agents.get(recipient);
  if (agent) {
    if (!alreadyInserted(agent.session.snapshotEvents(), message)) agent.inject(message);
    if (!await ctx.sessions.flush(agent.session)) throw Error("No DSH durability checkpoint");
    return;
  }

  // The DSH writer excludes concurrent activation. Inserting at the front is
  // valid even when this cold session already has unclaimed next-step input.
  const writer = await ctx.sessionPersistence.open(recipient, "write");
  try {
    const { events } = await writer.read();
    if (!alreadyInserted(events, message)) {
      await writer.append([{
        type: "agent/inbox/spliced",
        seq: events.length,
        time: Date.now(),
        data: { target: "next-step", start: 0, inserted: [message] },
      }]);
    }
    await writer.flush();
  } finally {
    await writer.close();
  }
}

export function createInterruptNotifications(ctx, path = dshHomePath("avl", "interrupts.sqlite")) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS pending (
    lease TEXT PRIMARY KEY, holder TEXT NOT NULL, root TEXT NOT NULL, reason TEXT NOT NULL
  )`);
  const save = db.prepare("INSERT OR IGNORE INTO pending VALUES (?, ?, ?, ?)");
  const remove = db.prepare("DELETE FROM pending WHERE lease = ?");
  const pending = new Map();
  const running = new Map();
  let retry, closing;

  function send(notice) {
    const { lease, holder, root, reason } = notice;
    if (running.has(lease)) return;
    pending.set(lease, notice);
    // Persist both intended recipients together before reporting takeover.
    // Input handoff never waits for either recipient's model or checkpoint.
    const attempt = async () => {
      try {
        save.run(lease, holder, root, reason);
      } catch (error) {
        ctx.logger.warn("Could not journal desktop interruption for %s: %s", holder, String(error));
      }
      const recipients = [...new Set([holder, root])];
      const deliveries = await Promise.allSettled(recipients.map(id =>
        deliver(ctx, id, interruptionMessage(notice, id))));
      for (const [index, result] of deliveries.entries()) {
        if (result.status === "rejected") {
          ctx.logger.warn("Desktop interruption for %s pending retry: %s",
            recipients[index], String(result.reason));
        }
      }
      if (deliveries.every(result => result.status === "fulfilled")) {
        remove.run(lease);
        pending.delete(lease);
      }
    };
    running.set(lease, attempt().catch(error => {
      ctx.logger.warn("Desktop interruption for %s pending retry: %s", holder, String(error));
    }).finally(() => {
      running.delete(lease);
      if (!closing && !retry && pending.size) {
        retry = setTimeout(() => {
          retry = undefined;
          for (const notice of pending.values()) send(notice);
        }, 5000).unref();
      }
    }));
  }

  for (const notice of db.prepare("SELECT * FROM pending").all()) send(notice);
  return {
    interrupt(holder, lease, reason, root) {
      if (closing) throw Error("Desktop interruption journal is closing");
      send({ lease, holder, root, reason });
    },
    close() {
      clearTimeout(retry);
      return closing ??= Promise.all(running.values()).then(() => db.close());
    },
  };
}
