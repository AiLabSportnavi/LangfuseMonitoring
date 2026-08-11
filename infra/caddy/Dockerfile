# Caddy with the rate-limit module compiled in.
#
# Stock Caddy has NO rate limiting — `rate_limit` is not a standard directive, it is
# a third-party module requiring an xcaddy build. CLAUDE.md §12.4 claimed the ingest
# endpoint was rate limited at the reverse proxy; it was not, and the test suite hid
# it. See docs/SECURITY-REVIEW.md P4.
#
# Versions are pinned in all three places deliberately — builder tag, xcaddy build
# argument, and runtime base — so the binary and its base image cannot drift apart.
# Bump them together, never individually.
#
#   caddy            2.11.4   (must match compose.yaml's previous pinned tag)
#   caddy-ratelimit  v0.1.0
#
# Building on the production host is acceptable at Tier 1 BECAUSE every input here
# is pinned — base image, xcaddy version, and module version. The reproducibility
# requirement in CLAUDE.md §14 is about pinning, not about where the build runs; a
# pinned build produces the same binary anywhere.
#
# Moving to a CI-built image deployed by digest is the Tier 2 improvement. It buys
# two things this does not: the production host stops needing a Go toolchain and
# network access to module proxies at deploy time, and the exact bytes that were
# tested are the exact bytes that ship.

FROM caddy:2.11.4-builder AS builder

RUN xcaddy build v2.11.4 \
    --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2.11.4-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Fail the build rather than the deploy if the module did not actually link in.
# `xcaddy build` can succeed while producing a binary without the module if the
# dependency resolves oddly, and the failure would otherwise surface as a
# Caddyfile parse error at start — after the old container is already gone.
RUN caddy list-modules | grep -q '^http.handlers.rate_limit$' \
    || (echo "FATAL: rate_limit module not present in built binary" && exit 1)
