#!/usr/bin/env bash
set -euo pipefail

fail=0

# .env must never be tracked by git
if git ls-files --error-unmatch infra/.env >/dev/null 2>&1; then
  echo "FAIL: infra/.env is tracked by git"
  fail=1
else
  echo "PASS: infra/.env is not tracked"
fi

# .env.example must exist and contain no real-looking secrets
if [ ! -f infra/.env.example ]; then
  echo "FAIL: infra/.env.example missing"
  fail=1
else
  if grep -qE '^(NEXTAUTH_SECRET|SALT|ENCRYPTION_KEY)=.{16,}$' infra/.env.example; then
    echo "FAIL: infra/.env.example contains a real-looking secret"
    fail=1
  else
    echo "PASS: infra/.env.example has no real secrets"
  fi
fi

# v4 mandates a media upload bucket in addition to the event upload bucket.
if [ -f infra/.env.example ]; then
  if grep -q '^LANGFUSE_S3_MEDIA_UPLOAD_BUCKET=' infra/.env.example; then
    echo "PASS: media upload bucket configured"
  else
    echo "FAIL: LANGFUSE_S3_MEDIA_UPLOAD_BUCKET missing (required by Langfuse v4)"
    fail=1
  fi
fi

exit $fail
