# Security checklist — re-runnable audit

Companion to [`AUDIT-2026-08-12.md`](AUDIT-2026-08-12.md). Run this to confirm findings are closed and
to catch regressions. Every item states **the command** and **the expected result**, so "pass" means
observed behaviour, not a config file that looks right.

**The rule that makes this checklist worth anything:**

> A control is verified only when it has been observed from **outside** the system, from a vantage that
> is **not** on any allowlist. Reading the config proves intent, not state. Finding F-01 was invisible
> to six passing config tests and to every check run from the operator's own machine.

**Before you start — establish an off-allowlist vantage.** Your own connection is likely allowlisted.
Use one of: mobile hotspot / tethering · a cheap VPS · a CI runner · any online HTTP-request tool.
Confirm it first:

```bash
curl -s https://api.ipify.org        # must NOT appear in ADMIN_ALLOWLIST
```

Legend: `[E]` must run from the **external** vantage · `[H]` requires **host** (SSH) access ·
`[L]` runs **locally** in the repo.

---

## A. Exposure and network

| # | Check | Command | Pass condition | Finding |
|---|---|---|---|---|
| A0 | **[E] Run the whole behavioural probe first** | `bash scripts/test-exposure.sh https://sportnavi-langfuse.sportnavi.de https://deploy-ui.sportnavi.de` | `PASS` — and it prints the vantage IP it used, which is the number that decides whether the result means anything | **F-01, F-06** |
| A1 | Only 22/80/443 open | `for p in 22 80 443 2019 3000 3030 5432 6379 8123 9000 9001 9090 9115 9121 9187 9363; do timeout 4 bash -c "echo > /dev/tcp/5.9.95.174/$p" 2>/dev/null && echo "$p OPEN" \|\| echo "$p closed"; done` | Only 22, 80, 443 OPEN | — |
| A2 | **[E] Grafana serves no application data** | `curl -s https://deploy-ui.sportnavi.de/api/health` | **Any JSON containing `"version"` is a FAIL** — that response came from grafana:3000. After the SSO cut-over expect a redirect to Microsoft, not `Not authorized`: the allowlist is gone, so a 403 is no longer the target state | **F-01** |
| A3 | **[E] Grafana login redirects to Entra** | `curl -sI https://deploy-ui.sportnavi.de/login \| grep -i location` | `login.microsoftonline.com`. **A password form is a FAIL** | **F-01** |
| A4 | **[E] Langfuse REST needs a key** | `curl -s -o /dev/null -w '%{http_code}\n' https://sportnavi-langfuse.sportnavi.de/api/public/v2/prompts` | `401` (not 200) | — |
| A5 | **[E] Health endpoints stay public** | `curl -s https://sportnavi-langfuse.sportnavi.de/api/public/health` | `{"status":"OK",...}` | — |
| A6 | HTTP redirects to HTTPS | `curl -s -o /dev/null -w '%{http_code}\n' http://sportnavi-langfuse.sportnavi.de/` | `308` | — |
| A7 | `ADMIN_ALLOWLIST` retired **everywhere** | `grep -rc ADMIN_ALLOWLIST infra/caddy/Caddyfile infra/compose.yaml infra/.env` `[L]` | `0` in all three. It is retired, not narrowed — a "safer" list is still IP trust | **F-05** |
| A8 | **[H]** Deployed config matches repo | `bash scripts/check-config-drift.sh` (or `--ssh <target>`) | `PASS`. **Exit 2 / `INCONCLUSIVE` is not a pass** — it means nothing was reachable to check | **F-07** |
| A9 | **[H]** Firewall agrees with A1 | `ufw status verbose` | only 22/80/443 allowed | — |

---

## B. Authentication and authorisation

