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

# Monitoring lives in a second compose file that is merged with -f rather than
# edited into compose.yaml. Its variables (GRAFANA_ADMIN_PASSWORD,
# REDIS_QUEUE_KEY_PATTERNS) are real and consumed — just not by compose.yaml —
# so searching only the platform file would report them as dead keys and train
# people to ignore this check. Included automatically when it exists and no
# explicit compose file was passed.
search_files=("$compose_file")
if [ $# -eq 0 ] && [ -f "infra/compose.monitoring.yaml" ]; then
  search_files+=("infra/compose.monitoring.yaml")
fi

# ── Also search the operational scripts ───────────────────────────────────────
# compose is not the only legitimate consumer of infra/.env. scripts/backup.sh
# and scripts/restore-test.sh source the same file and read BACKUP_ENCRYPTION_KEY,
# BACKUP_DIR, BACKUP_RETENTION_DAYS and BACKUP_REMOTE from it.
#
# Without this, those keys are reported as orphans the moment backups are
# configured — three FAILs for correctly-wired variables. That is the failure
# mode DEPLOYMENT-PITFALLS.md warns about repeatedly: a checker that cannot see
# a consumer reports "unused" when it means "I did not look there", and a suite
# that cries wolf gets ignored on the day it is right.
if [ $# -eq 0 ]; then
  for s in scripts/*.sh; do
    [ -f "$s" ] && [ "$s" != "scripts/check-env-mapping.sh" ] && search_files+=("$s")
  done
fi

# Keys that are deliberately not consumed by any service.
#   COMPOSE_*        - read by the docker compose CLI itself, never by a service
#   *_ALLOWLIST etc. - templated into config files rather than passed as env
ignore_re='^(COMPOSE_[A-Z_]+)$'

orphans=()
while IFS= read -r key; do
  [[ "$key" =~ $ignore_re ]] && continue
  # Referenced as ${KEY}, ${KEY:-default}, or bare $KEY anywhere in the compose file.
  if ! grep -qE "\\\$\{${key}(:?[-?][^}]*)?\}|\\\$${key}\b" "${search_files[@]}"; then
    orphans+=("$key")
  fi
done < <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$env_file" | tr -d '=' | sort -u)

if [ ${#orphans[@]} -eq 0 ]; then
  echo "PASS: every key in $env_file is consumed by ${search_files[*]}"
  exit 0
fi

echo "FAIL: ${#orphans[@]} key(s) in $env_file are never read by ${search_files[*]}."
echo "These have NO effect at runtime. Add them to the relevant service's"
echo "'environment:' block, or delete them from $env_file:"
printf '  %s\n' "${orphans[@]}"
exit 1
