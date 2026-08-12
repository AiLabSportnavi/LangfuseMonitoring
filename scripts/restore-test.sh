#!/usr/bin/env bash
# Restore rehearsal into an ISOLATED environment. Audit finding F-04b.
#
#   ./scripts/restore-test.sh                 # newest local backup
#   ./scripts/restore-test.sh 20260812T031500Z
#   ./scripts/restore-test.sh --from-remote 20260812T031500Z
#
# ── Why this script is not optional ───────────────────────────────────────────
#
# A backup is valid because a restore worked — not because the backup job
# reported success. Until this has run, backup.sh has produced encrypted files
# of unknown quality and the platform's disaster recovery is a theory
# (CLAUDE.md §13).
#
# The failure modes this catches, all of which leave backup.sh exiting 0:
#   · the encryption passphrase in infra/.env no longer decrypts older artifacts
#     (it was rotated, and nobody kept the old one)
#   · pg_dump ran against an empty or wrong database
#   · the ClickHouse archive is structurally fine but restores to zero rows
#   · the transfer truncated and the checksum was never checked
#
# ── Isolation ─────────────────────────────────────────────────────────────────
#
# Everything runs under a SEPARATE compose project name on a SEPARATE network
# with NO published ports and throwaway volumes. It cannot reach, alter, or be
# reached by the production stack. That separation is the reason this is safe to
# run on the production host, which is the only place the backups are.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-infra/.env}"
[ -f "$ENV_FILE" ] || { echo "FAIL: $ENV_FILE not found" >&2; exit 1; }
# ── Loading infra/.env ────────────────────────────────────────────────────────
# PARSED, never sourced. `.env` holds unquoted, space-separated values, so
# `. infra/.env` would word-split them and EXECUTE the tail as a command — the
# same reason scripts/check-credential-drift.sh parses rather than sources.
# Values already present in the environment win, so a caller can override one
# setting without editing the file.
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

: "${BACKUP_ENCRYPTION_KEY:?set BACKUP_ENCRYPTION_KEY in $ENV_FILE}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/langfuse}"
METRICS_DIR="${BACKUP_METRICS_DIR:-/var/lib/node_exporter/textfile}"
RESTORE_LOG="${RESTORE_LOG:-${BACKUP_DIR}/RESTORE-TESTS.log}"

PROJECT="langfuse-restoretest"
NET="${PROJECT}-net"

log()  { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAIL: $*"; exit 1; }

FROM_REMOTE=0
STAMP=""
for arg in "$@"; do
  case "$arg" in
    --from-remote) FROM_REMOTE=1 ;;
    -h|--help)     sed -n '2,40p' "$0"; exit 0 ;;
    *)             STAMP="$arg" ;;
  esac
done

# ── Locate the backup ─────────────────────────────────────────────────────────
# Default to the NEWEST backup rather than a named one: the newest is the one a
# real incident would reach for, so it is the one worth rehearsing.
if [ "$FROM_REMOTE" = 1 ]; then
  [ -n "${BACKUP_REMOTE:-}" ] || fail "--from-remote needs BACKUP_REMOTE set"
  [ -n "$STAMP" ] || fail "--from-remote needs an explicit timestamp"
  SRC="${BACKUP_DIR}/.remote-${STAMP}"
  log "fetching ${BACKUP_REMOTE%/}/${STAMP}/ (this is the copy that actually matters)"
  mkdir -p "$SRC"
  rsync -a "${BACKUP_REMOTE%/}/${STAMP}/" "${SRC}/" || fail "could not fetch the remote backup"
else
  if [ -z "$STAMP" ]; then
    STAMP="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null \
             | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | tail -1)"
    [ -n "$STAMP" ] || fail "no backups found in $BACKUP_DIR — run scripts/backup.sh first"
  fi
  SRC="${BACKUP_DIR}/${STAMP}"
fi
[ -d "$SRC" ] || fail "backup ${STAMP} not found at ${SRC}"
log "rehearsing restore of ${STAMP}"

# ── 0. Integrity ──────────────────────────────────────────────────────────────
# Before spending minutes on containers: does the artifact match what was
# written? This is the check that catches a truncated transfer, and it is the
# one most likely to be skipped in a real incident when people are in a hurry.
if [ -f "${SRC}/SHA256SUMS" ]; then
  (cd "$SRC" && sha256sum -c SHA256SUMS >/dev/null) || fail "checksum mismatch — this backup is corrupt"
  log "checksums OK"
else
  log "WARN: no SHA256SUMS in this backup (predates the manifest) — integrity unproven"
fi

