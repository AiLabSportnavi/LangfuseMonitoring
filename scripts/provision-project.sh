#!/usr/bin/env bash
# Provision one Langfuse project with its own API key pair, via headless init.
#
# Headless initialization creates resources at web-container startup if they do
# not already exist. It provisions ONE org/project per startup, so this script
# rewrites the per-project block in infra/.env and restarts web.
#
# Never a shared org-wide credential: one key pair per agent project so a leaked
# key is revocable in isolation and ingestion is attributable per project.
#
# Usage: ./scripts/provision-project.sh <project-slug> [retention-days]
set -euo pipefail

slug="${1:?usage: provision-project.sh <project-slug> [retention-days]}"
retention="${2:-90}"

case "$slug" in
  *[!a-z0-9-]*|"") echo "ERROR: slug must be lowercase alphanumeric with hyphens"; exit 1 ;;
esac

cd "$(dirname "$0")/../infra"
[ -f .env ] || { echo "ERROR: infra/.env missing. Run ./scripts/generate-secrets.sh first."; exit 1; }

# Re-running must not silently mint a second key pair for a project that already
# has one — the old keys would keep working and become untracked.
if grep -q "^# --- project: ${slug} ---$" .env; then
  echo "ERROR: project '${slug}' is already provisioned in infra/.env."
  echo "       To rotate its keys, remove that block deliberately and re-run."
  exit 1
fi

pk="pk-lf-$(openssl rand -hex 16)"
sk="sk-lf-$(openssl rand -hex 16)"

# Only one LANGFUSE_INIT_PROJECT_* set may be active at a time, so strip any
# previous project's block before appending this one. The commented record of
# past provisioning stays for auditability.
tmp=$(mktemp)
grep -v '^LANGFUSE_INIT_PROJECT_' .env > "$tmp"
mv "$tmp" .env
chmod 600 .env

cat >> .env <<EOF

# --- project: ${slug} ---
# provisioned $(date -u +%F) — retention ${retention}d
LANGFUSE_INIT_PROJECT_ID=${slug}
LANGFUSE_INIT_PROJECT_NAME=${slug}
LANGFUSE_INIT_PROJECT_RETENTION=${retention}
LANGFUSE_INIT_PROJECT_PUBLIC_KEY=${pk}
LANGFUSE_INIT_PROJECT_SECRET_KEY=${sk}
EOF

docker compose up -d --force-recreate web
echo "waiting for web to become ready..."
timeout 180 docker compose exec -T web sh -c \
  'until wget -qO- http://127.0.0.1:3000/api/public/ready >/dev/null 2>&1; do sleep 2; done' \
  || { echo "ERROR: web did not become ready. Check: docker compose logs web"; exit 1; }

cat <<EOF

Project '${slug}' provisioned with ${retention}-day retention.

  LANGFUSE_PUBLIC_KEY=${pk}
  LANGFUSE_SECRET_KEY=${sk}

Store these in the Vercel project's environment variables, per environment.
They are also in infra/.env, which is gitignored and mode 600.

Verify the pipeline end to end before handing them over:
  LANGFUSE_PUBLIC_KEY=${pk} LANGFUSE_SECRET_KEY=${sk} \\
    ./scripts/ingestion-canary.sh https://\$LANGFUSE_DOMAIN
EOF
