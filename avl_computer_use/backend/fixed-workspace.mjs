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

function rpcResult(request, result) {
  return Response.json({ type: "server-response", rpcId: request.rpcId, result });
}

function failure(message) {
  return { ok: false, error: { code: "gateway/bad-request", message, details: {} } };
}

export function registerFixedWorkspace(ctx, workspace, alias) {
  let fixed;
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
          await requireSshMount(workspace, alias);
          const target = await current.fs.resolve(workspace, { signal: request.signal });
          if (current.fs.processPath(target) !== workspace ||
              (await current.fs.stat(target, request.signal))?.type !== "directory" || fixed !== current) {
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

  ctx.inject(["ssh", "fs"], async scope => {
    try {
      await requireSshMount(workspace, alias);
      await scope.ssh.ready;
      const remote = await scope.fs.resolve(workspace);
      if (scope.fs.processPath(remote) !== workspace || (await scope.fs.stat(remote))?.type !== "directory") {
        throw new Error("Fixed workspace must be an existing canonical directory on the SSH host");
      }
      if (ctx.workspaceRegistry.list().some(entry => entry.path !== workspace)) {
        throw new Error("Use a dedicated DSH_HOME for this fixed workspace");
      }
      const entry = await ctx.workspaceRegistry.initializeDefault(async () => workspace) ??
        await ctx.workspaceRegistry.create(workspace, "远程工作区");
      fixed = { id: entry.id, fs: scope.fs };
      scope.effect(() => () => { fixed = undefined; });
    } catch (error) {
      ctx.logger.error("Fixed SSH workspace unavailable: %s", error.message);
    }
  });
}
