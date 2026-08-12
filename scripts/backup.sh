#!/usr/bin/env bash
# Encrypted, off-host backup of the Tier 1 stack. Audit finding F-04.
#
#   ./scripts/backup.sh                 # full run: dump, encrypt, ship, prune
#   ./scripts/backup.sh --dry-run       # show what would happen, touch nothing
#   ./scripts/backup.sh --local-only    # skip the off-host copy (see the warning)
#
# Runs ON THE HOST, from the repo root, with the stack up.
#
# ── What gets backed up, and why in this order ────────────────────────────────
#
#   1. Postgres     — THE CROWN JEWEL (CLAUDE.md §13). It holds every project
#                     API key, every org, every user and the platform's
#                     identity. Losing ClickHouse costs trace history; losing
#                     Postgres costs the platform. It is dumped first so that a
#                     partial run still produces the artifact that matters most.
#   2. ClickHouse   — trace and observation history. Large, and reconstructible
#                     only from the agents that no longer hold the data.
#   3. MinIO        — raw ingestion events and multimodal payloads.
#
#   Valkey is deliberately NOT backed up. It holds in-flight queued events, and
#   CLAUDE.md requirement 10 already accepts their loss ("best-effort,
#   non-blocking"). Backing up a queue mid-flight produces a snapshot that is
#   wrong the instant it is taken.
#
# ── The rule this script exists to serve ──────────────────────────────────────
#
#   A backup is not valid because this script exited 0. It is valid because a
#   restore worked. scripts/restore-test.sh is the other half and it is not
#   optional — run it on the schedule in docs/OPERATIONS.md and record the date.
#
# ── Alerting ──────────────────────────────────────────────────────────────────
#
# Every run writes Prometheus metrics to the node-exporter textfile directory,
# so a FAILED OR ABSENT backup is alertable rather than merely logged. That is
# the point: a backup job nobody watches is indistinguishable from no backup,
# which is exactly the state the audit found. See infra/prometheus/rules/.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
ENV_FILE="${ENV_FILE:-infra/.env}"

DRY_RUN=0
LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --local-only) LOCAL_ONLY=1 ;;
    -h|--help)    sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAIL: $*"; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then log "[dry-run] $*"; else eval "$@"; fi; }

# ── Configuration: infra/.env is PARSED, never sourced ────────────────────────
# Read from infra/.env so there is exactly one place credentials live.
#
# `.env` holds unquoted, space-separated values, so
# `. infra/.env` would word-split them and EXECUTE the tail as a command — the
# same reason scripts/check-credential-drift.sh parses rather than sources.
# Values already present in the environment win, so a caller can override one
# setting without editing the file.
[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found — run from the repo root on the host"
load_env() {
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; *=*) ;; *) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in *[!A-Za-z0-9_]*) continue ;; esac
    eval "export $key=\"\$val\""
  # CR stripped at the source rather than per line: the file may have been
  # edited on Windows, and a trailing CR silently poisons every value.
  done < <(tr -d '\r' < "$1")
}
load_env "$ENV_FILE"

: "${POSTGRES_USER:?missing from $ENV_FILE}"
: "${POSTGRES_DB:?missing from $ENV_FILE}"
: "${CLICKHOUSE_USER:?missing from $ENV_FILE}"
: "${CLICKHOUSE_PASSWORD:?missing from $ENV_FILE}"
: "${MINIO_ROOT_USER:?missing from $ENV_FILE}"
: "${MINIO_ROOT_PASSWORD:?missing from $ENV_FILE}"

