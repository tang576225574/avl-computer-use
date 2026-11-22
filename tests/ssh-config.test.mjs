import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopSshConfig } from "../tools/ssh-config.mjs";

const root = "/test/project";
const env = {
  AVL_SSH_USER: "tang", AVL_SSH_ADDRESS: "desktop.example", AVL_SSH_PORT: "2222",
  AVL_SUDO_PASSWORD: "test password with $ and ' characters",
};

test("OpenSSH resolves both aliases to the configured user and the project key", async () => {
  const config = desktopSshConfig(env, root);
  assert.equal(config.sshAlias, "avl-desktop");
  assert.equal(config.opsAlias, "avl-desktop-ops");
  assert.ok(!config.text.includes(env.AVL_SUDO_PASSWORD));
  const folder = await mkdtemp(join(tmpdir(), "avl-ssh-test-"));
  try {
    const file = join(folder, "config");
    await writeFile(file, config.text, { mode: 0o600 });
    for (const alias of [config.sshAlias, config.opsAlias]) {
      const options = execFileSync("ssh", ["-G", "-F", file, alias], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      assert.match(options, /^user tang$/m);
      assert.match(options, /^hostname desktop\.example$/m);
      assert.match(options, /^port 2222$/m);
      assert.match(options, /^identityfile \/test\/project\/\.local\/ssh\/avl-desktop_ed25519$/m);
      assert.match(options, /^passwordauthentication no$/m);
      assert.match(options, /^stricthostkeychecking true$/m);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("legacy configured aliases continue to use the user's OpenSSH configuration", () => {
  const config = desktopSshConfig({ AVL_SSH_HOST: "my-workspace", AVL_OPS_SSH_HOST: "my-ops" }, root);
  assert.equal(config.sshAlias, "my-workspace");
  assert.equal(config.opsAlias, "my-ops");
  assert.equal(config.text, undefined);
});

test("OpenSSH directives cannot be injected via environment values", () => {
  assert.throws(() => desktopSshConfig({ ...env, AVL_SSH_ADDRESS: "desktop\nProxyCommand false" }, root), /AVL_SSH_ADDRESS/);
  assert.throws(() => desktopSshConfig({ ...env, AVL_SSH_USER: "tang\nMatch all" }, root), /AVL_SSH_USER/);
  assert.throws(() => desktopSshConfig({ ...env, AVL_SSH_PORT: "65536" }, root), /AVL_SSH_PORT/);
  assert.throws(() => desktopSshConfig({ ...env, AVL_SUDO_PASSWORD: "line\nbreak" }, root), /AVL_SUDO_PASSWORD/);
});

test("a failed mount preflight cannot open an operations SSH session", async () => {
  const folder = await mkdtemp(join(tmpdir(), "avl-ssh-launch-"));
  const key = join(folder, "private-key");
  const fakePassword = "mock sudo password";
  try {
    await writeFile(key, "", { mode: 0o600 });
    await writeFile(join(folder, "findmnt"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const marker = join(folder, "ssh-called");
    await writeFile(join(folder, "ssh"), '#!/bin/sh\ntouch "$SSH_MARKER"\nexit 1\n', { mode: 0o700 });
    assert.throws(() => execFileSync("bash", ["tools/app.sh", "--no-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, ...env, PATH: folder + ":" + process.env.PATH, SSH_MARKER: marker, AVL_SUDO_PASSWORD: fakePassword,
        AVL_SSH_HOST: "test-desktop", AVL_OPS_SSH_HOST: "test-ops", AVL_SSH_KEY: key,
        AVL_WORKSPACE: join(folder, "workspace"), DSH_HOME: join(folder, "home"),
        AVL_SSH_NODE: "/usr/bin/node", AVL_SSH_HELPER: "/opt/helper.js",
        AVL_SSH_HELPER_SHA256: "a".repeat(64), AVL_DESKTOP_URL: "http://127.0.0.1:1",
        AVL_DESKTOP_TOKEN: "unused-test-token",
      },
    }), error => {
      assert.equal(existsSync(marker), false);
      assert.match(error.stderr, /fixed workspace SSHFS mount is unavailable/);
      assert.ok(!error.stderr.includes(fakePassword));
      return true;
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("managed workspace SSH preserves an explicitly configured operations alias", () => {
  const config = desktopSshConfig({ ...env, AVL_OPS_SSH_HOST: "existing-ops" }, root);
  assert.match(config.text, /^Host avl-desktop$/m);
  assert.match(config.text, /^Host existing-ops\n    Include ~\/\.ssh\/config$/m);
});

test("DSH launches outside the project env directory with a private sudo file", async () => {
  const folder = await mkdtemp(join(tmpdir(), "avl-ssh-child-"));
  const key = join(folder, "private-key");
  const workspace = join(folder, "workspace");
  const fakePassword = "private-child-test";
  try {
    await writeFile(key, "", { mode: 0o600 });
    const mount = JSON.stringify({ filesystems: [{
      target: workspace, source: "test-desktop:" + workspace, fstype: "fuse.sshfs", options: "ro",
    }] });
    await writeFile(join(folder, "findmnt"), [
      "#!/bin/sh", `printf '%s\\n' '${mount}'`, "",
    ].join("\n"), { mode: 0o700 });
    const preload = join(folder, "preload.cjs");
    await writeFile(preload, [
      'if (process.argv[1]?.endsWith("/@deepseek-ai/dsh/lib/bin.js")) {',
      '  const assert = require("node:assert/strict");',
      '  const fs = require("node:fs");',
      '  assert.ok(!fs.existsSync(".env"));',
      '  assert.equal(process.env.AVL_SUDO_PASSWORD, undefined);',
      '  const file = process.env.AVL_SUDO_PASSWORD_FILE;',
      `  assert.equal(fs.readFileSync(file, "utf8"), ${JSON.stringify(fakePassword)});`,
      '  assert.equal(fs.statSync(file).mode & 0o777, 0o600);',
      '  console.log("isolated DSH child");',
      '  process.exit(0);',
      '}',
    ].join("\n"), { mode: 0o600 });
    const output = execFileSync("bash", ["tools/app.sh", "--no-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, ...env, PATH: folder + ":" + process.env.PATH, NODE_OPTIONS: "--require=" + preload,
        AVL_SUDO_PASSWORD: fakePassword, AVL_SSH_HOST: "test-desktop", AVL_OPS_SSH_HOST: "test-ops",
        AVL_SSH_KEY: key, AVL_WORKSPACE: workspace, DSH_HOME: join(folder, "home"), AVL_SSH_NODE: "/usr/bin/node",
        AVL_SSH_HELPER: "/opt/helper.js", AVL_SSH_HELPER_SHA256: "a".repeat(64),
        AVL_DESKTOP_URL: "http://127.0.0.1:1", AVL_DESKTOP_TOKEN: "unused-test-token",
      },
    });
    assert.match(output, /isolated DSH child/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
