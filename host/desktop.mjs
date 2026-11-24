import { randomUUID } from "node:crypto";
import { FrameStats } from "./metrics.mjs";
import { encodeFrame } from "./transport.mjs";

import { AgentQueue } from "./agent-queue.mjs";

const forcedInterrupt = "用户强行中断了桌面插件调用";
const changedOwner = "原任务已结束，桌面持有者已变化，请查看当前状态";

export class Desktop {
  constructor({
    demand,
    input,
    now = () => performance.now(),
    idleMs = 60000,
    freshMs = 5000,
    decisionMs = 30000,
    drainMs = 2500,
    onInterrupt = () => {},
    onAlert = () => {},
  }) {
    Object.assign(this, {
      demand,
      input,
      now,
      idleMs,
      freshMs,
      decisionMs,
      drainMs,
      onInterrupt,
      onAlert,
    });
    this.queue = new AgentQueue();
    this.control = "agent";
    this.viewers = new Set();
    this.videoSubscribers = new Map();
    this.metrics = new FrameStats();
    this.needsObservation = true;
    this.rotate();
  }
  rotate() {
    this.stream = randomUUID();
    this.seq = 0;
    this.metrics.reset(this.now());
    for (const viewer of this.viewers) viewer.discard();
  }
  addViewer(peer, watching = true) {
    this.viewers.add(peer);
    this.setWatching(peer, watching);
  }
  setWatching(peer, enabled) {
    if (typeof enabled !== "boolean") throw Error("无效的视频订阅状态");
    if (enabled === this.videoSubscribers.has(peer)) return;
    if (enabled) {
      this.videoSubscribers.set(peer, { stream: this.stream, afterSeq: this.seq });
    } else {
      this.videoSubscribers.delete(peer);
      peer.discard();
    }
    this.updateDemand();
  }
  removeViewer(peer) {
    this.viewers.delete(peer);
    this.videoSubscribers.delete(peer);
    if (this.transfer?.peer === peer) {
      this.transfer.target = "paused";
      this.transfer.peer = null;
    } else if (this.owner === peer) {
      this.beginTransfer("paused", null, "接管者已断线");
    }
    this.updateDemand();
  }
  // Closing leases remain identifiable for stop retries. An idle lease can outlive its video stream.
  get task() {
    return this.control === "agent" ? this.lease?.agentId : null;
  }
  get streaming() {
    return Boolean(this.task && !this.lease.idle);
  }
  updateDemand() {
    this.demand(Boolean(this.streaming || this.videoSubscribers.size));
  }
  attachModel(peer, mode) {
    if (
      this.closed ||
      this.model ||
      !["full", "simulator", "benchmark"].includes(mode)
    )
      throw Error("Model unavailable or unsupported");
    this.model = peer;
    this.mode = mode;
    this.admitNext();
  }
  detachModel(peer) {
    if (this.model !== peer) return;
    this.model = null;
    this.mode = null;
    if (this.task) this.beginTransfer("agent", null, "视觉模型已断线");
  }
  async start(agentId, signal, rootId = agentId) {
    signal?.throwIfAborted();
    if (!agentId || this.closed || !this.model)
      throw Error("需要已连接的模型和有效的 Agent");
    if (this.transfer && this.lease?.agentId === agentId)
      throw Error("当前任务正在释放桌面");
    if (this.task === agentId) {
      this.lastUse = this.now();
      return this.grantInfo();
    }
    const request = this.queue.join(agentId, rootId, signal);
    this.admitNext();
    return request;
  }
  grantInfo() {
    return {
      leaseId: this.lease.id,
      stream: this.stream,
      mode: this.mode,
      needsObservation: this.needsObservation,
    };
  }
  admitNext() {
    if (
      this.closed ||
      this.control !== "agent" ||
      this.lease ||
      this.transfer ||
      this.maintenance ||
      !this.model
    )
      return;
    this.queue.grantNext((agentId, rootId) => {
      this.rotate();
      this.lease = { id: randomUUID(), agentId, rootId, stream: this.stream };
      this.needsObservation = true;
      this.lastUse = this.now();
      this.model.send({ type: "start", stream: this.stream });
      this.updateDemand();
      return this.grantInfo();
    });
  }
  async stop(agentId, leaseId) {
    if (typeof leaseId !== "string" || !leaseId)
      throw Error("释放桌面必须携带 leaseId");
    if (this.lease?.id !== leaseId)
      return { leaseId, subscribed: false, state: "released" };
    if (this.lease.agentId !== agentId) throw Error("桌面任务属于另一 Agent");
    const transfer =
      this.transfer ?? this.beginTransfer("agent", null, "桌面任务已结束");
    await transfer.done.promise;
    return {
      leaseId,
      subscribed: false,
      state: transfer.timedOut ? "paused" : "released",
    };
  }
  endSession(agentId, reason) {
    this.queue.cancel(agentId, reason);
    if (this.task === agentId) this.beginTransfer("agent", null, reason);
  }
  async close(reason) {
    this.closed = true;
    this.queue.close(reason);
    if (this.transfer) {
      this.transfer.target = "paused";
      this.transfer.peer = null;
    } else {
      this.beginTransfer("paused", null, reason);
    }
    // Plugin disposal must not allow a replacement instance to outlive the physical input guard.
    await (this.inputBusy ?? this.maintenance)?.catch(() => {});
  }
  interrupted(reason) {
    this.captureError = reason;
    this.rotate();
    if (this.transfer) {
      if (this.transfer.target === "human") {
        this.transfer.target = "paused";
        this.transfer.peer = null;
      }
    } else if (this.task || this.control === "human") {
      this.beginTransfer(this.task ? "agent" : "paused", null, reason);
    }
    this.needsObservation = true;
  }
  notifyInterrupt(transfer) {
    if (transfer.notified || !this.lease) return;
    transfer.notified = true;
    const reason = (transfer.reason =
      forcedInterrupt +
      (this.inputBusy
        ? "，在途输入的执行结果未知，请重新观察。"
        : "，请在重新获准后观察桌面。"));
    try {
      Promise.resolve(
        this.onInterrupt(
          this.lease.agentId,
          this.lease.id,
          reason,
          this.lease.rootId,
        ),
      ).catch((error) => this.onAlert("中断通知投递失败：" + error.message));
    } catch (error) {
      this.onAlert("中断通知投递失败：" + error.message);
    }
  }
  beginTransfer(target, peer, reason) {
    const transfer = { target, peer, reason, done: Promise.withResolvers() };
    this.transfer = transfer;
    this.control = "interrupting";
    this.owner = null;
    this.manualFrom = null;
    this.needsObservation = true;
    this.inputController?.abort();
    if (target === "human" && this.lease) this.notifyInterrupt(transfer);
    this.cancel(transfer.reason);
    if (this.lease && !this.lease.idle) {
      this.model?.discard();
      this.model?.send({ type: "stop", stream: this.lease.stream });
    }
    this.updateDemand();
    // inputBusy only settles after the child emits close, including abort/kill failures.
    const pending = this.inputBusy ?? this.maintenance;
    if (!pending) this.finishTransfer(transfer);
    else {
      transfer.timer = setTimeout(() => {
        transfer.timedOut = true;
        transfer.target = this.control = "paused";
        transfer.peer = null;
        this.controlError = "无法确认在途桌面操作已停止，输入暂停";
        this.onAlert(this.controlError);
        transfer.done.resolve();
      }, this.drainMs);
      pending.then(
        () => this.finishTransfer(transfer),
        () => this.finishTransfer(transfer),
      );
    }
    return transfer;
  }
  finishTransfer(transfer) {
    clearTimeout(transfer.timer);
    this.transfer = null;
    this.controlError = null;
    this.control = transfer.target;
    if (this.control === "human") {
      this.owner = transfer.peer;
      this.manualFrom = this.lease?.id ?? null;
    }
    this.lease = null;
    this.admitNext();
    this.updateDemand();
    transfer.done.resolve();
  }
  async recover(agentId, leaseId, recover) {
    if (
      this.closed ||
      this.control !== "agent" ||
      this.transfer ||
      this.inputBusy ||
      this.job ||
      this.maintenance ||
      (this.lease
        ? this.task !== agentId || this.lease.id !== leaseId
        : leaseId != null || this.queue.size)
    )
      throw Error("当前桌面控制权不允许恢复操作");
    return this.runRepair(recover);
  }
  tryAutoRepair(repair) {
    if (
      this.closed ||
      this.transfer ||
      this.controlError ||
      this.inputBusy ||
      this.job ||
      this.maintenance
    )
      return false;
    return this.runRepair(repair);
  }
  async runRepair(recover) {
    const pending = Promise.resolve().then(recover);
    this.maintenance = pending;
    try {
      return await pending;
    } finally {
      this.maintenance = null;
      this.admitNext();
    }
  }
  publish(jpeg, width, height) {
    if (!this.streaming && !this.videoSubscribers.size) return;
    this.captureError = null;
    const capturedMs = this.now();
    const header = {
      stream: this.stream,
      seq: ++this.seq,
      capturedMs,
      width,
      height,
    };
    this.size = { width, height };
    this.metrics.capture(this.seq, capturedMs);
    const packet = encodeFrame(header, jpeg);
    for (const viewer of this.videoSubscribers.keys()) viewer.frame(packet);
    if (this.streaming) this.model.frame(packet);
  }
  validFrame(stream, seq, maxAge = this.freshMs) {
    const time = this.metrics.frames.get(seq);
    return (
      stream === this.stream &&
      time !== undefined &&
      this.now() - time <= maxAge
    );
  }
  async step(session, leaseId, instruction, observeOnly, signal) {
    signal.throwIfAborted();
    if (!this.task || this.task !== session || this.lease.id !== leaseId)
      throw Error("请先开启本会话的桌面视频订阅");
    if (this.job || this.inputBusy || this.maintenance)
      throw Error("已有桌面操作正在执行");
    if (this.mode === "benchmark") throw Error("链路测试接收器不提供视觉决策");
    if (
      typeof instruction !== "string" ||
      !instruction.trim() ||
      instruction.length > 8000
    )
      throw Error("无效桌面指令");
    if (!observeOnly && this.needsObservation)
      throw Error("请先执行一次只观察操作");
    if (this.lease.idle) {
      this.rotate();
      this.lease.stream = this.stream;
      this.lease.idle = false;
      this.model.send({ type: "start", stream: this.stream });
      this.updateDemand();
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    const job = {
      id: randomUUID(),
      stream: this.stream,
      afterSeq: this.seq,
      observeOnly,
      resolve,
      reject,
    };
    this.job = job;
    this.lastUse = this.now();
    const timeout = setTimeout(() => {
      if (this.job === job) this.beginTransfer("agent", null, "视觉决策超时");
    }, this.decisionMs);
    const abort = () => {
      if (this.job === job) this.beginTransfer("agent", null, "任务已取消");
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.model.send({
        type: "step",
        id: job.id,
        stream: job.stream,
        afterSeq: job.afterSeq,
        instruction,
        observeOnly,
      });
      const reply = await promise;
      if (this.job !== job || this.task !== session || this.control !== "agent")
        throw Error("控制权已变更");
      signal.throwIfAborted();
      if (typeof reply.error === "string")
        throw Error(reply.error.slice(0, 512));
      if (
        !this.validFrame(job.stream, reply.seq) ||
        reply.seq <= job.afterSeq ||
        !this.metrics.confirmed(reply.seq) ||
        !this.validFrame(job.stream, this.seq, 1500)
      )
        throw Error("模型决策帧过旧或尚未确认处理");
      if (
        typeof reply.observation !== "string" ||
        reply.observation.length > 12000
      )
        throw Error("无效的观察回执");
      const action = observeOnly ? null : reply.action;
      if (
        action !== null &&
        (typeof action !== "object" || Array.isArray(action))
      )
        throw Error("无效的模型动作回执");
      if (action) {
        const live = this.metrics.view(this.now());
        if (
          this.mode === "full" &&
          Math.min(live.rxFps, live.processedFps) < 12
        )
          throw Error("模型低于 12 fps，自动输入暂停");
        this.needsObservation = true;
        // A lost child must keep the physical desktop locked, but can no longer block the Agent's tool result.
        const cancelled = Promise.withResolvers();
        job.cancelInput = cancelled.reject;
        await Promise.race([this.apply(action), cancelled.promise]);
        if (
          this.job !== job ||
          this.task !== session ||
          this.control !== "agent" ||
          signal.aborted
        )
          throw Error("输入结果未知，请重新观察");
      }
      this.needsObservation = false;
      return {
        stream: job.stream,
        seq: reply.seq,
        observation: reply.observation,
        action: action ?? null,
      };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (this.job === job) this.job = null;
      if (this.lease?.id === leaseId) this.lastUse = this.now();
    }
  }
  result(msg) {
    const job = this.job;
    if (job && msg.id === job.id && msg.stream === job.stream) job.resolve(msg);
  }
  cancel(reason) {
    if (!this.job) return;
    this.job.cancelInput?.(Error(reason + "（在途输入结果未知）"));
    this.model?.send({
      type: "cancel",
      stream: this.job.stream,
      id: this.job.id,
    });
    this.job.reject(Error(reason));
    this.job = null;
  }
  async apply(action) {
    if (this.inputBusy || this.maintenance) throw Error("另一桌面操作正在执行");
    this.inputController = new AbortController();
    const pending = this.input(action, this.size, this.inputController.signal);
    this.inputBusy = pending;
    try {
      await pending;
      if (this.inputController.signal.aborted)
        throw Error("输入已中断，结果未知");
    } catch {
      throw Error("桌面输入未确认，结果未知，请重新观察");
    } finally {
      this.inputBusy = null;
      this.inputController = null;
    }
  }
  async viewerCommand(peer, msg) {
    if (this.closed || !this.viewers.has(peer)) throw Error("观看连接已过期");
    if (msg.type === "watch") return this.setWatching(peer, msg.enabled);
    if (msg.type === "take") {
      if (
        this.control === "human" &&
        this.owner === peer &&
        this.manualFrom === msg.leaseId
      )
        return;
      if (msg.leaseId !== (this.lease?.id ?? null)) throw Error(changedOwner);
      if (this.controlError) throw Error(this.controlError);
      if (this.control === "human") throw Error("另一用户正在接管");
      let transfer = this.transfer;
      if (transfer) {
        if (transfer.target === "agent" && this.lease) {
          transfer.target = "human";
          transfer.peer = peer;
          this.notifyInterrupt(transfer);
        } else if (transfer.target !== "human" || transfer.peer !== peer) {
          throw Error("当前正在交接桌面");
        }
      } else {
        transfer = this.beginTransfer("human", peer, "用户接管桌面");
      }
      await transfer.done.promise;
      if (this.control !== "human" || this.owner !== peer)
        throw Error(this.controlError || "桌面接管未完成");
    } else if (msg.type === "resume") {
      if (
        this.controlError ||
        this.transfer ||
        this.control === "agent" ||
        (this.owner && this.owner !== peer)
      )
        throw Error(this.controlError || "当前不可交还桌面");
      const transfer = this.beginTransfer("agent", peer, "用户交还桌面");
      await transfer.done.promise;
      if (transfer.target !== "agent")
        throw Error(this.controlError || "桌面交还未完成");
    } else if (msg.type === "act") {
      const video = this.videoSubscribers.get(peer);
      if (
        !video || (msg.stream === video.stream && msg.seq <= video.afterSeq) ||
        this.control !== "human" ||
        this.owner !== peer ||
        !this.validFrame(msg.stream, msg.seq)
      )
        throw Error("输入已拒绝，请在新画面上操作");
      await this.apply(msg.action);
    } else throw Error("未知输入消息");
  }
  tick() {
    if (
      this.streaming &&
      !this.job &&
      this.now() - this.lastUse >= this.idleMs
    ) {
      this.lease.idle = true;
      this.needsObservation = true;
      this.model.discard();
      this.model.send({ type: "stop", stream: this.lease.stream });
      this.updateDemand();
    }
  }
  status(viewer) {
    return {
      type: "status",
      control: this.control,
      holder: this.lease?.agentId ?? null,
      leaseId: this.lease?.id ?? null,
      queueLength: this.queue.size,
      controlError: this.controlError ?? null,
      owner: Boolean(viewer && this.owner === viewer),
      watching: this.videoSubscribers.has(viewer),
      subscribed: this.streaming,
      modelMode: this.mode ?? null,
      metrics: this.metrics.view(this.now()),
      needsObservation: this.needsObservation,
      captureError: this.captureError ?? null,
    };
  }
}
