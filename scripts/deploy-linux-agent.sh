#!/usr/bin/env bash
# =====================================================================
# VPS Agent Deployment Script for Linux (Ubuntu 22.04 & Debian 12)
# =====================================================================
set -e

VPS_ID="${1:-vps2}"
VPS_NAME="${2:-VPS 2 (Ubuntu Beszel Hub)}"
HUB_URL="${3:-https://app.hoangngocbach.id.vn/api/telemetry}"
SECRET="${4:-secret-token-change-me}"
INSTALL_DIR="/opt/vps-agent"

echo "=== Installing VPS Hub Agent for $VPS_NAME ($VPS_ID) ==="

# 1. Create directory structure
mkdir -p "$INSTALL_DIR/data"
chmod 750 "$INSTALL_DIR"

# 2. Generate Systemd Service Unit
cat <<EOF > /etc/systemd/system/vps-agent.service
[Unit]
Description=VPS Hub Telemetry & Storage Agent
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/vps-agent-linux \\
  -port 8085 \\
  -vps-id "$VPS_ID" \\
  -vps-name "$VPS_NAME" \\
  -hub-url "$HUB_URL" \\
  -secret "$SECRET" \\
  -interval 30s \\
  -data-dir "$INSTALL_DIR/data"
Restart=always
RestartSec=5s
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

# 3. Reload and enable service
systemctl daemon-reload
systemctl enable vps-agent.service

echo "=== Systemd Service Created ==="
echo "Copy 'vps-agent-linux' binary to $INSTALL_DIR/vps-agent-linux and run:"
echo "chmod +x $INSTALL_DIR/vps-agent-linux"
echo "systemctl restart vps-agent"
echo "systemctl status vps-agent"