# The passphrase that encrypts every artifact.
#
# ⚠️ STORE THIS SOMEWHERE THE BOX IS NOT. It is in infra/.env, which lives on
# the machine being backed up — so if the box is lost, so is the only copy of
# the key, and the backups are permanently unreadable. A backup you cannot
# decrypt is not a backup. Put it in the team password manager TODAY, and
# record where in docs/OPERATIONS.md.
: "${BACKUP_ENCRYPTION_KEY:?set BACKUP_ENCRYPTION_KEY in $ENV_FILE — generate with: openssl rand -hex 32}"
[ "${#BACKUP_ENCRYPTION_KEY}" -ge 32 ] || fail "BACKUP_ENCRYPTION_KEY must be at least 32 characters"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/langfuse}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
# rsync-over-SSH destination, e.g. u123456@u123456.your-storagebox.de:langfuse/
# Hetzner Storage Box is EU and is the intended target (CLAUDE.md §5.3, §13).
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
METRICS_DIR="${BACKUP_METRICS_DIR:-/var/lib/node_exporter/textfile}"

COMPOSE="docker compose -f infra/compose.yaml --env-file $ENV_FILE"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="${BACKUP_DIR}/${STAMP}"

# ── Off-host is not optional ──────────────────────────────────────────────────
# A backup on the same NVMe as the database protects against exactly one
# failure mode — "someone dropped a table" — and none of the ones that destroy
# a box. --local-only exists for the restore rehearsal, not for production.
if [ -z "$BACKUP_REMOTE" ] && [ "$LOCAL_ONLY" != 1 ]; then
  fail "BACKUP_REMOTE is unset. A backup that never leaves 5.9.95.174 does not survive
      losing 5.9.95.174. Set BACKUP_REMOTE in $ENV_FILE, or pass --local-only if you
      are deliberately rehearsing and accept that this run protects nothing."
fi

# ── Metrics: written on EVERY exit path, success or failure ───────────────────
# The failure metric matters more than the success metric. An alert wired only
# to "success is old" cannot distinguish a broken job from a deleted one; both
# must page, which is why last_success_timestamp is written even on failure
# (carried forward from the previous run) alongside an explicit success flag.
BACKUP_OK=0
write_metrics() {
  [ "$DRY_RUN" = 1 ] && return 0
  mkdir -p "$METRICS_DIR" 2>/dev/null || return 0
  local tmp="${METRICS_DIR}/.langfuse_backup.$$"
  local now; now="$(date -u +%s)"
  local prev=0
  [ -f "${METRICS_DIR}/langfuse_backup.prom" ] && \
    prev="$(awk '/^langfuse_backup_last_success_timestamp_seconds /{print $2}' \
      "${METRICS_DIR}/langfuse_backup.prom" 2>/dev/null || echo 0)"
  [ "$BACKUP_OK" = 1 ] && prev="$now"

  {
    echo "# HELP langfuse_backup_last_success_timestamp_seconds Unix time of the last backup that completed fully."
    echo "# TYPE langfuse_backup_last_success_timestamp_seconds gauge"
    echo "langfuse_backup_last_success_timestamp_seconds ${prev:-0}"
    echo "# HELP langfuse_backup_last_run_timestamp_seconds Unix time of the last attempt, successful or not."
    echo "# TYPE langfuse_backup_last_run_timestamp_seconds gauge"
    echo "langfuse_backup_last_run_timestamp_seconds ${now}"
    echo "# HELP langfuse_backup_success Whether the most recent attempt succeeded."
    echo "# TYPE langfuse_backup_success gauge"
    echo "langfuse_backup_success ${BACKUP_OK}"
    echo "# HELP langfuse_backup_size_bytes Size of the most recent artifact set."
    echo "# TYPE langfuse_backup_size_bytes gauge"
    echo "langfuse_backup_size_bytes $(du -sb "$WORK" 2>/dev/null | cut -f1 || echo 0)"
  } > "$tmp"
  # Atomic rename: node-exporter reads this directory continuously, and a
  # half-written .prom file makes the whole scrape error out.
  mv "$tmp" "${METRICS_DIR}/langfuse_backup.prom"
}
trap write_metrics EXIT

