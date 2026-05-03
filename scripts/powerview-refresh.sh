#!/bin/bash
# Refresh PowerView hub cache by RF-querying each shade.
# Runs slowly, one shade at a time, to avoid hub overload and HomeKit timeouts.
#
# Configure HUB and SHADES for your install. SHADES can be enumerated via:
#   curl -s http://${HUB}/api/shades | jq '.shadeData[].id'
#
# Catches drift the per-move verify might miss (e.g. shades moved via the
# Pebble remote, or motor stalls that happened outside HomeKit-commanded moves).

HUB="${POWERVIEW_HUB:-powerview-hub.local}"
SHADES=(8517 40339 51934 15050 35080 38361 55357 47409 57249 40237 27062 26341 21120 30417)
LOG="${POWERVIEW_LOG:-/var/log/powerview-refresh.log}"

ts() { date "+%Y-%m-%d %H:%M:%S"; }

echo "[$(ts)] Starting sweep of ${#SHADES[@]} shades" >> "$LOG"
for id in "${SHADES[@]}"; do
  http=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 "http://${HUB}/api/shades/${id}?refresh=true")
  echo "[$(ts)] shade ${id}: HTTP ${http}" >> "$LOG"
  sleep 4
done
echo "[$(ts)] Sweep complete" >> "$LOG"
