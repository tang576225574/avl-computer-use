import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { requireSshMount } from "../avl_computer_use/backend/fixed-workspace.mjs";
import { desktopSshConfig } from "./ssh-config.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const envFile = join(projectRoot, ".env");
const inheritedPassword = process.env.AVL_SUDO_PASSWORD;
try {
  loadEnvFile(envFile);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const { sshAlias: host, opsAlias, sudoPassword, text: sshConfig, key } = desktopSshConfig(process.env, projectRoot);
if (sudoPassword && inheritedPassword === undefined) {
  const credentials = await stat(envFile);
  if ((credentials.mode & 0o077) || credentials.uid !== process.getuid()) {
    throw new Error("Set the project .env to owner-only permissions before storing AVL_SUDO_PASSWORD");
  }
}
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--ssh-config") {
  if (!sshConfig) throw new Error("Set AVL_SSH_USER and AVL_SSH_ADDRESS to generate SSH configuration");
  process.stdout.write(sshConfig);
  process.exit(0);
}
if (argv.some(argument => argument !== "--no-open")) throw new Error("Supported launcher options: --no-open, --ssh-config");

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
const helper = absolute("AVL_SSH_HELPER");
const helperHash = required("AVL_SSH_HELPER_SHA256");
const dshHome = absolute("DSH_HOME");
const sshLaunch = process.env.AVL_SSH_NODE
  ? { kind: "node-script", node: absolute("AVL_SSH_NODE") }
  : { kind: "executable" };
if (!/^[0-9a-f]{64}$/.test(helperHash)) throw new Error("AVL_SSH_HELPER_SHA256 must be a lowercase SHA-256 digest");
if (dshHome === workspace || dshHome.startsWith(workspace + "/")) throw new Error("DSH_HOME must be outside the workspace");
required("AVL_DESKTOP_URL");
required("AVL_DESKTOP_TOKEN");

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
const temp = await realpath(await mkdtemp(join(tmpdir(), "avl-dsh-")));
try {
  const env = { ...process.env, AVL_SSH_HOST: host };
  if (opsAlias) env.AVL_OPS_SSH_HOST = opsAlias;
  else delete env.AVL_OPS_SSH_HOST;
  delete env.AVL_SUDO_PASSWORD;
  delete env.AVL_SUDO_PASSWORD_FILE;
  if (sshConfig) {
    await access(key).catch(() => { throw new Error(`SSH private key is missing: ${key}`); });
    const bin = join(temp, "bin");
    await mkdir(bin, { mode: 0o700 });
    env.AVL_OPENSSH_CONFIG = join(temp, "ssh_config");
    env.AVL_OPENSSH_PATH = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
    env.PATH = `${bin}:${env.AVL_OPENSSH_PATH}`;
    await writeFile(env.AVL_OPENSSH_CONFIG, sshConfig, { mode: 0o600 });
    await writeFile(join(bin, "ssh"), [
      "#!/bin/sh", 'export PATH="$AVL_OPENSSH_PATH"', 'exec ssh -F "$AVL_OPENSSH_CONFIG" "$@"', "",
    ].join("\n"), { mode: 0o700 });
  }
  await requireSshMount(workspace, host);
  if (sudoPassword) {
    env.AVL_SUDO_PASSWORD_FILE = join(temp, "sudo-password");
    await writeFile(env.AVL_SUDO_PASSWORD_FILE, sudoPassword, { mode: 0o600 });
  }
  const patch = join(temp, "cordis.patch.yml");
  await writeFile(patch, JSON.stringify(overlay, null, 2), { mode: 0o600 });
  const dsh = fileURLToPath(new URL("../node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url));
  const child = spawn(process.execPath, [dsh, "--profile", "web", "--patch", patch, ...argv], {
    stdio: "inherit", cwd: temp, env: { ...env, PWD: temp },
  });
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
