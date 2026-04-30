# Custom Caddy image with the rfc2136 ACME DNS plugin baked in.
#
# The official caddy:2-alpine image only ships the core binary; ACME DNS
# providers (Cloudflare, RFC 2136, etc.) live in separate Go modules and
# have to be compiled into a custom Caddy binary via xcaddy. This is the
# canonical pattern from Caddy's own docs:
#   https://caddyserver.com/docs/build#xcaddy
#
# The rfc2136 plugin lets Caddy publish TXT records to any DNS server that
# supports TSIG-signed RFC 2136 dynamic updates — in our case, SimpleDNS
# Plus on the operator's host.
FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/rfc2136

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
