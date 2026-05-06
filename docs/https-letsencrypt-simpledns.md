# HTTPS on a non-standard port via Let's Encrypt + SimpleDNS Plus + Coolify

This is a working recipe for a slightly unusual constraint: you want a real Let's Encrypt cert on a service that lives on a **non-standard public port** (here, `9090`) and you **cannot expose ports 80 or 443 inbound** from the public internet. The trick is a Caddy sidecar that solves the ACME challenge over **DNS-01** against a self-hosted **SimpleDNS Plus** server using **RFC 2136** dynamic updates with a TSIG key. Coolify orchestrates the whole stack as a Docker Compose deployment.

This document is self-contained — it assumes you have a domain you control whose authoritative DNS runs on a SimpleDNS Plus instance you own, plus a Coolify host with Docker.

## Why this shape

Conventional Let's Encrypt issuance uses **HTTP-01** (LE GETs `http://yourdomain/.well-known/acme-challenge/...` on port 80) or **TLS-ALPN-01** (port 443). Both require an inbound public port that ACME can reach. If your firewall keeps 80 / 443 closed (as is common when the host runs other services on those ports, or you run an ISP / NAT'd setup where those ports are unavailable), neither challenge will work.

**DNS-01** is the escape hatch. The ACME client publishes a `_acme-challenge.<your-domain>` TXT record that Let's Encrypt verifies over DNS, then takes it down. No inbound HTTP/HTTPS to the host is needed.

To do that automatically (rather than manually editing zone files every 60 days when the cert renews), the ACME client needs a way to *write* to your DNS zone. **RFC 2136** is the IETF standard for authenticated dynamic DNS updates, and SimpleDNS Plus supports it natively. Authentication is via a TSIG key (a shared HMAC secret).

The chosen ACME client is **Caddy**, because:

- It's a single binary with a small config file
- The `caddy-dns/rfc2136` provider is a maintained Go module
- Cert renewal is fully automatic — the daemon checks daily and renews ~30 days before expiry
- It cleanly reverse-proxies to the rest of the stack on internal Docker network

Caddy isn't shipped with the rfc2136 plugin in the official image, so we build a small custom image with **xcaddy**.

## Architecture

```
                         Public DNS                Internet
        ┌──────────────────────────┐   ┌─────────────────────┐
        │ SimpleDNS Plus           │   │ Let's Encrypt       │
        │ (you run this)           │   │ acme-v02.api...      │
        │   _acme-challenge.foo    │   │                     │
        │       TXT record ←───────┼───┤ verify TXT          │
        │                          │   │                     │
        └──────────────────────────┘   └─────────────────────┘
              ▲                                  ▲
              │  RFC 2136 (TSIG-signed UDP/53)   │  HTTPS outbound
              │                                  │
        ┌─────┴──────────────────────────────────┴──────────┐
        │ Coolify host  (your server)                       │
        │ ┌────────────────────────────────────────────┐    │
        │ │ docker network                             │    │
        │ │                                            │    │
        │ │   ┌─────────┐   :80    ┌─────────┐         │    │
        │ │   │  caddy  │─────────►│   web   │ (nginx) │    │
        │ │   │ sidecar │          │  static │ + /api  │    │
        │ │   │ :9090   │          │  PWA    │ proxy   │    │
        │ │   └─────────┘          └────┬────┘         │    │
        │ │        ▲                    │ :3000        │    │
        │ │        │                    ▼              │    │
        │ │        │               ┌─────────┐         │    │
        │ │        │               │   api   │         │    │
        │ │        │               │ fastify │         │    │
        │ │        │               └─────────┘         │    │
        │ └────────┼────────────────────────────────────┘    │
        │   :9090 (only public port)                         │
        └────────────────────────────────────────────────────┘
              ▲
              │  HTTPS
              │
        ┌─────┴──────────┐
        │  end users     │
        │  (browsers,    │
        │   PWA, etc.)   │
        └────────────────┘
```

