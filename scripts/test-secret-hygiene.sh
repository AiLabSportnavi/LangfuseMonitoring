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

# No secret-bearing env file is one `git add -A` from being published.
#
# Checking only "infra/.env is not tracked" leaves the real gap: a COPY landing
# somewhere else. A backup taken before a config change, or a script whose
# relative path resolved against the wrong working directory, produces a file
# holding every production secret that is untracked, unignored, and invisible to
# the check above. Both have happened in this repo.
#
# git ls-files -o lists untracked files; --exclude-standard drops the ones
# .gitignore already covers. Anything env-shaped left in that list is exposed.
exposed=$(git ls-files -o --exclude-standard \
  | grep -E '(^|/)\.env($|\.)' \
  | grep -vE '\.env\.example$' || true)

if [ -n "$exposed" ]; then
  echo "FAIL: env file(s) untracked AND unignored — 'git add -A' would commit them:"
  printf '        %s\n' $exposed
  echo "      Add a matching pattern to .gitignore, or move the file out of the repo."
  fail=1
else
  echo "PASS: no unignored env files loose in the working tree"
fi

exit $fail
