#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
s="scripts/provision-project.sh"

[ -x "$s" ] || { echo "FAIL: $s missing or not executable"; exit 1; }
bash -n "$s" || { echo "FAIL: syntax error in $s"; exit 1; }

fail=0
grep -q "LANGFUSE_INIT_PROJECT_RETENTION" "$s" \
  || { echo "FAIL: retention must be set at provisioning time"; fail=1; }

# One key pair per project. A shared org-wide key cannot be revoked in isolation
# and makes per-project ingestion attribution impossible.
grep -q "LANGFUSE_INIT_PROJECT_PUBLIC_KEY" "$s" \
  || { echo "FAIL: must provision a per-project public key"; fail=1; }
grep -q "LANGFUSE_INIT_PROJECT_SECRET_KEY" "$s" \
  || { echo "FAIL: must provision a per-project secret key"; fail=1; }

# Re-running for an existing project must not silently mint a second key pair.
grep -q "already provisioned\|already exists" "$s" \
  || { echo "FAIL: must guard against re-provisioning an existing project"; fail=1; }

[ $fail -eq 0 ] && echo "PASS: provisioning script contract satisfied"
exit $fail
