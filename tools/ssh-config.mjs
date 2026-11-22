import { isIP } from "node:net";
import { resolve } from "node:path";

function alias(value, name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value ?? "")) {
    throw new Error(`${name} must be an OpenSSH alias`);
  }
  return value;
}

export function desktopSshConfig(env, projectRoot) {
  const sudoPassword = env.AVL_SUDO_PASSWORD || undefined;
  if (sudoPassword && /[\0\r\n]/.test(sudoPassword)) throw new Error("AVL_SUDO_PASSWORD must be one line");
  const managed = Boolean(env.AVL_SSH_USER || env.AVL_SSH_ADDRESS || env.AVL_SSH_PORT || env.AVL_SSH_KEY);
  const sshAlias = alias(env.AVL_SSH_HOST || (managed ? "avl-desktop" : undefined), "AVL_SSH_HOST");
  const opsName = env.AVL_OPS_SSH_HOST || (managed && sudoPassword ? "avl-desktop-ops" : undefined);
  const opsAlias = opsName ? alias(opsName, "AVL_OPS_SSH_HOST") : undefined;
  if (opsAlias === sshAlias) throw new Error("Use a separate alias for AVL_OPS_SSH_HOST");
  if (sudoPassword && !opsAlias) throw new Error("Set AVL_OPS_SSH_HOST to use AVL_SUDO_PASSWORD");
  if (!managed) return { sshAlias, opsAlias, sudoPassword };

  const user = env.AVL_SSH_USER;
  const address = env.AVL_SSH_ADDRESS;
  const port = env.AVL_SSH_PORT || "22";
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(user ?? "")) throw new Error("Set AVL_SSH_USER to the remote username");
  if (!address || (!isIP(address) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(address))) {
    throw new Error("Set AVL_SSH_ADDRESS to the remote hostname or IP address");
  }
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("AVL_SSH_PORT must be between 1 and 65535");
  }
  const key = resolve(projectRoot, env.AVL_SSH_KEY || ".local/ssh/avl-desktop_ed25519");
  if (/[\x00-\x1f\x7f"\\%$]/.test(key)) throw new Error("AVL_SSH_KEY contains an unsupported path character");
  const text = [
    `Host ${opsAlias && !env.AVL_OPS_SSH_HOST ? `${sshAlias} ${opsAlias}` : sshAlias}`,
    `    HostName ${address}`,
    `    User ${user}`,
    `    Port ${Number(port)}`,
    `    IdentityFile "${key}"`,
    "    IdentitiesOnly yes",
    "    BatchMode yes",
    "    PreferredAuthentications publickey",
    "    PasswordAuthentication no",
    "    KbdInteractiveAuthentication no",
    "    StrictHostKeyChecking yes",
    "    ForwardAgent no",
    "    ConnectTimeout 5",
    ...(env.AVL_OPS_SSH_HOST ? ["", `Host ${opsAlias}`, "    Include ~/.ssh/config"] : []),
    "",
  ].join("\n");
  return { sshAlias, opsAlias, sudoPassword, text, key };
}
