#!/bin/bash
# Install the PowerView cache refresh cron sweep.
#
# Runs at midnight and noon (system local time). USER field is required for
# /etc/cron.d/ files — without it cron silently rejects the entry.
#
# Usage: sudo ./install-cron.sh

set -euo pipefail

SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/powerview-refresh.sh"
SCRIPT_DST="/usr/local/bin/powerview-refresh.sh"
CRON_FILE="/etc/cron.d/powerview-refresh"

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

install -m 0755 "$SCRIPT_SRC" "$SCRIPT_DST"
echo "Installed $SCRIPT_DST"

cat > "$CRON_FILE" <<EOF
0 0,12 * * * root $SCRIPT_DST
EOF
chmod 0644 "$CRON_FILE"
echo "Installed $CRON_FILE"

if systemctl list-unit-files cron.service >/dev/null 2>&1; then
  systemctl restart cron
  echo "Restarted cron"
fi

echo "Done. Check sweep log at /var/log/powerview-refresh.log after next 00:00 / 12:00."
