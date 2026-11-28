#!/usr/bin/env bash
set -euo pipefail
# A Host needs only its own token, including when A and C are launched from the same shell.
unset AVL_MODEL_TOKENS
if [[ -v AVL_SUDO_PASSWORD ]]; then
  echo 'Use the container entrypoint to supply AVL_SUDO_PASSWORD.' >&2
  exit 2
fi
valid_device_token() {
  local LC_ALL=C
  [[ $1 =~ ^[!-~]{1,512}$ ]]
}
if [[ "${AVL_MODEL_TOKEN_FD:-}" != "3" ]]; then
  if ! valid_device_token "${AVL_MODEL_TOKEN:-}"; then
    echo 'AVL_MODEL_TOKEN must contain 1 to 512 printable ASCII characters without spaces.' >&2
    exit 2
  fi
  exec 3<<<"$AVL_MODEL_TOKEN"
  export AVL_MODEL_TOKEN_FD=3
fi
unset AVL_MODEL_TOKEN
root=$(cd "$(dirname "$0")/.." && pwd -P)
export DSH_HOME="${DSH_HOME:-$HOME/.local/state/avl-dsh}"
[[ "$DSH_HOME" = /* ]] || { echo 'DSH_HOME must be absolute' >&2; exit 2; }
umask 077
mkdir -p "$DSH_HOME/run"
cd "$DSH_HOME/run"
# The compatible client requires a bearer value even for an unauthenticated local server.
if [[ -n "${AVL_MAIN_BASE_URL:-}" && -z "${AVL_MAIN_API_KEY:-}" ]]; then
  export AVL_MAIN_API_KEY=local-no-auth
fi
# Keep the application in the foreground and give tini the actual Host exit status.
patch="$DSH_HOME/run/avl-profile.yml"
node --input-type=module - "$root/host/plugin.mjs" "$patch" 3<&- <<'JS'
import { writeFileSync, renameSync } from 'node:fs';
const [, , plugin, path]=process.argv;
const { AVL_MAIN_BASE_URL: baseURL, AVL_MAIN_MODEL: model, AVL_MODEL_SETUP_PROMPT: prompt } = process.env;
const rows = [{insert:[{id:"avl-desktop",name:plugin}]}];
if (baseURL || model || process.env.AVL_MAIN_API_KEY) {
  if (!baseURL || !model?.trim()) throw Error("Set both AVL_MAIN_BASE_URL and AVL_MAIN_MODEL");
  const url = URL.parse(baseURL);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Error("AVL_MAIN_BASE_URL must be an HTTP(S) API root without credentials, query or fragment");
  const provider = "avl-main";
  rows.push(
    {id:"llm-pi-ai", config:{providers:{[provider]:{
      displayName:"AVL Main", api:"openai-completions", baseURL, apiKeyEnv:"AVL_MAIN_API_KEY", models:[{id:model}],
    }}}},
    {id:"agent-default-model", config:{provider, model}},
  );
}
if (prompt && prompt !== "0" && prompt !== "1") throw Error("AVL_MODEL_SETUP_PROMPT must be 0 or 1");
if (prompt || baseURL) rows.push({id:"ui-settings-models", config:{credentialOnboarding:prompt === "1"}});
const tmp=path+"."+process.pid;
writeFileSync(tmp, JSON.stringify(rows), {mode:0o600});
renameSync(tmp,path);
JS
web_args=(--host "${DSH_BIND:-127.0.0.1}" --port "${DSH_PORT:-3080}")
if [[ -n "${DSH_PUBLIC_URL:-}" ]]; then
  authority=$(node -e 'const url=new URL(process.argv[1]); if (!["https:","http:"].includes(url.protocol) || url.username || url.password || url.pathname!=="/" || url.search || url.hash) process.exit(2); process.stdout.write(url.host)' "$DSH_PUBLIC_URL")
  web_args+=(--public-url "$DSH_PUBLIC_URL" --trusted-host "$authority")
fi
exec node "$root/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile web --patch "$patch" --no-open "${web_args[@]}" "$@"