# ── Encryption helper ─────────────────────────────────────────────────────────
# AES-256 with PBKDF2 at a high iteration count. openssl is chosen over age/gpg
# purely because it is already on every host this will ever run on — one fewer
# dependency between an outage and a restore.
#
# The passphrase is passed via the environment, never as an argument: process
# arguments are world-readable in /proc on a shared host.
encrypt_to() {
  local dest="$1"
  BACKUP_PASS="$BACKUP_ENCRYPTION_KEY" \
    openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_PASS -out "$dest"
}

log "backup ${STAMP} → ${WORK}"
run "mkdir -p '$WORK'"
# 700 before anything is written into it: these artifacts contain every
# credential the platform holds.
run "chmod 700 '$WORK'"

# ── 1. Postgres ───────────────────────────────────────────────────────────────
# Custom format (-Fc): compressed, and restorable selectively with pg_restore,
# which is what makes a partial recovery possible without replaying everything.
log "postgres: pg_dump"
if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] pg_dump -> ${WORK}/postgres.dump.enc"
else
  $COMPOSE exec -T postgres \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-password \
    | encrypt_to "${WORK}/postgres.dump.enc"
  # 1 KiB floor, not `-s`: openssl emits ~48 bytes for empty input, so a
  # non-zero size proves nothing about whether pg_dump produced any data.
  PG_BYTES=$(stat -c %s "${WORK}/postgres.dump.enc" 2>/dev/null || echo 0)
  [ "$PG_BYTES" -gt 1024 ] || \
    fail "postgres dump is ${PG_BYTES} bytes — refusing to call this a backup"
fi

# ── 2. ClickHouse ─────────────────────────────────────────────────────────────
# Native BACKUP, not a SELECT dump: it is consistent across tables and it is the
# form RESTORE understands. Requires infra/clickhouse/config.d/backup.xml.
#
# The backup is written inside the container, tarred out, then DELETED from the
# container — leaving it in place would consume the same NVMe budget as the data
# it protects and make the disk-exhaustion risk worse.
log "clickhouse: BACKUP DATABASE default"
CH_BACKUP="backup_${STAMP}"
if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] BACKUP DATABASE default TO File('${CH_BACKUP}')"
else
  $COMPOSE exec -T clickhouse clickhouse-client \
    --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
    --query "BACKUP DATABASE default TO File('${CH_BACKUP}')" >/dev/null \
    || fail "ClickHouse BACKUP failed — is infra/clickhouse/config.d/backup.xml mounted?"

  $COMPOSE exec -T clickhouse \
    tar -C /var/lib/clickhouse/backups -cf - "$CH_BACKUP" \
    | gzip -6 | encrypt_to "${WORK}/clickhouse.tar.gz.enc"
  # Same 1 KiB floor and same reason as the postgres check above.
  CH_BYTES=$(stat -c %s "${WORK}/clickhouse.tar.gz.enc" 2>/dev/null || echo 0)
  [ "$CH_BYTES" -gt 1024 ] || fail "clickhouse archive is ${CH_BYTES} bytes — empty, not a backup"

  # Reclaim the space immediately. Not deferred to the prune step: a failure
  # between here and there would leave it on disk indefinitely.
  $COMPOSE exec -T clickhouse rm -rf "/var/lib/clickhouse/backups/${CH_BACKUP}" || \
    log "WARN: could not remove in-container ClickHouse backup ${CH_BACKUP} — check disk"
fi

# ── 3. MinIO ──────────────────────────────────────────────────────────────────
# Raw ingestion events and media, archived from the DATA VOLUME rather than
# through `mc`.
#
# ⚠️ The previous implementation ran `mc mirror` into /tmp inside the MinIO
# container and then `tar`red it out. It could never have worked: the
# minio/minio image ships `mc` but NOT `tar`. Verified on 2026-08-12 —
# the step died with `sh: line 3: tar: command not found`, which is also the
# first time this script had ever been run against the live stack.
#
# Archiving the volume instead is both simpler and strictly better: it captures
# every bucket plus `.minio.sys` (bucket policies, versioning config), whereas
# mirroring one bucket captured only that bucket's objects. It also needs no
# credentials, so a rotated MINIO_ROOT_PASSWORD cannot silently break backups.
#
# The helper is postgres:17-alpine, an image this deployment ALREADY pins and
# pulls, chosen over alpine:3 so the backup path introduces no new supply-chain
# dependency and no floating tag (CLAUDE.md §14: never `latest`, pin versions).
# It is used purely as a source of busybox `tar`; nothing Postgres runs.
#
# Read-only mount: a backup job must never be able to mutate the data it backs
# up. MinIO stays running — object stores tolerate this because objects are
# written whole, so a concurrent write yields either the old object or the new
# one, never a torn one.
log "minio: archive data volume"
MINIO_VOLUME="$($COMPOSE ps -q minio 2>/dev/null | head -1 | xargs -r docker inspect \
  --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null)"
