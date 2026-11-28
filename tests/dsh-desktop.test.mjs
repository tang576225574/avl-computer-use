import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Agents from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import FsLocal from "@deepseek-ai/dsh-fs-local";
import LlmRuntime, { LlmAdapter } from "@deepseek-ai/dsh-llm";
import Sessions from "@deepseek-ai/dsh-session";
import * as Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import Projections from "@deepseek-ai/dsh-session-projection";
import Subagents from "@deepseek-ai/dsh-subagent";
import * as Spawn from "@deepseek-ai/dsh-subagent-spawn-in-process";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as NativeTools from "@deepseek-ai/dsh-tool-executor-native";
import Tools from "@deepseek-ai/dsh-tools";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";
import { Desktop } from "../host/desktop.mjs";
import { createInterruptNotifications } from "../host/notifications.mjs";
import { registerDesktopTools } from "../host/plugin.mjs";

for (const trigger of ["human", "disconnect"])
test(`desktop interruption (${trigger}) reaches the real DSH child and owning root between calls; DSH lifecycle releases leases`, { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "avl-dsh-lease-"));
  const ctx = new Context();
  const notices = createInterruptNotifications(ctx, join(dir, "interrupts.sqlite"));
  t.after(async () => {
    try { await notices.close(); } finally {
      await ctx.fiber.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
  for (const plugin of [LlmRuntime, Sessions, Projections, SystemPrompt, FsLocal,
    WorkingDirectory, Tools, NativeTools, Agents]) await ctx.plugin(plugin);
  await ctx.plugin(Persistence, { root: join(dir, "sessions") });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Subagents);
  await ctx.plugin(Spawn);

  // Hold the child at a real model request boundary while the human takes control.
  const entered = Promise.withResolvers();
  class PausedModel extends LlmAdapter {
    async *stream({ signal }) {
      entered.resolve();
      signal.throwIfAborted();
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      signal.throwIfAborted();
    }
  }
  ctx.llm.registerAdapter(["desktop-test"], new PausedModel());
  const desktop = new Desktop({ demand() {}, input: async () => {}, onInterrupt: notices.interrupt });
  registerDesktopTools(ctx, desktop, { snapshot: () => ({}) });
  const peer = { send() {}, discard() {} };
  desktop.attachModel(peer, "benchmark");
  desktop.addViewer(peer);
  const options = { meta: { cwd: dir }, agentOptions: { provider: "desktop-test", model: "fixture" } };
  const unrelated = await ctx.agents.create({ ...options, sessionId: "unrelated" });
  // The ordinary fork's ancestor is not part of this subagent tree.
  const root = await ctx.agents.create({ ...options, meta: { cwd: dir, parentSession: "unrelated" }, sessionId: "root" });
  const signal = AbortSignal.timeout(10000);
  const activation = await ctx.subagents.startActivation({
    parent: root.agent, provider: "spawn", childId: "child", name: "worker", label: "test",
    prompt: [{ type: "text", text: "Hold for the takeover test" }], delivery: "caller", signal,
  });
  const child = ctx.agents.get(activation.childId);
  await entered.promise;
  const start = agent => ctx.tools.get("desktop_stream_start", agent)
    .execute({}, { agent, signal }).then(JSON.parse);
  const first = await start(child);
  if (trigger === "human") await desktop.viewerCommand(peer, { type: "take", leaseId: first.leaseId });
  else desktop.detachModel(peer);
  const noticesOf = agent => agent.inbox.nextStep.filter(msg => msg.source.kind === "avl-computer-use");
  for (const agent of [child, root.agent]) {
    assert.equal(noticesOf(agent).length, 1);
    assert.match(noticesOf(agent)[0].content[0].text, trigger === "human" ? /用户强行中断/ : /视觉模型已断线/);
    assert.match(noticesOf(agent)[0].content[0].text, /child/);
  }
  assert.deepEqual(noticesOf(unrelated.agent), []);
  if (trigger === "disconnect") desktop.attachModel(peer, "benchmark");
  const waiting = start(child);
  if (trigger === "human") await desktop.viewerCommand(peer, { type: "resume" });
  const next = await waiting;
  assert.notEqual(next.leaseId, first.leaseId);
  const rootWaiting = start(root.agent);
  child.cancel({ kind: "user" }, { keepInbox: true });
  await child.whenIdle();
  assert.equal((await rootWaiting).leaseId, desktop.lease.id);
  await activation.dispose();
  const nextWaiting = start(unrelated.agent);
  await root.dispose();
  assert.equal((await nextWaiting).leaseId, desktop.lease.id);
  assert.equal(desktop.task, unrelated.agent.id);
  // A cold recipient receives durable pending input without starting a model turn.
  notices.interrupt("root", "offline-replay-test", "用户强行中断", "root");
  // Wait for this delivery's durability barrier before starting a competing writer.
  await notices.close();
  const restored = await ctx.agents.resume({ resumeSessionId: "root" });
  assert.equal(noticesOf(restored.agent).length, 1);
  const inserted = restored.agent.session.snapshotEvents()
    .filter(event => event.type === "agent/inbox/spliced")
    .flatMap(event => event.data.inserted);
  assert.equal(inserted.length, 2);
  assert.match(inserted[0].content[0].text, /child/);
  assert.equal(inserted[1].id, noticesOf(restored.agent)[0].id);
  assert.equal(restored.agent.status, "idle");
});
