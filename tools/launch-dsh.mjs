import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { requireSshMount } from "../avl_computer_use/backend/fixed-workspace.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before launching DSH`);
  return value;
}

function absolute(name) {
  const value = required(name);
  if (!isAbsolute(value) || normalize(value) !== value || value === "/") {
    throw new Error(`${name} must be a canonical absolute path`);
  }
  return value;
}

const workspace = absolute("AVL_WORKSPACE");
const host = required("AVL_SSH_HOST");
const helper = absolute("AVL_SSH_HELPER");
const helperHash = required("AVL_SSH_HELPER_SHA256");
const dshHome = absolute("DSH_HOME");
const sshLaunch = process.env.AVL_SSH_NODE
  ? { kind: "node-script", node: absolute("AVL_SSH_NODE") }
  : { kind: "executable" };
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host)) throw new Error("AVL_SSH_HOST must be an OpenSSH alias");
if (!/^[0-9a-f]{64}$/.test(helperHash)) throw new Error("AVL_SSH_HELPER_SHA256 must be a lowercase SHA-256 digest");
if (dshHome === workspace || dshHome.startsWith(workspace + "/")) throw new Error("DSH_HOME must be outside the workspace");
required("AVL_DESKTOP_URL");
required("AVL_DESKTOP_TOKEN");

const argv = process.argv.slice(2);
if (argv.some(argument => argument !== "--no-open")) throw new Error("Supported launcher option: --no-open");
await requireSshMount(workspace, host);

const plugin = fileURLToPath(new URL("../avl_computer_use/backend/dsh.mjs", import.meta.url));
const published = name => fileURLToPath(import.meta.resolve(`@deepseek-ai/dsh-${name}`));
const overlay = [
  ...["subprocess", "sandbox", "fs-sandbox", "directory-picker", "plugin-manager", "tool-plugin-manager", "ui-plugin-manager", "hmr"]
    .map(id => ({ id, disabled: true })),
  { id: "session-controller", config: { nativeOpen: false } },
  { id: "sandbox-policy", config: { mode: "workspace-write", workspaceRoot: workspace } },
  { insert: [
    { id: "avl-ssh", name: published("ssh"), config: { host, helper, helperHash, workspace, launch: sshLaunch } },
    { id: "avl-fs", name: published("fs-ssh") },
    { id: "avl-subprocess", name: published("subprocess-ssh") },
    { id: "avl-sandbox", name: published("sandbox-ssh") },
    { id: "avl-desktop", name: plugin },
  ] },
];

await mkdir(dshHome, { recursive: true, mode: 0o700 });
const temp = await mkdtemp(join(tmpdir(), "avl-dsh-"));
try {
  const patch = join(temp, "cordis.patch.yml");
  await writeFile(patch, JSON.stringify(overlay, null, 2), { mode: 0o600 });
  const dsh = fileURLToPath(new URL("../node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url));
  const child = spawn(process.execPath, [dsh, "--profile", "web", "--patch", patch, ...argv], { stdio: "inherit" });
  const forward = signal => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
