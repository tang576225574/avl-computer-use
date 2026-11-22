import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function requireSshMount(workspace, alias) {
  const { stdout } = await run("findmnt", [
    "--json", "--mountpoint", workspace, "--output", "TARGET,SOURCE,FSTYPE,OPTIONS",
  ], { timeout: 3000 }).catch(cause => {
    throw new Error("The fixed workspace SSHFS mount is unavailable", { cause });
  });
  const mount = JSON.parse(stdout).filesystems?.[0];
  if (mount?.target !== workspace || mount.source !== `${alias}:${workspace}` ||
      mount.fstype !== "fuse.sshfs" || !mount.options.split(",").includes("ro")) {
    throw new Error("The fixed workspace requires the configured read-only SSHFS mount");
  }
}

function mountedWorkspace(workspace, alias) {
  let inFlight;
  return async () => {
    await requireSshMount(workspace, alias);
    // Keep only one stat process if the kernel holds it inside a stalled FUSE request.
    inFlight ??= run("stat", ["-f", "--format=%T", "--", workspace], { timeout: 2000, killSignal: "SIGKILL" })
      .then(() => true, () => false).finally(() => { inFlight = undefined; });
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); });
    try {
      if (!await Promise.race([inFlight, deadline])) throw new Error("The fixed SSHFS mount is not responding");
    } finally {
      clearTimeout(timer);
    }
  };
}

async function isFixedDirectory(fs, workspace, signal) {
  const target = await fs.resolve(workspace, { signal });
  return fs.processPath(target) === workspace && (await fs.stat(target, signal))?.type === "directory";
}

function rpcResult(request, result) {
  return Response.json({ type: "server-response", rpcId: request.rpcId, result });
}

function failure(message) {
  return { ok: false, error: { code: "gateway/bad-request", message, details: {} } };
}

export function registerFixedWorkspace(ctx, workspace, alias) {
  let fixed;
  let helper;
  const checkMount = mountedWorkspace(workspace, alias);
  const denied = ["workspace/create", "workspace/delete"];
  for (const method of [...denied, "workspace/initializeDefault", "session/create"]) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/${method}`,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const body = await request.json().catch(() => null);
        if (body?.type !== "client-request" || body.method !== method || typeof body.rpcId !== "string") {
          return new Response("Invalid RPC envelope", { status: 400 });
        }
        if (denied.includes(method)) return rpcResult(body, failure("工作区由部署管理员固定"));
        if (method === "workspace/initializeDefault") return rpcResult(body, { ok: true });
        const current = fixed;
        if (!current) return rpcResult(body, failure("固定 SSH 工作区尚未就绪"));
        const args = body.payload?.args;
        const input = args?.request;
        if (typeof input !== "object" || input === null || Array.isArray(input) ||
            Object.keys(input).some(key => !["cwd", "workspaceId", "sessionId", "agentPreset"].includes(key)) ||
            Object.values(input).some(value => typeof value !== "string") ||
            (input.cwd !== undefined && input.cwd !== workspace) ||
            (input.workspaceId !== undefined && input.workspaceId !== current.id)) {
          return rpcResult(body, failure("只允许使用指定的 SSH 工作区"));
        }
        try {
          await checkMount();
          if (!await isFixedDirectory(current.fs, workspace, request.signal) || fixed !== current) {
            throw new Error("SSH workspace unavailable");
          }
          const value = await ctx.sessionController.create({
            workspaceId: current.id,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}),
          });
          return rpcResult(body, { ok: true, value });
        } catch {
          return rpcResult(body, failure("无法创建会话，请检查固定 SSH 工作区和所选 Agent 配置"));
        }
      },
    }));
  }

  ctx.inject(["ssh", "fs", "subprocess"], async scope => {
    const provider = scope.subprocess;
    helper = provider;
    scope.effect(() => () => {
      if (helper === provider) {
        helper = undefined;
        fixed = undefined;
      }
    });
    try {
      await checkMount();
      await scope.ssh.ready;
      if (!await isFixedDirectory(scope.fs, workspace)) {
        throw new Error("Fixed workspace must be an existing canonical directory on the SSH host");
      }
      if (ctx.workspaceRegistry.list().some(entry => entry.path !== workspace)) {
        throw new Error("Use a dedicated DSH_HOME for this fixed workspace");
      }
      const entry = await ctx.workspaceRegistry.initializeDefault(async () => workspace) ??
        await ctx.workspaceRegistry.create(workspace, "远程工作区");
      if (helper === provider) fixed = { id: entry.id, fs: scope.fs };
    } catch (error) {
      ctx.logger.error("Fixed SSH workspace unavailable: %s", error.message);
    }
  });

  return async function checkWorkspace() {
    const current = helper;
    if (!current) return "unavailable";
    try {
      // A read-only RPC through the SSH subprocess provider tests the live helper.
      await current.terminalEnvironment(AbortSignal.timeout(2000));
    } catch {
      return "unavailable";
    }
    let status = "ready";
    try {
      await checkMount();
    } catch {
      status = "mount_unavailable";
    }
    if (helper !== current) return "unavailable";
    if (status === "ready") {
      try {
        if (!fixed || !await isFixedDirectory(fixed.fs, workspace, AbortSignal.timeout(2000))) {
          status = "workspace_unavailable";
        }
      } catch {
        return "unavailable";
      }
    }
    if (helper !== current) return "unavailable";
    return status;
  };
}