| # | Check | Command | Pass condition | Finding |
|---|---|---|---|---|
| B1 | **Password login disabled** | `bash scripts/test-exposure.sh <langfuse-url>` (it does the CSRF-token POST) | `PASS  password login refused`. ⚠️ **Do NOT use `/api/auth/providers`** — it lists REGISTERED providers, not enforcement, and reading it as evidence is the error that produced and then withdrew F-03 | **F-03** |
| B2 | Seed account retired | `grep -E '^LANGFUSE_INIT_USER_(EMAIL\|PASSWORD)=.+' infra/.env` `[L]` | no output (both blank) | **F-03** |
| B3 | Password login switch set | `grep '^AUTH_DISABLE_USERNAME_PASSWORD=' infra/.env` `[L]` | `=true` | **F-03** |
| B4 | Org creation restricted | `bash scripts/check-config-drift.sh` `[H]` | non-empty **on the running container**. An empty value means ANY authenticated user may create an org — that is not the same as nobody | **F-02** |
| B5 | **[E] Sign-up not usable** | `curl -s https://sportnavi-langfuse.sportnavi.de/auth/sign-up \| head -c 400` | SSO-only page, or 403. Registration form = FAIL | **F-02** |
| B6 | Entra app is single-tenant | `bash scripts/test-entra-app.sh <manifest.json>` `[L]` | `signInAudience: AzureADMyOrg` | — |
| B7 | Grafana SSO enabled | `grep '^GRAFANA_SSO_ENABLED=' infra/.env` `[L]` | `=true` | **F-01** |
| B8 | Grafana tenant pinned | `grep '^GRAFANA_AZURE_AD_CLIENT_ID=' infra/.env` `[L]` | non-empty; `GF_AUTH_AZUREAD_ALLOWED_ORGANIZATIONS` set to the tenant id | **F-01** |
| B9 | Grafana anonymous access off | `grep -A2 GF_AUTH_ANONYMOUS_ENABLED infra/compose.monitoring.yaml` `[L]` | `"false"` | — |
| B10 | Grafana admin password strong | `awk -F= '/^GRAFANA_ADMIN_PASSWORD=/{print length($2)}' infra/.env` `[L]` | `64` | — |
| B11 | **[H]** SSH hardened | `sshd -T \| grep -E 'permitrootlogin\|passwordauthentication'` | `permitrootlogin no`, `passwordauthentication no` | — |
| B12 | Agent channel auth is real | `grep placeholderAuth examples/eve-langfuse-poc/agent/channels/eve.ts` `[L]` | absent in any project onboarded for real use | **F-11** |

---

## C. Secrets

| # | Check | Command | Pass condition | Finding |
|---|---|---|---|---|
| C1 | Repo secret hygiene suite | `bash scripts/test-secret-hygiene.sh` `[L]` | all PASS | — |
| C2 | Nothing secret tracked | `git ls-files \| grep -iE '\.env$\|\.env\.local\|settings\.local'` `[L]` | no output | — |
| C3 | **Full history clean** | `git rev-list --all \| while read c; do git grep -nIE '(sk-lf-[A-Za-z0-9]{16,}\|AKIA[0-9A-Z]{16}\|ghp_[A-Za-z0-9]{30,})' $c 2>/dev/null; done` `[L]` | no output | — |
| C4 | MCP key not in repo tree | `grep -r LANGFUSE_MCP_AUTH .claude/ examples/*/.claude/ 2>/dev/null` `[L]` | no literal base64 value — env/keychain only | **F-08** |
| C5 | MCP key rotated since 2026-08-12 | rotation log / Langfuse project settings | rotation date recorded | **F-08** |
| C6 | **[H]** env file permissions | `stat -c '%a %n' infra/.env*` | every file `600` | **F-20** |
| C7 | No stale secret backups | `ls infra/.env.bak-* 2>/dev/null` `[L]` | none, or each justified and mode 600 | **F-20** |
| C8 | Every credential is 256-bit | `awk -F= '/PASSWORD=\|SECRET=\|_AUTH=\|^SALT=\|^ENCRYPTION_KEY=/{if(length($2)<32) print "WEAK: " $1}' infra/.env` `[L]` | no output | — |

---

## D. Data protection and backups

