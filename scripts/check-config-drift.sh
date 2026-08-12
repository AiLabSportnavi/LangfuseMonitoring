#!/usr/bin/env bash
# Detects drift between THIS REPOSITORY and what is actually running.
# Audit finding F-07. Exit 0 = no drift.
#
#   ./scripts/check-config-drift.sh                  # run ON the host
#   ./scripts/check-config-drift.sh --ssh root@5.9.95.174
#
# ── Why this exists ───────────────────────────────────────────────────────────
#
# The 2026-08-12 audit reached four wrong conclusions from one root cause: it
# read infra/.env and treated it as a description of the server. It is not.
# Concretely, on that date the local file said
#   AUTH_DISABLE_USERNAME_PASSWORD=false
# while the server was enforcing `true`. Two findings were raised, and one of
# them (F-03) had to be withdrawn.
#
# CLAUDE.md §12.1 already warns that "infra/caddy/Caddyfile in this repo may
# still lag the deployed server" and that "the server is the source of truth for
# exposure". That warning is correct and was not enough — a warning in prose
# does not detect anything. This script does.
#
# ── What it compares, and what it deliberately does not ───────────────────────
#
# CONFIG FILES are compared by content. Drift means someone edited the server by
# hand, or a deploy never landed. Either way the repo is no longer a description
# of reality, and every conclusion drawn from reading it is suspect.
#
# ENVIRONMENT VARIABLES are compared as PRESENCE and, for security-relevant
# switches, as VALUE — but SECRETS ARE NEVER PRINTED OR COMPARED BY VALUE. That
# is scripts/check-credential-drift.sh's job, and it compares fingerprints.
# Printing a secret here would put every platform credential into terminal
# scrollback and into CI logs the first time this runs unattended.
set -euo pipefail

cd "$(dirname "$0")/.."

SSH_TARGET=""
[ "${1:-}" = "--ssh" ] && { SSH_TARGET="${2:?--ssh needs a target}"; }

# One indirection so every command below reads identically whether it runs on
# the host or over SSH.
remote() {
  if [ -n "$SSH_TARGET" ]; then ssh -o BatchMode=yes "$SSH_TARGET" "$@";
  else bash -c "$*"; fi
}

