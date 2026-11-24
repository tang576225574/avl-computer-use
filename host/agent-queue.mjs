// Map insertion order is the FIFO order. Each live tool call has its own cancellation signal.
export class AgentQueue {
  entries = new Map();

  get size() {
    return this.entries.size;
  }

  join(agentId, rootId, signal) {
    signal?.throwIfAborted();
    let entry = this.entries.get(agentId);
    if (!entry) {
      entry = { rootId, calls: new Set() };
      this.entries.set(agentId, entry);
    }
    const { calls } = entry;
    const call = Promise.withResolvers();
    const abort = () => {
      calls.delete(call);
      if (!calls.size) this.entries.delete(agentId);
      call.reject(Error("桌面排队已取消"));
    };
    call.cleanup = () => signal?.removeEventListener("abort", abort);
    calls.add(call);
    signal?.addEventListener("abort", abort, { once: true });
    return call.promise;
  }

  grantNext(grant) {
    const entry = this.entries.entries().next().value;
    if (!entry) return;
    const [agentId, { rootId, calls }] = entry;
    this.entries.delete(agentId);
    for (const call of calls) call.cleanup();
    try {
      const lease = grant(agentId, rootId);
      for (const call of calls) call.resolve(lease);
    } catch (error) {
      for (const call of calls) call.reject(error);
    }
  }

  cancel(agentId, reason) {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    const { calls } = entry;
    this.entries.delete(agentId);
    for (const call of calls) {
      call.cleanup();
      call.reject(Error(reason));
    }
  }

  close(reason) {
    for (const agentId of this.entries.keys()) this.cancel(agentId, reason);
  }
}
