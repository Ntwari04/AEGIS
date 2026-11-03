# AegisOps — Phase 1: Infrastructure Foundation

This is the step-by-step build guide for **Phase 1** of the AegisOps roadmap
(Stakeholder Proposal v1.1): the Edge Network (Cloudflare), Cloud
Infrastructure (DigitalOcean droplet), and Reverse Proxy (Nginx) layers,
plus the security hardening and Docker runtime everything else will sit on.

By the end of this guide you'll have:

- A domain pointed through Cloudflare (DNS, SSL, CDN, DDoS protection)
- A hardened DigitalOcean droplet (key-only SSH, firewall, fail2ban)
- Docker installed and ready for containers
- An Nginx reverse proxy running in Docker, serving HTTPS, ready to route
  traffic to app containers you'll add in Phase 2

I'm not certain of current exact pricing, DigitalOcean plan names, or UI
labels — DigitalOcean and Cloudflare both change these over time. Treat the
screenshots-free, menu-label instructions below as "roughly here" and
verify against the live dashboard as you go. Where the proposal quotes a
cost (~$24/month droplet, $10–20/year domain), verify current pricing on
DigitalOcean's and your registrar's own pricing pages before budgeting.

All files referenced below live in `infra/` next to this guide.

---

## 0. Prerequisites

Accounts you'll need, all free to create:

1. **DigitalOcean** — https://www.digitalocean.com (hosts the droplet)
2. **Cloudflare** — https://www.cloudflare.com (DNS, SSL, edge protection)
3. **A domain name** — from any registrar (Namecheap, Google Domains
   successor Squarespace Domains, DigitalOcean's own domain reseller, etc.)
   If you don't have one yet, buy one now; you'll need it in Step 2.
4. **GitHub** — https://github.com (source control; you likely already
   have this since AegisOps itself lives in a repo)

Locally, you'll need an SSH key pair. If you don't already have one:

```bash
ssh-keygen -t ed25519 -C "ntwarienock1@gmail.com"
```

Keep the private key safe; you'll upload the **public** key
(`~/.ssh/id_ed25519.pub`) to DigitalOcean in Step 3.

---

## 1. Register the domain

If you already own a domain you want to use for AegisOps, skip to Step 2.
Otherwise, buy one through any registrar. It doesn't need to be the same
company as DigitalOcean or Cloudflare — you'll just point its nameservers
at Cloudflare in the next step.

---

## 2. Point the domain to Cloudflare

1. Sign up / log in at Cloudflare and click **Add a Site**.
2. Enter your domain and choose the **Free** plan.
3. Cloudflare scans existing DNS records and shows you two nameservers
   (e.g. `ada.ns.cloudflare.com`, `bob.ns.cloudflare.com`).
4. Go to your domain registrar's dashboard and replace the existing
   nameservers with the two Cloudflare gives you.
5. Back in Cloudflare, click **Done, check nameservers**. Propagation
   usually takes anywhere from a few minutes to a few hours.
6. While you wait, go to **SSL/TLS** in the Cloudflare dashboard and set
   the encryption mode to **Full (strict)**. This tells Cloudflare to
   require a valid certificate on your origin server (the droplet) —
   which is exactly what the Nginx setup in Step 6 provides.

You can't finish DNS (pointing your domain at the droplet's IP) until the
droplet exists, so move on.

---

## 3. Create the DigitalOcean droplet

