#!/usr/bin/env bash
# Finds keys defined in infra/.env that no service in compose.yaml consumes.
#
# Usage: ./scripts/check-env-mapping.sh [compose-file] [env-file]
#
# ── Why this exists ────────────────────────────────────────────────────────
# The app services enumerate their environment explicitly:
#
#     environment:
#       AUTH_AZURE_AD_CLIENT_ID: ${AUTH_AZURE_AD_CLIENT_ID:-}
#
# .env supplies the VALUES for that substitution; it is not the container's
# environment. A key present in .env but absent from the `environment:` block is
# therefore discarded in silence -- compose reports success, the container comes
# up healthy, and the setting simply does nothing. `--force-recreate` does not
# surface it either.
#
# That cost a full debugging cycle during the SSO migration: account linking was
# set correctly in .env, web was recreated twice, and the login kept failing
# with the exact error the setting exists to prevent.
#
# See docs/DEPLOYMENT-PITFALLS.md issue 14.
#
# This is a STATIC check -- it compares two files and needs nothing running, so
# it belongs in CI and in pre-deploy validation. To confirm what a LIVE
# container actually holds, inspect the container instead:
#   docker inspect langfuse-web-1 --format '{{range .Config.Env}}{{println .}}{{end}}'
set -euo pipefail

cd "$(dirname "$0")/.."

compose_file="${1:-infra/compose.yaml}"
env_file="${2:-infra/.env}"

[ -f "$compose_file" ] || { echo "ERROR: $compose_file not found"; exit 1; }
[ -f "$env_file" ]     || { echo "ERROR: $env_file not found"; exit 1; }

# Keys that are deliberately not consumed by any service.
#   COMPOSE_*        - read by the docker compose CLI itself, never by a service
#   *_ALLOWLIST etc. - templated into config files rather than passed as env
ignore_re='^(COMPOSE_[A-Z_]+)$'

orphans=()
while IFS= read -r key; do
  [[ "$key" =~ $ignore_re ]] && continue
  # Referenced as ${KEY}, ${KEY:-default}, or bare $KEY anywhere in the compose file.
  if ! grep -qE "\\\$\{${key}(:?[-?][^}]*)?\}|\\\$${key}\b" "$compose_file"; then
    orphans+=("$key")
  fi
done < <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$env_file" | tr -d '=' | sort -u)

if [ ${#orphans[@]} -eq 0 ]; then
  echo "PASS: every key in $env_file is consumed by $compose_file"
  exit 0
fi

echo "FAIL: ${#orphans[@]} key(s) in $env_file are never read by $compose_file."
echo "These have NO effect at runtime. Add them to the relevant service's"
echo "'environment:' block, or delete them from $env_file:"
printf '  %s\n' "${orphans[@]}"
exit 1