if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] tar minio volume -> ${WORK}/minio.tar.gz.enc"
else
  [ -n "$MINIO_VOLUME" ] || fail "could not resolve the MinIO /data volume name"
  docker run --rm -v "${MINIO_VOLUME}:/data:ro" postgres:17-alpine \
    tar -C /data -cf - . \
    | gzip -6 | encrypt_to "${WORK}/minio.tar.gz.enc"

  # NOT `-s`. openssl emits a 48-byte header+padding block for EMPTY input, so
  # `-s` (non-zero size) passes on a completely failed archive — which is
  # exactly how the broken `mc`/tar step above reported success-shaped output
  # while capturing nothing. Anything under 1 KiB here is an empty tar, not a
  # real bucket, so it is treated as a failure rather than a quiet no-op.
  MINIO_BYTES=$(stat -c %s "${WORK}/minio.tar.gz.enc" 2>/dev/null || echo 0)
  [ "$MINIO_BYTES" -gt 1024 ] || \
    fail "minio archive is ${MINIO_BYTES} bytes — that is an empty archive, not a backup"
fi

# ── Manifest ──────────────────────────────────────────────────────────────────
# Checksums are what let restore-test.sh prove it restored THIS backup and not a
# truncated copy that transferred without error.
if [ "$DRY_RUN" != 1 ]; then
  (cd "$WORK" && sha256sum ./*.enc > SHA256SUMS)
  cat > "${WORK}/MANIFEST.txt" <<EOF
langfuse backup ${STAMP}
host          $(hostname)
langfuse      4.6.0
postgres      17-alpine   ${POSTGRES_DB}
clickhouse    25.12-alpine  database=default
minio         bucket=${LANGFUSE_S3_EVENT_UPLOAD_BUCKET:-langfuse}
encryption    openssl aes-256-cbc, pbkdf2, 600000 iterations
restore       ./scripts/restore-test.sh ${STAMP}
EOF
  chmod 600 "$WORK"/* 2>/dev/null || true
fi

# ── Off-host copy ─────────────────────────────────────────────────────────────
if [ -n "$BACKUP_REMOTE" ]; then
  log "shipping to ${BACKUP_REMOTE}"
  run "rsync -a --partial --timeout=1800 '${WORK}/' '${BACKUP_REMOTE%/}/${STAMP}/'" \
    || fail "off-host copy failed — the artifacts exist locally but protect nothing yet"
else
  log "WARN: --local-only — this run protects against a dropped table, not a lost box"
fi

# ── Prune ─────────────────────────────────────────────────────────────────────
# Local only. Remote retention is the storage target's job: pruning the remote
# from the machine being backed up means a compromise of that machine can erase
# its own backups, which is the ransomware failure mode.
log "pruning local backups older than ${BACKUP_RETENTION_DAYS} days"
run "find '$BACKUP_DIR' -mindepth 1 -maxdepth 1 -type d -mtime +${BACKUP_RETENTION_DAYS} -exec rm -rf {} +"

BACKUP_OK=1
log "PASS: backup ${STAMP} complete$([ -n "$BACKUP_REMOTE" ] && echo ' and shipped off-host')"
log "REMINDER: this is not verified until scripts/restore-test.sh has restored it."