Inbound to the host: **only TCP/9090**. Outbound: standard egress (UDP/53 to the SimpleDNS Plus host and HTTPS to Let's Encrypt).

## The four moving pieces

1. A **TSIG key** in SimpleDNS Plus that grants permission to write TXT records under `_acme-challenge.<your-domain>`.
2. A **custom Caddy image** built with `xcaddy --with github.com/caddy-dns/rfc2136`.
3. A **Caddyfile** that wires the rfc2136 provider, the LE email, and the reverse-proxy block for your domain on `:9090`.
4. A **`docker-compose.yml`** that builds the Caddy image, exposes `9090`, mounts a persistent volume for cert storage, and threads the four ACME env vars through from Coolify.

## Step 1 — SimpleDNS Plus: TSIG key + update policy

In the SimpleDNS Plus admin UI:

1. **Tools → Options → Updates → TSIG keys → Add.**
   - **Key name**: pick something descriptive, e.g. `caddy-acme-key`. This is exactly what Caddy will send in the `key_name` field. Keep it lowercase, no spaces.
   - **Algorithm**: `HMAC-SHA256`.
   - **Secret**: SimpleDNS can generate one for you. **Important**: the secret must be valid base64. Some SimpleDNS versions produce a 23-character key on click — that's the start of the bug. If you get an "invalid base64" error in Caddy logs later, generate a 32-byte secret externally:
     ```
     openssl rand -base64 32
     ```
     and paste that 44-character string into SimpleDNS. (We hit this exact problem; the openssl-generated 44-char form works.)

2. **For the zone you want to issue certs in (e.g. `dk.net.za`) → Properties → Dynamic Updates → Allow → Add policy:**
   - **TSIG key**: select the one you just made.
   - **Allowed records**: at minimum `TXT` under `_acme-challenge.*` within the zone. Be tight — this key should only be able to write the ACME challenge record, nothing else.

3. **Make sure the SimpleDNS host accepts UDP/53 from the Coolify host's outbound IP.** If SimpleDNS is on the same private network or LAN, no firewall change is needed. If it's across a public boundary, allow UDP/53 from the Coolify host source IP only.

4. **Note these three values** — you'll paste them into Coolify shortly:
   - `ACME_TSIG_KEYNAME` = the key name (e.g. `caddy-acme-key`)
   - `ACME_TSIG_SECRET` = the base64 secret
   - `ACME_DNS_SERVER` = the SimpleDNS hostname or IP that Caddy will hit (e.g. `dns1.dk.net.za` or `10.0.0.5`)

## Step 2 — Repo files

Two files, both inside a `caddy/` directory at the repo root.

### `caddy/Dockerfile`

```dockerfile
FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/rfc2136

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
```

Notes:

- The two-stage build keeps the runtime image small (alpine base + a single Go binary).
- The Caddyfile is **`COPY`'d into the image at build time**, not bind-mounted. We tried bind-mounting it from the host and Coolify's relative-path handling of compose volumes resolved `./Caddyfile` to an empty *directory* on the host, which Docker then refused to mount onto the file path inside the container. Baking it in eliminates that variable; to change routing you edit the file and let Coolify rebuild the image on next deploy.

### `caddy/Caddyfile`

```caddyfile
{
    acme_dns rfc2136 {
        key_name "{$ACME_TSIG_KEYNAME}"
        key_alg  "hmac-sha256"
        key      "{$ACME_TSIG_SECRET}"
        server   "{$ACME_DNS_SERVER}:53"
    }
    email {$ACME_EMAIL}
}

yourdomain.example:9090 {
    reverse_proxy web:80

    encode zstd gzip

    log {
        output stdout
        format console
    }
}
```

Replace `yourdomain.example` with your actual hostname (e.g. `tasks.dk.net.za`) and `web:80` with the Docker service name + internal port that Caddy should reverse-proxy to.

If you ever want a second site, drop in another block:

```caddyfile
billing.yourdomain.example:9091 {
    reverse_proxy billing-app:80
}
```

…then **also** open `9091` inbound on the firewall, add `"9091:9091"` to the caddy service's `ports:` list in compose, and verify the SimpleDNS update policy allows `_acme-challenge.billing.yourdomain.example` writes with the same TSIG key.

## Step 3 — `docker-compose.yml`

The relevant `caddy` service plus the volumes (the rest of your stack stays as-is):

```yaml
services:
  # ... your existing api / web / etc. services ...

  caddy:
    build: ./caddy
    restart: unless-stopped
    environment:
      ACME_TSIG_KEYNAME: ${ACME_TSIG_KEYNAME}
      ACME_TSIG_SECRET:  ${ACME_TSIG_SECRET}
      ACME_DNS_SERVER:   ${ACME_DNS_SERVER}
      ACME_EMAIL:        ${ACME_EMAIL}
    ports:
      - "9090:9090"
    volumes:
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - web   # whatever upstream Caddy reverse-proxies to

volumes:
  caddy_data: {}
  caddy_config: {}
```

**The two volumes are critical.** `caddy_data` holds the issued cert + the ACME account key. If you wipe it, Caddy will request a brand-new cert on next boot, which counts against Let's Encrypt's rate limit (50 certs per registered domain per week — easy to blow through during testing if you're not careful). Keep these volumes named, declared at the bottom of the compose file, and **don't** add them to a Coolify "wipe storage on redeploy" list.

`caddy_config` holds account-level metadata; less critical but standard.

## Step 4 — Coolify configuration

In the Coolify UI for the resource:

1. **Resource type**: Docker Compose. Point the build pack at the repo root containing the compose file.
2. **Environment Variables panel**: add at minimum these four for Caddy. Mark them all **Available at runtime**.
   ```
   ACME_TSIG_KEYNAME = caddy-acme-key            # whatever you named it in SimpleDNS
   ACME_TSIG_SECRET  = <44-char base64 secret>   # generated via openssl rand -base64 32
   ACME_DNS_SERVER   = <hostname or IP>          # of the SimpleDNS Plus instance
   ACME_EMAIL        = you@yourdomain.example    # LE will email expiry warnings here
   ```
   Coolify substitutes these into `${ACME_TSIG_KEYNAME}` etc. in the compose file.
3. **Persistent storage**: Coolify auto-creates the `caddy_data` and `caddy_config` named volumes from the `volumes:` block. Confirm they appear in the resource's storage tab and are flagged as persistent.
4. **Domain binding**: Coolify has its own "Domain" field per service that wires Traefik in front of the container. **Do not bind a domain to the caddy service this way** — Caddy is doing TLS termination itself. Either skip the domain binding entirely, or use Coolify's "raw / TCP passthrough" mode if that's the only way the UI lets you save the resource.
5. **Firewall**: ensure the host's firewall (Coolify's UFW, your cloud SG, whatever's in front) allows inbound TCP/9090 from `0.0.0.0/0` (or your allowlist).
6. **Redeploy.** First deploy will take 1–2 minutes for the xcaddy build, then ~10 seconds for Caddy to acquire the cert via DNS-01.

## Step 5 — Verification

After the first successful deploy:

1. **Caddy logs** (Coolify → caddy service → Logs) should show something like:
   ```
   {"level":"info","msg":"obtained certificate","identifier":"yourdomain.example"}
   ```
   If you instead see `dns: NXDOMAIN`, the rfc2136 plugin couldn't reach SimpleDNS — check `ACME_DNS_SERVER` and the firewall to UDP/53.
   If you see `tsig: bad key`, the `ACME_TSIG_KEYNAME` mismatched (often a typo) or the secret isn't valid base64.

2. **From any external machine:**
   ```
   curl -vI https://yourdomain.example:9090/
   ```
   - Subject: CN=yourdomain.example
   - Issuer: Let's Encrypt
   - Expiry: ~90 days out

3. **In SimpleDNS** during the first issuance you'll briefly see a `_acme-challenge.yourdomain.example` TXT record appear and disappear. After that the zone returns to its baseline state. (The TXT only lives for the seconds Let's Encrypt takes to verify it.)

4. **Renewal**: Caddy checks daily. On day ~60 the cert will rotate automatically and a fresh `obtained certificate` log line appears. No manual action needed. If you want a tripwire that warns you when renewal *stops* working, set up a scheduled remote agent (in Claude Code, via the `schedule` skill) to `curl -vI` the host every 1–7 days and alert on cert expiry < 30 days.

## Common gotchas (we hit these)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Caddy: "invalid base64 in TSIG key" | SimpleDNS generated a 23-char key | Replace with `openssl rand -base64 32` (44-char) |
| Caddy: "i/o timeout" calling DNS server | UDP/53 blocked | Allow UDP/53 from Coolify host to SimpleDNS host |
| Coolify: empty directory mounted at `/etc/caddy/Caddyfile` | Bind-mount path resolution | Bake Caddyfile into image via `COPY` (already done above) |
| Cert reissued every redeploy | `caddy_data` volume not persistent | Declare it as a named volume, don't wipe on redeploy |
| Multiple domains, only one gets a cert | Each domain needs its own block in Caddyfile *and* its own SimpleDNS update policy entry | Add both |
| LE rate-limit hit ("too many certificates") | Repeated test loops with `caddy_data` wiped each time | Use [Let's Encrypt staging](https://letsencrypt.org/docs/staging-environment/) for testing — add `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` inside the global `{ ... }` block |

## Adapting to your project

Copy these files into your repo:

- `caddy/Dockerfile` (verbatim)
- `caddy/Caddyfile` — change the domain on the site block and the `reverse_proxy` upstream
- `docker-compose.yml` — splice in the `caddy` service block and the two volumes; adjust `depends_on` to whichever service Caddy reverse-proxies to

Then in Coolify:

- Add the four `ACME_*` env vars (with values from your SimpleDNS Plus TSIG key)
- Verify `caddy_data` and `caddy_config` are persistent volumes
- Open the chosen public port (9090 here, or whatever you picked) inbound

That's the complete recipe. Once it's running, this same Caddy sidecar can host any number of additional services on additional non-443 ports — each gets its own auto-renewing LE cert with no extra ACME credentials, just a new Caddyfile block and a new firewall rule.