1. Log in to DigitalOcean → **Create → Droplets**.
2. **Region**: pick one close to your users.
3. **Image**: Ubuntu, latest LTS (24.04 at the time this guide was
   written — pick whatever the current LTS is if that's changed).
4. **Size**: the proposal budgets ~$24/month, which corresponds to a
   basic shared-CPU droplet (roughly 2 vCPU / 2–4GB RAM tier as of
   writing) — enough for Nginx, Postgres, Redis and a couple of small
   app containers to start. Verify current tier names/pricing in the
   DigitalOcean console since these change.
5. **Authentication**: choose **SSH Key**, not password, and upload the
   public key you generated in Step 0.
6. **Hostname**: something recognizable, e.g. `aegisops-prod-01`.
7. Click **Create Droplet** and note its public IPv4 address once it's
   up.

---

## 4. First login and server hardening

SSH in as root using the IP from Step 3:

```bash
ssh root@YOUR_DROPLET_IP
```

Copy `infra/scripts/01-initial-server-setup.sh` onto the droplet (either
`git clone` your AegisOps repo once it's pushed to GitHub, or `scp` the
`infra/` folder up), then run it:

```bash
chmod +x 01-initial-server-setup.sh
./01-initial-server-setup.sh youruser
```

Replace `youruser` with whatever non-root username you want (e.g. your
first name). The script will:

- Update the OS and install `ufw`, `fail2ban`, `unattended-upgrades`
- Create `youruser` as a sudo user and copy your SSH key to it
- Disable root login and password auth over SSH
- Open only ports 22 (SSH), 80 (HTTP), and 443 (HTTPS) in the firewall
- Turn on fail2ban and automatic security updates

**Before closing the root session**, open a second terminal and confirm
you can log in as the new user:

```bash
ssh youruser@YOUR_DROPLET_IP
```

Only close the original root session once that works — otherwise you
risk being locked out.

---

## 5. Point Cloudflare DNS at the droplet

Back in the Cloudflare dashboard → **DNS**:

1. Add an **A record**: name `@` (root domain), content = your droplet's
   IP, proxy status **Proxied** (orange cloud).
2. Add another **A record**: name `www`, same IP, also **Proxied**.

Leave SSL/TLS mode at **Full (strict)** as set in Step 2 — this is what
makes Cloudflare require a valid certificate on the droplet, which you'll
add in Step 7.

---

## 6. Install Docker

As `youruser` on the droplet, run `infra/scripts/02-install-docker.sh`:

```bash
chmod +x 02-install-docker.sh
./02-install-docker.sh
```

This installs Docker Engine and the Compose plugin from Docker's official
apt repository and adds your user to the `docker` group. Log out and back
in (or run `newgrp docker`) afterward so you can run `docker` without
`sudo`.

Verify:

```bash
docker --version
docker compose version
```

---

## 7. Generate a Cloudflare Origin Certificate

Because Cloudflare sits in front of your droplet (Full-strict mode), the
simplest way to get a trusted-by-Cloudflare certificate on Nginx — no
Let's Encrypt renewal cron job needed — is Cloudflare's own Origin CA:

1. Cloudflare dashboard → **SSL/TLS → Origin Server** → **Create
   Certificate**.
2. Accept the defaults (RSA, covers your domain and `*.yourdomain`),
   validity up to 15 years.
3. Cloudflare shows you a certificate and a private key. Copy them into
   two files on the droplet:
   - `infra/nginx/certs/cert.pem` (the certificate)
   - `infra/nginx/certs/key.pem` (the private key)

These two files are gitignored — never commit them. This certificate is
only trusted by Cloudflare, which is fine: real visitors only ever talk
to Cloudflare directly, and Cloudflare talks to your origin over this
certificate.

---

## 8. Configure and start the reverse proxy

On the droplet, inside `infra/`:

```bash
cp .env.example .env
# edit .env and set DOMAIN=yourdomain.com
chmod +x scripts/03-create-network.sh scripts/04-deploy-proxy.sh
./scripts/03-create-network.sh
./scripts/04-deploy-proxy.sh
```

`03-create-network.sh` creates the shared `aegisops-net` Docker network
that Nginx and every future app container will join. `04-deploy-proxy.sh`
checks your `.env` and certs are in place, then runs `docker compose up
-d`, which:

- Starts `nginx:stable-alpine` in a container
- Renders `infra/nginx/templates/default.conf.template` into a live
  config using `$DOMAIN` from `.env`
- Terminates TLS with your Cloudflare Origin Certificate
- Redirects HTTP → HTTPS
- Serves a placeholder response at `/` and a health check at `/healthz`

---

## 9. Verify

From the droplet:

```bash
curl -k https://localhost/healthz
# → ok
```

From your own machine, once DNS has propagated:

```bash
curl https://yourdomain.com/healthz
# → ok
```

Or just open `https://yourdomain.com` in a browser — you should see the
placeholder message and a valid padlock (served by Cloudflare's edge
certificate, which is separate from the origin certificate you just
installed).

If it doesn't resolve yet, DNS propagation can take a while after
changing nameservers in Step 2 — recheck in 15–30 minutes.

---

## What you have now

| Layer | Status |
|---|---|
| Edge Network (Cloudflare) | DNS, SSL/TLS (Full strict), proxy/CDN active |
| Cloud Infrastructure (DigitalOcean) | Droplet running, hardened, firewalled |
| Reverse Proxy (Nginx) | Live in Docker, HTTPS terminated, health check responding |
| Containers (Docker) | Engine installed, shared network created |

This matches the "Infrastructure Layers" table in the Stakeholder
Proposal, bottom three rows plus the container runtime — the foundation
Phase 2 (Core Platform Development: Postgres, Redis, the AegisOps app
itself) builds directly on top of.

## Next steps (Phase 2 preview)

- Add PostgreSQL and Redis containers to `docker-compose.yml`, on the same
  `aegisops-net` network
- Start scaffolding the AegisOps app itself (Identity & Access, Executive
  Dashboard modules from the proposal)
- Add a real `location /` proxy_pass block in
  `nginx/templates/default.conf.template` once the first app container
  exists, replacing today's placeholder response

Say the word when you're ready and we'll pick up there.
