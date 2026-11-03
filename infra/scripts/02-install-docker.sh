#!/usr/bin/env bash
#
# AegisOps — Phase 1: Install Docker Engine + Compose plugin
#
# Run as the sudo user you created in 01-initial-server-setup.sh (not root).
# Follows Docker's official apt repository instructions for Ubuntu/Debian.
#
# Usage:
#   chmod +x 02-install-docker.sh
#   ./02-install-docker.sh

set -euo pipefail

echo "==> Removing any old/conflicting Docker packages"
for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do
  sudo apt-get remove -y "$pkg" 2>/dev/null || true
done

echo "==> Installing prerequisites"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg

echo "==> Adding Docker's official GPG key and apt repository"
sudo install -m 0755 -d /etc/apt/keyrings
. /etc/os-release   # sets $ID (ubuntu/debian) for the repo URL below
if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
fi
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

echo "==> Installing Docker Engine, CLI, containerd, buildx, compose plugin"
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> Allowing your user to run docker without sudo"
sudo usermod -aG docker "$USER"

echo "==> Enabling Docker to start on boot"
sudo systemctl enable --now docker

echo ""
echo "=================================================================="
echo " Docker installed: $(docker --version)"
echo " Compose plugin:   $(docker compose version)"
echo ""
echo " IMPORTANT: log out and back in (or run 'newgrp docker') for the"
echo " docker group membership to take effect without sudo."
echo "=================================================================="