| # | Check | Command | Pass condition | Finding |
|---|---|---|---|---|
| D0 | **Backup tooling is scheduled at all** | `crontab -l \| grep backup.sh` `[H]` | a daily entry exists. The scripts existing in the repo is **not** the same as backups happening | **F-04** |
| D1 | **Postgres backup exists and is recent** | `ls -la /var/backups/langfuse/*/postgres.dump.enc \| tail -1` `[H]` | artifact < 24h old | **F-04** |
| D2 | ClickHouse backup exists | inspect backup target | artifact < 24h old | **F-04** |
| D3 | Blob storage protected | MinIO replication/versioning config | enabled | **F-04** |
| D4 | Backups are off-host and encrypted | inspect destination | not on `5.9.95.174`; encrypted at rest; EU region | **F-04** |
| D5 | **Restore actually tested** | `bash scripts/restore-test.sh` `[H]`, or read `/var/backups/langfuse/RESTORE-TESTS.log` | a real restore passed **within 90 days**. Quarterly, run it `--from-remote` — the off-host copy is the one an incident uses | **F-04** |
| D6 | Backup failure alerts | `promtool check rules infra/prometheus/rules/backups.yml` `[L]`, then Prometheus → Alerts | 4 rules load, including `BackupMetricsMissing` (fires when the metric is ABSENT — a deleted cron job). ⚠️ **Rules without Alertmanager page nobody** | **F-04**, **F-12** |
| D7 | Retention enforced, not just stated | `grep LANGFUSE_INIT_PROJECT_RETENTION infra/.env` `[L]` | set per project, **or** a documented deletion job exists (retention policies are EE) | — |
| D8 | PII assumption re-validated | onboarding record for each project | "no real PII" reconfirmed, or `recordInputs/Outputs` disabled | — |

---

## E. Containers and infrastructure

| # | Check | Command | Pass condition | Finding |
|---|---|---|---|---|
| E1 | Only Caddy publishes ports | `bash scripts/test-monitoring-config.sh` `[L]` | PASS on the ports assertion | — |
| E2 | Compose parses | `bash scripts/test-compose-config.sh` `[L]` | all PASS | — |
| E3 | No `:latest` anywhere | `grep -rn 'image:.*latest' infra/` `[L]` | no output | — |
| E4 | cAdvisor privilege dropped **and still working** | `grep -n 'privileged' infra/compose.monitoring.yaml` `[L]`, then Grafana → Containers | no `privileged: true`, **and the container/OOM panels still populate**. Half of this check is the panels — an unprivileged cAdvisor that silently stopped exporting is worse than a privileged one | **F-09** |
| E5 | ClickHouse TTLs active | `bash scripts/test-clickhouse-ttl.sh` `[L]` | all PASS | — |
| E6 | Valkey still `noeviction` | `grep -n 'maxmemory-policy' infra/compose.yaml` `[L]` | `noeviction` | — |
| E7 | Rate-limit module linked in | `docker exec langfuse-caddy-1 caddy list-modules \| grep rate_limit` `[H]` | `http.handlers.rate_limit` present | — |
| E8 | Resource limits set | `grep -n 'resources:' infra/compose*.yaml` `[L]` | present on at least web, worker, cadvisor | — |

---

## F. TLS and headers

| # | Check | Command | Pass condition | Finding |
|---|---|---|---|---|
| F1 | Certs valid > 21 days | `echo \| openssl s_client -servername sportnavi-langfuse.sportnavi.de -connect sportnavi-langfuse.sportnavi.de:443 2>/dev/null \| openssl x509 -noout -dates` | `notAfter` more than 21 days out (repeat for `deploy-ui`) | **F-14** |
| F2 | Expiry monitored automatically | `bash scripts/health-check.sh https://sportnavi-langfuse.sportnavi.de` | prints `cert=... expires in Nd`, fails under 21d. Also confirm `infra/prometheus/targets/edge.json` exists `[H]`, or the Prometheus rule is inert | **F-14** |
| F3 | Legacy TLS refused | `for p in tls1 tls1_1; do echo \| openssl s_client -$p -connect sportnavi-langfuse.sportnavi.de:443 2>&1 \| grep -c 'Cipher is (NONE)'; done` | both non-zero (refused) | — |
| F4 | Security headers present | `curl -sI https://sportnavi-langfuse.sportnavi.de/ \| grep -iE 'strict-transport\|x-content-type\|x-frame\|referrer'` | all four present | — |
| F5 | Single `X-Frame-Options` on Grafana | `curl -sI https://deploy-ui.sportnavi.de/ \| grep -ci x-frame-options` | exactly `1` | **F-15** |

