#!/usr/bin/env bash
#
# AegisOps — Phase 1: Initial server setup & hardening
#
# Run this ONCE, as root, immediately after the droplet is created and you've
# logged in for the first time over SSH (e.g. `ssh root@YOUR_DROPLET_IP`).
#
# What it does:
#   1. Updates the OS and installs baseline packages
#   2. Creates a non-root sudo user (so you stop using root day-to-day)
#   3. Copies your SSH key to the new user
#   4. Hardens SSH (key-only auth, no root login, no password auth)
#   5. Configures the UFW firewall (allow SSH/HTTP/HTTPS only)
#   6. Installs and enables fail2ban (brute-force protection)
#   7. Enables unattended security upgrades
#
# Usage:
#   chmod +x 01-initial-server-setup.sh
#   ./01-initial-server-setup.sh <new_username>
#
# After this script finishes, log out and reconnect as the new user:
#   ssh <new_username>@YOUR_DROPLET_IP
# Verify that works BEFORE closing your original root session.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root (or with sudo)." >&2
  exit 1
fi

NEW_USER="${1:-}"
if [[ -z "$NEW_USER" ]]; then
  echo "Usage: $0 <new_username>" >&2
  exit 1
fi

echo "==> Updating system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ufw fail2ban unattended-upgrades curl ca-certificates gnupg

echo "==> Creating sudo user: $NEW_USER"
if id "$NEW_USER" &>/dev/null; then
  echo "User $NEW_USER already exists, skipping creation."
else
  adduser --disabled-password --gecos "" "$NEW_USER"
  usermod -aG sudo "$NEW_USER"
fi

echo "==> Copying authorized_keys from root to $NEW_USER"
mkdir -p /home/"$NEW_USER"/.ssh
if [[ -f /root/.ssh/authorized_keys ]]; then
  cp /root/.ssh/authorized_keys /home/"$NEW_USER"/.ssh/authorized_keys
else
  echo "WARNING: /root/.ssh/authorized_keys not found." >&2
  echo "Make sure $NEW_USER has your SSH public key in ~/.ssh/authorized_keys" >&2
  echo "before you log out, or you will be locked out." >&2
fi
chmod 700 /home/"$NEW_USER"/.ssh
chmod 600 /home/"$NEW_USER"/.ssh/authorized_keys || true
chown -R "$NEW_USER":"$NEW_USER" /home/"$NEW_USER"/.ssh

echo "==> Hardening SSH configuration"
SSHD_CONFIG=/etc/ssh/sshd_config
cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak.$(date +%s)"

set_sshd_option() {
  local key="$1" value="$2"
  if grep -qE "^\s*#?\s*${key}\s+" "$SSHD_CONFIG"; then
    sed -i -E "s/^\s*#?\s*${key}\s+.*/${key} ${value}/" "$SSHD_CONFIG"
  else
    echo "${key} ${value}" >> "$SSHD_CONFIG"
  fi
}

set_sshd_option "PermitRootLogin" "no"
set_sshd_option "PasswordAuthentication" "no"
set_sshd_option "PubkeyAuthentication" "yes"
set_sshd_option "ChallengeResponseAuthentication" "no"
set_sshd_option "X11Forwarding" "no"

sshd -t   # validate config before restarting — abort on syntax error
systemctl restart ssh

echo "==> Configuring UFW firewall"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Enabling fail2ban"
systemctl enable --now fail2ban

echo "==> Enabling unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo ""
echo "=================================================================="
echo " Done. DO NOT close this session yet."
echo " Open a NEW terminal and confirm you can log in as: $NEW_USER"
echo "   ssh $NEW_USER@<droplet-ip>"
echo " Only after that works should you close this root session."
echo " Root login and password auth are now disabled."
echo "=================================================================="
