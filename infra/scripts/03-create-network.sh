#!/usr/bin/env bash
#
# AegisOps — Phase 1: Create the shared Docker network
#
# The Nginx reverse proxy and every future AegisOps-hosted app container
# join this one external network, so Nginx can route to any of them by
# container name without republishing ports on the host. Run once.
#
# Usage:
#   chmod +x 03-create-network.sh
#   ./03-create-network.sh

set -euo pipefail

NETWORK_NAME="aegisops-net"

if docker network inspect "$NETWORK_NAME" &>/dev/null; then
  echo "Network '$NETWORK_NAME' already exists, skipping."
else
  docker network create "$NETWORK_NAME"
  echo "Created docker network '$NETWORK_NAME'."
fi
