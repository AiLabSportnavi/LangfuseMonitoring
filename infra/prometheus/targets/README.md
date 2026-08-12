# Prometheus file service discovery targets

Deployment-specific probe targets. Prometheus performs **no environment
variable substitution** in `prometheus.yml`, so hostnames that differ per
deployment live here instead of being inlined.

## `edge.json`

Feeds the `edge-tls` job, which probes the **public** hostnames over HTTPS and
is the source of `probe_ssl_earliest_cert_expiry` for the
`TLSCertificateExpiringSoon` rule (audit F-14).

```bash
cp edge.json.example edge.json
# replace the example hostnames with LANGFUSE_DOMAIN and GRAFANA_DOMAIN
docker compose -f compose.yaml -f compose.monitoring.yaml kill -s SIGHUP prometheus
```

`edge.json` is **not** committed — it is deployment state, and committing it
would put the production hostnames of every future deployment in this repo.
`file_sd` re-reads it on the `refresh_interval`, so adding a hostname needs no
restart and no config change.

> **If `edge.json` is absent the job is simply empty** — Prometheus logs a
> missing-file warning and moves on. That means the TLS expiry rule silently
> never fires, which is the same class of silent blindness as an empty queue
> panel. `scripts/health-check.sh` checks certificate expiry independently for
> exactly this reason; do not treat either as covering the other.
