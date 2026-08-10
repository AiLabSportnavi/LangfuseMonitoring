#!/usr/bin/env bash
# Generates infra/.env from infra/.env.example with real random secrets.
# Refuses to overwrite an existing .env — rotation is a deliberate act, not an accident.
set -euo pipefail

cd "$(dirname "$0")/.."

target="infra/.env"
[ -f "$target" ] && { echo "ERROR: $target already exists. Refusing to overwrite."; exit 1; }

# 32 bytes = 256 bits, which is what ENCRYPTION_KEY requires.
gen() { openssl rand -hex 32; }

pg_pw=$(gen); ch_pw=$(gen); redis_pw=$(gen); minio_pw=$(gen)
nextauth=$(gen); salt=$(gen); enc=$(gen); init_pw=$(gen)

sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pg_pw}|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://langfuse:${pg_pw}@postgres:5432/langfuse|" \
  -e "s|^CLICKHOUSE_PASSWORD=.*|CLICKHOUSE_PASSWORD=${ch_pw}|" \
  -e "s|^REDIS_AUTH=.*|REDIS_AUTH=${redis_pw}|" \
  -e "s|^REDIS_CONNECTION_STRING=.*|REDIS_CONNECTION_STRING=redis://default:${redis_pw}@redis:6379|" \
  -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=${minio_pw}|" \
  -e "s|^LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=.*|LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=${minio_pw}|" \
  -e "s|^LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY=.*|LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY=${minio_pw}|" \
  -e "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=${nextauth}|" \
  -e "s|^SALT=.*|SALT=${salt}|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${enc}|" \
  -e "s|^LANGFUSE_INIT_USER_PASSWORD=.*|LANGFUSE_INIT_USER_PASSWORD=${init_pw}|" \
  infra/.env.example > "$target"

chmod 600 "$target"

# A leftover CHANGEME on an assignment line means .env.example gained a secret this
# script does not know how to fill. Fail loudly rather than shipping a placeholder
# password. Comments mentioning CHANGEME are ignored.
if grep -qE '^[A-Za-z_][A-Za-z0-9_]*=.*CHANGEME' "$target"; then
  echo "ERROR: unfilled CHANGEME remains in $target:"
  grep -nE '^[A-Za-z_][A-Za-z0-9_]*=.*CHANGEME' "$target"
  rm -f "$target"
  exit 1
fi

echo "Generated $target (mode 600)."
echo "Now set NEXTAUTH_URL, LANGFUSE_DOMAIN, ACME_EMAIL and ADMIN_ALLOWLIST to real values."
