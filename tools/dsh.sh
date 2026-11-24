#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -P)
if [[ -v AVL_SUDO_PASSWORD ]]; then
  echo 'Use the container entrypoint to supply AVL_SUDO_PASSWORD.' >&2
  exit 2
fi
if [[ "${AVL_MODEL_TOKEN_FD:-}" != "3" ]]; then
  if [[ -z "${AVL_MODEL_TOKEN:-}" || "$AVL_MODEL_TOKEN" =~ [[:space:]] ]]; then
    echo 'Set AVL_MODEL_TOKEN to a nonempty token without whitespace.' >&2
    exit 2
  fi
  exec 3<<<"$AVL_MODEL_TOKEN"
  unset AVL_MODEL_TOKEN
  export AVL_MODEL_TOKEN_FD=3
fi
export DSH_HOME="${DSH_HOME:-$HOME/.local/state/avl-dsh}"
[[ "$DSH_HOME" = /* ]] || { echo 'DSH_HOME must be absolute' >&2; exit 2; }
umask 077
mkdir -p "$DSH_HOME/run"
cd "$DSH_HOME/run"
# Keep the application in the foreground and give tini the actual Host exit status.
patch="$DSH_HOME/run/avl-profile.yml"
node --input-type=module - "$root/host/plugin.mjs" "$patch" <<'JS'
import { writeFileSync, renameSync } from 'node:fs';
const [, , plugin, path]=process.argv;
const tmp=path+"."+process.pid;
writeFileSync(tmp, JSON.stringify([{insert:[{id:"avl-desktop",name:plugin}]}]), {mode:0o600});
renameSync(tmp,path);
JS
web_args=(--host "${DSH_BIND:-127.0.0.1}" --port "${DSH_PORT:-3080}")
if [[ -n "${DSH_PUBLIC_URL:-}" ]]; then
  authority=$(node -e 'const url=new URL(process.argv[1]); if (!["https:","http:"].includes(url.protocol) || url.username || url.password || url.pathname!=="/" || url.search || url.hash) process.exit(2); process.stdout.write(url.host)' "$DSH_PUBLIC_URL")
  web_args+=(--public-url "$DSH_PUBLIC_URL" --trusted-host "$authority")
fi
exec node "$root/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile web --patch "$patch" --no-open "${web_args[@]}" "$@"