fail=0
# `checked` counts assertions that actually ran against the running system.
# Without it, a run where every container was missing prints a green "no drift
# detected" having verified nothing — the same shape as the six config tests
# that reported green against an open surface (F-06). Skipped is not passed,
# and a script that cannot tell the difference is part of the problem.
checked=0
pass() { printf '  PASS  %s\n' "$1"; checked=$((checked+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; checked=$((checked+1)); }
warn() { printf '  WARN  %s\n' "$1"; }

if ! remote 'docker ps --format "{{.Names}}"' >/tmp/drift-containers.txt 2>/dev/null; then
  echo "FAIL: cannot reach docker${SSH_TARGET:+ on $SSH_TARGET}."
  echo "      Run this on the host, or pass --ssh <target>. Without it, this"
  echo "      repo's files are UNVERIFIED against the running system."
  exit 1
fi

# Container names vary with the compose project name; resolve rather than assume.
#
# `|| true` is load-bearing under `set -e`: grep exits 1 when nothing matches,
# and a failing command substitution inside an assignment aborts the script.
# Without it, running this where the stack is absent exits SILENTLY with no
# output at all — which reads as "nothing to report" rather than "could not
# check", the precise failure mode this script exists to eliminate.
find_container() {
  grep -E "$1" /tmp/drift-containers.txt 2>/dev/null | head -1 || true
}
CADDY="$(find_container 'caddy')"
WEB="$(find_container 'web|langfuse-web')"

echo "── Config files: repo vs running container ─────────────────────────────"

# Compared inside the container, not on the host filesystem. A bind mount can be
# stale relative to the file on disk if the container was never recreated —
# comparing host paths would miss exactly that case.
compare_file() {
  local label="$1" container="$2" path="$3" local_file="$4"
  if [ -z "$container" ]; then warn "$label: container not found, skipped"; return; fi
  if [ ! -f "$local_file" ]; then warn "$label: $local_file missing locally, skipped"; return; fi
  local remote_sum local_sum
  remote_sum="$(remote "docker exec $container sha256sum $path 2>/dev/null | cut -d' ' -f1" || true)"
  local_sum="$(sha256sum "$local_file" | cut -d' ' -f1)"
  if [ -z "$remote_sum" ]; then
    warn "$label: could not read $path in $container"
  elif [ "$remote_sum" = "$local_sum" ]; then
    pass "$label matches the repo"
  else
    bad "$label DIFFERS from the repo — the running config is not what this repo says"
    echo "        repo:    ${local_sum:0:16}"
    echo "        running: ${remote_sum:0:16}"
    echo "        diff:    docker exec $container cat $path | diff - $local_file"
  fi
}

compare_file "Caddyfile" "$CADDY" /etc/caddy/Caddyfile infra/caddy/Caddyfile

PROM="$(find_container 'prometheus')"
compare_file "prometheus.yml" "$PROM" /etc/prometheus/prometheus.yml infra/prometheus/prometheus.yml

echo
echo "── Security switches: the values the audit got wrong ───────────────────"

# Read from the CONTAINER, never from infra/.env. Docker fixes environment at
# container-create time, so even a correct .env can differ from what a
# long-running container holds — and that gap is invisible from the file.
env_of() {
  local container="$1" key="$2"
  [ -z "$container" ] && return 1
  remote "docker exec $container printenv $key 2>/dev/null" || true
}

# Booleans and lists only — no secrets. Each of these decides whether a control
# is enforcing, and each is cheap to get wrong silently.
check_switch() {
  local key="$1" expect="$2" why="$3"
  local actual; actual="$(env_of "$WEB" "$key" | tr -d '\r\n')"
  if [ -z "$actual" ]; then
    bad "${key} is UNSET on the running container — ${why}"
  elif [ "$actual" = "$expect" ]; then
    pass "${key}=${actual}"
  else
    bad "${key}=${actual} on the server, expected ${expect} — ${why}"
  fi
}

if [ -n "$WEB" ]; then
  check_switch AUTH_DISABLE_USERNAME_PASSWORD true \
    "password login beside single-tenant SSO defeats the tenant lock (F-02/F-03)"

  # Presence, not value: the addresses are deployment-specific, but EMPTY means
  # "any authenticated user may create an organisation", which is not the same
  # as nobody and is the whole point of the check.
  creators="$(env_of "$WEB" LANGFUSE_ALLOWED_ORGANIZATION_CREATORS | tr -d '\r\n')"
  if [ -n "$creators" ]; then
    pass "LANGFUSE_ALLOWED_ORGANIZATION_CREATORS is set ($(printf '%s' "$creators" | tr ',' '\n' | wc -l | tr -d ' ') entries)"
  else
    bad "LANGFUSE_ALLOWED_ORGANIZATION_CREATORS is EMPTY — any account can mint an org (F-02)"
  fi

  # The headless seed account re-creates itself on every web start, so it cannot
  # be deleted in the UI. It must be blank once a real SSO owner exists.
  seed="$(env_of "$WEB" LANGFUSE_INIT_USER_EMAIL | tr -d '\r\n')"
  if [ -n "$seed" ]; then
    bad "LANGFUSE_INIT_USER_EMAIL is still set (${seed}) — this password account returns on every restart"
  else
    pass "headless seed user retired"
  fi
else
  warn "langfuse web container not found — auth switches NOT verified"
fi

if [ -n "$CADDY" ]; then
  # The retired allowlist. A value here means IP trust came back, and with it a
  # rotating residential address holding standing admin reach (F-05).
  al="$(remote "docker exec $CADDY printenv ADMIN_ALLOWLIST 2>/dev/null" | tr -d '\r\n' || true)"
  [ -z "$al" ] && pass "ADMIN_ALLOWLIST absent from the running Caddy" \
                || bad "ADMIN_ALLOWLIST is set on the running Caddy — IP trust was reintroduced (F-05)"
fi

echo
echo "── Image tags: pinned vs running ───────────────────────────────────────"
# Pinning in compose means nothing if the running container was started from a
# different tag before the pin landed.
while read -r name image; do
  case "$image" in
    *:latest) bad "$name is running :latest — never pin-free in production (CLAUDE.md §14)" ;;
    *)        printf '  ..    %-28s %s\n' "$name" "$image" ;;
  esac
done < <(remote 'docker ps --format "{{.Names}} {{.Image}}"' 2>/dev/null || true)

echo
if [ $checked -eq 0 ]; then
  echo "INCONCLUSIVE: nothing was verified — no platform container was reachable."
  echo "      This is NOT a pass. Run it on the host, or with --ssh <target>."
  exit 2
elif [ $fail -eq 0 ]; then
  echo "PASS: no drift detected across ${checked} checks against the running system"
else
  echo "FAIL: the repo does not describe the running system."
  echo "      Until this passes, treat the SERVER as the source of truth and do not"
  echo "      draw conclusions about security posture from files in this repo."
fi
exit $fail