---

## G. Monitoring, alerting and supply chain

| # | Check | Command | Pass condition | Finding |
|---|---|---|---|---|
| G1 | Ingestion canary passes end to end | `LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=… bash scripts/ingestion-canary.sh https://sportnavi-langfuse.sportnavi.de` | `PASS: trace readable after ~Ns` | — |
| G2 | Metric names still resolve | `bash scripts/verify-metric-sources.sh` `[H]` | all PASS (re-run after every version bump) | — |
| G3 | Queue panels are not silently empty | Grafana → Ingestion & Queues | queue-depth series has data; blank = wrong `REDIS_QUEUE_KEY_PATTERNS` | — |
| G4 | Alerting exists **and routes** | `bash scripts/test-monitoring-config.sh` `[L]` | `PASS: baseline-free alert rules present`. ⚠️ A `WARN: ... NO ALERTMANAGER ROUTING` line means the rules fire into Prometheus' UI and page nobody — F-12 is only half closed until that WARN is gone | **F-12** |
| G5 | Off-host monitor is alive | external monitor dashboard | probing `/api/public/health` from **outside** the box | — |
| G6 | Dependency automation present | `ls .github/dependabot.yml` `[L]` | exists, and its PRs are actually being reviewed rather than accumulating | **F-10** |
| G7 | Image scanning in CI | `ls .github/workflows/image-scan.yml` `[L]` | exists. ⚠️ Its image list is duplicated from the compose files **by hand** — after any tag bump, confirm it scans what is actually deployed | **F-10** |
| G8 | Version drift acceptable | compare pinned tags to upstream latest | ≤ 2 minor versions behind, or drift explicitly accepted | **F-10** |
| G9 | `npm audit` clean | `cd examples/eve-langfuse-poc && npm audit` `[L]` | `found 0 vulnerabilities` | — |

---

## H. Documentation truthfulness

The control that would have caught F-01 earliest.

| # | Check | Pass condition | Finding |
|---|---|---|---|
| H1 | Every security claim in `CLAUDE.md` §12 has a matching **behavioural** check in this file | no claim asserts a control that is only config-verified | **F-06** |
| H2 | No stale security document is presented as current | ✅ archived to `docs/archive/SECURITY-REVIEW-2026-08-11.md` with a banner tabulating each now-false claim. Re-check at each audit: **a security document with no expiry will eventually mislead** | **F-16** |
| H3 | `PLATFORM-STATUS.md` "Verified" column means observed, not configured | spot-check three rows against live behaviour | — |
| H4 | Test names describe what they assert | ✅ done once: the Grafana check now says "CONFIGURED for SSO-only access (config lint, not a live probe)". Re-check that **no new test name claims to have observed behaviour it only read from a file** | **F-06** |

---

## Sign-off

```
Date:                     ______________________
Auditor:                  ______________________
External vantage IP used: ______________________   (must not be in ADMIN_ALLOWLIST)
Host access available:    yes / no
Sections completed:       A B C D E F G H
Criticals open:           ______________________
Highs open:               ______________________
Next audit due:           ______________________   (recommend quarterly, and after any ingress change)
```

**Cadence:** A2, A3, B1, B5 monthly — they are the checks that would have caught F-01 and F-03, they
take under a minute, and they must be run from off-network. Full checklist quarterly and after any
change to Caddy, auth, or the compose files.