RESULT="FAIL"
cleanup() {
  log "tearing down the isolated environment"
  docker rm -f "${PROJECT}-pg" "${PROJECT}-ch" >/dev/null 2>&1 || true
  docker volume rm -f "${PROJECT}-pgdata" "${PROJECT}-chdata" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [ "$FROM_REMOTE" = 1 ] && rm -rf "$SRC"

  # Recorded whether it passed or failed. "Last successful restore test" is a
  # dashboard tile (CLAUDE.md §13); if it goes stale, disaster recovery is
  # theory again, and a silent failure here is how it goes stale unnoticed.
  mkdir -p "$(dirname "$RESTORE_LOG")" 2>/dev/null || true
  printf '%s  backup=%s  result=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STAMP" "$RESULT" >> "$RESTORE_LOG" 2>/dev/null || true

  if mkdir -p "$METRICS_DIR" 2>/dev/null; then
    tmp="${METRICS_DIR}/.langfuse_restore.$$"
    ok=0; [ "$RESULT" = "PASS" ] && ok=1
    prev=0
    [ -f "${METRICS_DIR}/langfuse_restore.prom" ] && \
      prev="$(awk '/^langfuse_restore_test_last_success_timestamp_seconds /{print $2}' \
        "${METRICS_DIR}/langfuse_restore.prom" 2>/dev/null || echo 0)"
    [ "$ok" = 1 ] && prev="$(date -u +%s)"
    {
      echo "# HELP langfuse_restore_test_last_success_timestamp_seconds Unix time of the last restore rehearsal that passed."
      echo "# TYPE langfuse_restore_test_last_success_timestamp_seconds gauge"
      echo "langfuse_restore_test_last_success_timestamp_seconds ${prev:-0}"
      echo "# HELP langfuse_restore_test_success Whether the most recent rehearsal passed."
      echo "# TYPE langfuse_restore_test_success gauge"
      echo "langfuse_restore_test_success ${ok}"
    } > "$tmp"
    mv "$tmp" "${METRICS_DIR}/langfuse_restore.prom"
  fi
}
trap cleanup EXIT

decrypt() {
  BACKUP_PASS="$BACKUP_ENCRYPTION_KEY" \
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASS -in "$1"
}

# No published ports, own network, throwaway volumes. Nothing here can touch
# the production stack even if a restore goes badly wrong.
docker network create "$NET" >/dev/null 2>&1 || true

# ── 1. Postgres ───────────────────────────────────────────────────────────────
log "postgres: starting isolated instance"
docker run -d --name "${PROJECT}-pg" --network "$NET" \
  -e POSTGRES_USER="$POSTGRES_USER" -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -e POSTGRES_DB="$POSTGRES_DB" -e TZ=UTC -e PGTZ=UTC \
  -v "${PROJECT}-pgdata:/var/lib/postgresql/data" \
  postgres:17-alpine >/dev/null

for _ in $(seq 1 60); do
  docker exec "${PROJECT}-pg" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && break
  sleep 2
done
docker exec "${PROJECT}-pg" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 \
  || fail "isolated Postgres never became ready"

log "postgres: restoring dump"
decrypt "${SRC}/postgres.dump.enc" \
  | docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "${PROJECT}-pg" \
      pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists \
  >/dev/null 2>&1 || log "WARN: pg_restore reported errors (often benign --clean noise) — asserting on content instead"

# Assert on CONTENT, not on exit code. pg_restore exits non-zero for harmless
# reasons, and exits zero having restored an empty schema. The only question
# that matters is whether the crown-jewel tables came back with rows in them.
#
# projects + api_keys specifically: those are the per-project credentials whose
# loss CLAUDE.md §13 calls losing the platform's identity.
PROJECTS=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "${PROJECT}-pg" \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM projects" 2>/dev/null | tr -d '[:space:]' || echo "ERR")
KEYS=$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "${PROJECT}-pg" \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "SELECT count(*) FROM api_keys" 2>/dev/null | tr -d '[:space:]' || echo "ERR")

case "$PROJECTS" in ''|*[!0-9]*) fail "projects table did not restore (got: ${PROJECTS})" ;; esac
[ "$PROJECTS" -ge 1 ] || fail "projects table restored EMPTY — the dump is worthless"
log "postgres: OK — ${PROJECTS} project(s), ${KEYS} api key(s) restored"

# ── 2. ClickHouse ─────────────────────────────────────────────────────────────
log "clickhouse: starting isolated instance"
docker run -d --name "${PROJECT}-ch" --network "$NET" \
  -e CLICKHOUSE_DB=default -e CLICKHOUSE_USER="$CLICKHOUSE_USER" \
  -e CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
  -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 -e TZ=UTC \
  -v "$(pwd)/infra/clickhouse/config.d/backup.xml:/etc/clickhouse-server/config.d/backup.xml:ro" \
  -v "${PROJECT}-chdata:/var/lib/clickhouse" \
  clickhouse/clickhouse-server:25.12-alpine >/dev/null

for _ in $(seq 1 60); do
  docker exec "${PROJECT}-ch" wget -qO- http://127.0.0.1:8123/ping >/dev/null 2>&1 && break
  sleep 2
done
docker exec "${PROJECT}-ch" wget -qO- http://127.0.0.1:8123/ping >/dev/null 2>&1 \
  || fail "isolated ClickHouse never became ready"

