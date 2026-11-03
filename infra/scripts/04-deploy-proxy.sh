#!/usr/bin/env bash
#
# AegisOps — Phase 1: Bring up the Nginx reverse proxy stack
#
# Run from inside the infra/ directory, after:
#   - 03-create-network.sh has been run
#   - .env exists (copied from .env.example, DOMAIN filled in)
#   - nginx/certs/cert.pem and nginx/certs/key.pem exist (Cloudflare Origin
#     Certificate — see docs/phase1-infrastructure-setup.md)
#
# Usage:
#   cd infra
#   chmod +x scripts/04-deploy-proxy.sh
#   ./scripts/04-deploy-proxy.sh

set -euo pipefail

cd "$(dirname "$0")/.."   # move to infra/ regardless of where this was called from

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example to .env and set DOMAIN first." >&2
  exit 1
fi

if [[ ! -f nginx/certs/cert.pem || ! -f nginx/certs/key.pem ]]; then
  echo "Missing nginx/certs/cert.pem or nginx/certs/key.pem." >&2
  echo "Generate a Cloudflare Origin Certificate and place both files there" >&2
  echo "before starting the proxy — see the setup guide, Step 6." >&2
  exit 1
fi

echo "==> Starting the AegisOps reverse proxy"
docker compose up -d

echo "==> Current status"
docker compose ps

echo ""
echo "Tail logs with: docker compose logs -f nginx"
echo "Test locally with: curl -k https://localhost/healthz"
