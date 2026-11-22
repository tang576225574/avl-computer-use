import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const components = ["x11", "xfce", "novnc", "backend"];
const repairIntervals = [5_000, 15_000, 15_000];
const pollInterval = 5_000;

export class OpsSsh {
  constructor(alias, { command = promisify(execFile), env, sudoPassword } = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(alias)) {
      throw new Error("AVL_OPS_SSH_HOST must be an OpenSSH alias");
    }
    this.alias = alias;
    this.command = command;
    this.env = env;
    this.sudoPassword = sudoPassword;
    this.lifetime = new AbortController();
  }

  async #run(operation, timeout) {
    this.lifetime.signal.throwIfAborted();
    this.directory ??= mkdtemp(join(tmpdir(), "avl-ops-"));
    const socket = join(await this.directory, "ssh");
    const remote = this.sudoPassword
      ? `/usr/bin/sudo -k -S -p '' -- /opt/avl/desktop/privileged-ops.sh ${operation}`
      : operation;
    const result = this.command("ssh", [
      "-T", "-S", socket,
      "-o", "ControlMaster=auto", "-o", "ControlPersist=30s", "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
      "-o", "ConnectTimeout=3", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
      this.alias, remote,
    ], { timeout, maxBuffer: 4096, signal: this.lifetime.signal, env: this.env });
    if (this.sudoPassword) {
      result.child.stdin.on("error", () => {});
      result.child.stdin.end(this.sudoPassword + "\n");
    }
    return result;
  }

  async probe() {
    try {
      const { stdout } = await this.#run("probe", 5_000);
      const result = JSON.parse(stdout);
      if (!components.every(name => typeof result?.[name] === "boolean")) {
        return { ssh: "probe_failed" };
      }
      return { ssh: "ready", components: Object.fromEntries(components.map(name => [name, result[name]])) };
    } catch (error) {
      return { ssh: error.code === 255 || error.killed ? "unreachable" : "probe_failed" };
    }
  }

  async repair(component) {
    if (!components.includes(component)) throw new Error("Unknown desktop component");
    try {
      await this.#run(`recover ${component}`, 45_000);
      return true;
    } catch {
      // The remote command may have completed. The next probe reconciles its result.
      return false;
    }
  }

  async close() {
    this.lifetime.abort();
    const directory = await this.directory?.catch(() => null);
    if (!directory) return;
    try {
      await this.command("ssh", ["-S", join(directory, "ssh"), "-O", "exit", this.alias], { timeout: 1000, env: this.env });
    } catch {
      // A disconnected master has already exited.
    }
    await rm(directory, { recursive: true, force: true });
  }
}

export class DesktopSupervision {
  constructor({ openOps, workspace, onTransition = () => {}, clock = Date.now }) {
    this.openOps = openOps;
    this.workspace = workspace;
    this.onTransition = onTransition;
    this.clock = clock;
    this.tickets = new Map();
    this.snapshot = { state: "checking", ssh: "checking", workspace: "checking", components: {} };
  }

  publish(snapshot) {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    if (snapshot.state !== previous.state || snapshot.workspace !== previous.workspace ||
        snapshot.repairing !== previous.repairing || snapshot.lastError !== previous.lastError) {
      this.onTransition(snapshot);
    }
  }

  workspaceStatus() {
    this.checking ??= this.workspace().catch(() => "unavailable")
      .finally(() => { this.checking = undefined; });
    return this.checking;
  }

  async disconnect() {
    const ops = this.ops;
    this.ops = undefined;
    this.inFlight = undefined;
    this.tickets.clear();
    await ops?.close();
  }

  async pause(workspace) {
    this.publish({ state: "workspace_offline", workspace, ssh: "paused", components: {} });
    await this.disconnect();
  }

  async check() {
    const workspace = await this.workspaceStatus();
    if (this.stopped) return;
    if (workspace === "unavailable") {
      return this.pause(workspace);
    }
    if (!this.openOps) {
      this.publish({ state: "disabled", workspace, ssh: "disabled", components: {} });
      return;
    }
    const ops = this.ops ??= this.openOps();
    this.inFlight ??= this.update(ops, workspace).finally(() => {
      if (this.ops === ops) this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async update(ops, workspace) {
    const remote = await ops.probe();
    if (this.ops !== ops) return;
    const { ssh } = remote;
    const status = {
      workspace,
      ssh,
      checkedAt: new Date(this.clock()).toISOString(),
      components: {},
    };
    if (ssh !== "ready") {
      for (const ticket of this.tickets.values()) ticket.failures = 0;
      this.publish({ ...status, state: ssh === "unreachable" ? "ssh_unreachable" : "probe_failed" });
      return;
    }

    let candidate;
    const now = this.clock();
    for (const name of components) {
      if (remote.components[name]) {
        this.tickets.delete(name);
        status.components[name] = "healthy";
        continue;
      }
      if (name !== "x11" && !remote.components.x11) {
        this.tickets.delete(name);
        status.components[name] = "waiting_for_x11";
        continue;
      }
      const ticket = this.tickets.get(name) ?? { failures: 0, attempts: 0, next: 0 };
      this.tickets.set(name, ticket);
      ticket.failures += 1;
      if (ticket.attempts === repairIntervals.length && now >= ticket.next) {
        status.components[name] = "failed";
      } else {
        status.components[name] = ticket.attempts > 0 ? "recovering" : "degraded";
        if (!candidate && ticket.failures >= 2 && ticket.attempts < repairIntervals.length && now >= ticket.next) {
          candidate = name;
        }
      }
      if (ticket.lastError) status.lastError ??= name;
    }

    const values = Object.values(status.components);
    const state = ["failed", "recovering", "degraded"].find(value => values.includes(value)) ?? "healthy";
    if (!candidate) {
      this.publish({ ...status, state });
      return;
    }

    // A probe may finish after the helper drops. Check again before issuing a mutation.
    const beforeRepair = await this.workspaceStatus();
    if (this.ops !== ops || this.stopped) return;
    if (beforeRepair === "unavailable") {
      return this.pause(beforeRepair);
    }
    const ticket = this.tickets.get(candidate);
    ticket.attempts += 1;
    status.components[candidate] = "recovering";
    const active = { ...status, state: state === "failed" ? state : "recovering", repairing: candidate, attempt: ticket.attempts };
    this.publish(active);
    const completed = await ops.repair(candidate);
    if (this.ops !== ops) return;
    ticket.next = this.clock() + repairIntervals[ticket.attempts - 1];
    ticket.lastError = !completed;
    if (!this.stopped) {
      this.publish({ ...active, repairing: undefined, lastError: completed ? status.lastError : candidate });
    }
  }

  start() {
    const poll = () => {
      void this.check().catch(() => {
        if (!this.stopped && this.ops) this.publish({ ...this.snapshot, state: "probe_failed", repairing: undefined });
      });
    };
    poll();
    const timer = setInterval(poll, pollInterval).unref();
    return () => {
      this.stopped = true;
      clearInterval(timer);
      return this.disconnect();
    };
  }
}

export function isOwner(peer) {
  return peer?.principal.kind === "owner" && !peer.signal.aborted;
}

export function createHealthResponse(snapshot, peer) {
  if (!isOwner(peer)) return new Response("Forbidden", { status: 403 });
  return Response.json(snapshot, { headers: { "cache-control": "no-store" } });
}