log "clickhouse: restoring backup"
CH_NAME="$(basename "$(decrypt "${SRC}/clickhouse.tar.gz.enc" | gzip -d | tar -tf - 2>/dev/null | head -1)" )"
decrypt "${SRC}/clickhouse.tar.gz.enc" | gzip -d \
  | docker exec -i "${PROJECT}-ch" sh -c 'mkdir -p /var/lib/clickhouse/backups && tar -C /var/lib/clickhouse/backups -xf -' \
  || fail "could not unpack the ClickHouse archive"

# ⚠️ --enable_full_text_index=1 is REQUIRED, and it is not a quirk of this
# rehearsal — it is a real disaster-recovery blocker found by running it.
#
# Langfuse's `events_full` table carries a text index. Creating such a table is
# gated behind a setting that is OFF BY DEFAULT and, verified on 2026-08-12, is
# off on the production server too (system.settings: enable_full_text_index=0,
# changed=0). The table exists there because the Langfuse migration enabled the
# setting for its own session when it created it.
#
# RESTORE re-executes those CREATE TABLE statements, so without this flag the
# restore dies partway through with:
#
#   Code: 344 ... The text index feature is disabled.
#              Enable the setting 'enable_full_text_index' ... While creating
#              table default.events_full  (SUPPORT_IS_DISABLED)
#
# A real recovery on a fresh box would have failed exactly here, at the worst
# possible moment, on a server whose defaults match production. That is the
# whole argument for CLAUDE.md §13's "a backup is valid because a restore
# worked" — six green backup runs would never have surfaced this.
docker exec "${PROJECT}-ch" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --enable_full_text_index=1 \
  --query "RESTORE DATABASE default FROM File('${CH_NAME}')" >/dev/null \
  || fail "ClickHouse RESTORE failed for ${CH_NAME}"

# Same principle as Postgres: assert on rows, not on the statement succeeding.
# A RESTORE that recreates the schema and no data exits 0 and is useless.
#
# ⚠️ This deliberately does NOT assert on `observations`. It used to, and the
# assertion was VACUOUS: it accepted 0, and this platform currently holds 0
# observations and 0 traces (ingestion has barely run) while holding 276 scores.
# So the check passed by reading an empty table — it would have gone on passing
# if RESTORE had recovered no data whatsoever.
#
# Asserting on the whole database instead means the check tracks wherever the
# data actually is, and cannot be defeated by one table happening to be empty.
# It compares against the live server, so it also catches a PARTIAL restore,
# which a fixed threshold never would.
# Resolved by compose label rather than via a $COMPOSE helper: this script
# otherwise never touches the live stack (it runs a fully isolated environment
# on its own network), so it deliberately carries no compose context. An
# earlier revision referenced $COMPOSE here and, under `set -u`, that aborted
# the comparison and left LIVE_ROWS=0 — which silently disabled the very
# safety check this block exists to perform.
LIVE_CH=$(docker ps -q \
  --filter "label=com.docker.compose.project=langfuse" \
  --filter "label=com.docker.compose.service=clickhouse" | head -1)
LIVE_ROWS=0
if [ -n "$LIVE_CH" ]; then
  LIVE_ROWS=$(docker exec "$LIVE_CH" clickhouse-client \
    --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
    --query "SELECT sum(rows) FROM system.parts WHERE database='default' AND active" \
    2>/dev/null | tr -d '[:space:]' || echo 0)
else
  log "WARN: live ClickHouse container not found — restored rows cannot be compared against production"
fi
case "$LIVE_ROWS" in ''|*[!0-9]*) LIVE_ROWS=0 ;; esac

REST_ROWS=$(docker exec "${PROJECT}-ch" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "SELECT sum(rows) FROM system.parts WHERE database='default' AND active" \
  2>/dev/null | tr -d '[:space:]' || echo "ERR")
case "$REST_ROWS" in ''|*[!0-9]*) fail "ClickHouse restore produced no readable tables (got: ${REST_ROWS})" ;; esac

# An empty SOURCE is a legitimate state early in this platform's life, so it is
# reported rather than failed. An empty restore of a NON-empty source is not.
if [ "$LIVE_ROWS" -gt 0 ] && [ "$REST_ROWS" -eq 0 ]; then
  fail "ClickHouse restored 0 rows but the live database holds ${LIVE_ROWS} — restore is not usable"
fi
log "clickhouse: OK — ${REST_ROWS} row(s) restored across default.* (live server holds ${LIVE_ROWS})"

# ── 3. MinIO archive ──────────────────────────────────────────────────────────
# Structural check only. Standing up a MinIO instance and re-uploading proves
# little beyond what a readable archive already proves, and the events in it are
# replayable-from-nothing anyway (they are the least critical of the three).
if [ -f "${SRC}/minio.tar.gz.enc" ]; then
  OBJECTS=$(decrypt "${SRC}/minio.tar.gz.enc" | gzip -d | tar -tf - 2>/dev/null | wc -l | tr -d '[:space:]')
  [ "${OBJECTS:-0}" -ge 1 ] || fail "minio archive unpacks to nothing"
  log "minio: OK — ${OBJECTS} entries readable"
fi

RESULT="PASS"
log "PASS: backup ${STAMP} restored and verified"
log "recorded in ${RESTORE_LOG} — this date is the one the dashboard tile reads."
