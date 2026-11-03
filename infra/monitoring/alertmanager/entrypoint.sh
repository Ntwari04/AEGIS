#!/bin/sh
# Builds /tmp/alertmanager.yml = alertmanager.base.yml + receivers rendered from the environment, then starts Alertmanager.
#   ALERT_SLACK_WEBHOOK_URL            Slack incoming-webhook URL (kept in a file, never in the config)
#   ALERT_EMAIL_TO / ALERT_SMTP_*      email channel (optional)
# With neither set, alerts are still evaluated and shown on the dashboard and the Alertmanager UI, but nothing is sent.
set -eu

OUT=/tmp/alertmanager.yml
cat /etc/alertmanager/alertmanager.base.yml > "$OUT"
{
  echo "receivers:"
  echo "  - name: default"
} >> "$OUT"

CHANNELS=0
if [ -n "${ALERT_SLACK_WEBHOOK_URL:-}" ]; then
  printf '%s' "$ALERT_SLACK_WEBHOOK_URL" > /tmp/slack_url
  cat >> "$OUT" <<'EOF'
    slack_configs:
      - api_url_file: /tmp/slack_url
        send_resolved: true
        title: '{{ if eq .Status "firing" }}[{{ .CommonLabels.severity }}]{{ else }}[resolved]{{ end }} {{ .CommonLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.summary }}{{ "\n" }}{{ end }}'
EOF
  CHANNELS=$((CHANNELS + 1))
fi

if [ -n "${ALERT_EMAIL_TO:-}" ] && [ -n "${ALERT_SMTP_HOST:-}" ]; then
  [ -n "${ALERT_SMTP_PASSWORD:-}" ] && printf '%s' "$ALERT_SMTP_PASSWORD" > /tmp/smtp_password
  cat >> "$OUT" <<EOF
    email_configs:
      - to: '${ALERT_EMAIL_TO}'
        from: '${ALERT_EMAIL_FROM:-aegisops@localhost}'
        smarthost: '${ALERT_SMTP_HOST}:${ALERT_SMTP_PORT:-587}'
        auth_username: '${ALERT_SMTP_USER:-}'
        auth_password_file: /tmp/smtp_password
        require_tls: true
        send_resolved: true
EOF
  CHANNELS=$((CHANNELS + 1))
fi

if [ "$CHANNELS" -eq 0 ]; then
  echo "alertmanager: no notification channel configured (ALERT_SLACK_WEBHOOK_URL / ALERT_EMAIL_TO); alerts will only be visible on the dashboard" >&2
fi

exec /bin/alertmanager --config.file="$OUT" --storage.path=/alertmanager --web.listen-address=:9093 --cluster.listen-address=
