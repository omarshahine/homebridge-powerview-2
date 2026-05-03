# PowerView Plugin Customizations — Shahine Cabin Homebridge

> **Note:** the per-move verify and verify-coalesce logic described below are now **baked into this fork**. New installs only need `config.json` (slow-shade list, delays) and the cron sweep from [`scripts/`](../scripts/). The "After plugin updates" re-apply recipe at the bottom is kept for historical context — it's no longer needed if you install from this fork.

Last updated: 2026-04-25 by Omar (with Claude Code assistance).

## Hardware

- **Hub**: Hunter Douglas PowerView **Gen 2** at `192.168.1.202` (mDNS `powerview-hub.local`).
- **Stuck on Gen 2** — Gen 3 plugins (`homebridge-hunterdouglas-powerview`) are not compatible.
- 14 shades. Three are notably slow to travel:
  - `40237` Sliding Door Right Blinds
  - `55357` Sliding Door Left Blinds
  - `27062` Fireplace Blinds

## Plugin

- **Installed**: `homebridge-powerview-2` v1.0.9 (owenselles fork of keybuk/homebridge-powerview).
- **Path**: `/var/lib/homebridge/node_modules/homebridge-powerview-2/`.
- **Why this fork**: Same logic as the keybuk original, slightly different defaults. Last published 2018-ish.

## Problem we solved

Out of the box, the plugin loads shade state once at startup and never refreshes. HomeKit tiles silently drift away from physical reality — usually because the hub stores the *commanded* position as truth even if the motor stalled or partially moved. The user only operates via HomeKit (no Pebble, no manual), so drift is almost always a motor-stall situation.

## Layered fix

### 1. Config flags (`/var/lib/homebridge/config.json`, PowerView platform)

```json
"refreshShades": false,
"pollShadesForUpdate": true
```

- `pollShadesForUpdate: true` → 30 s bulk `GET /api/shades` keeps tiles populated from hub cache. No RF, no timeouts.
- `refreshShades: false` → **deliberately off**. With it on, every HomeKit read fans out a per-shade RF query through a serialized 100 ms-gap queue. With 14 shades that bursts past HomeKit's ~6 s characteristic timeout and shows "No Response" on most tiles when the Home app opens. Confirmed reproduces on Gen 2.

### 2. Per-move verify patch (`index.js` line ~556)

`setPosition` schedules a single delayed `?refresh=true` for the shade after every HomeKit-commanded move:

```js
}.bind(this), [40237, 55357, 27062].includes(shadeId) ? 45000 : 30000);
```

- Slow three: 45 s (covers full travel + margin)
- Everyone else: 30 s
- Verify is invisible to HomeKit (background HTTP), so longer delays cost nothing.

### 3. Cron sweep (`/etc/cron.d/powerview-refresh`)

```
0 0,12 * * * root /usr/local/bin/powerview-refresh.sh
```

Runs at midnight and noon (Pi local time). Script: `/usr/local/bin/powerview-refresh.sh`. Loops all 14 shades sequentially with `?refresh=true` and a 4 s gap between, ~108 s total. Catches anything missed by the per-move verify.

Log: `/var/log/powerview-refresh.log`.

## File inventory

| File | Purpose |
|------|---------|
| `/var/lib/homebridge/config.json` | Live Homebridge config (has the two flags) |
| `/var/lib/homebridge/config.json.bak.20260425-221255` | Original, pre-flags |
| `/var/lib/homebridge/config.json.bak.20260425-221857` | After enabling both flags (before reverting refreshShades) |
| `/var/lib/homebridge/node_modules/homebridge-powerview-2/index.js` | Patched plugin |
| `/var/lib/homebridge/node_modules/homebridge-powerview-2/index.js.bak.20260425-222524` | Pristine v1.0.9, pre-patch |
| `/var/lib/homebridge/node_modules/homebridge-powerview-2/PATCH_NOTES.md` | Short marker inside plugin dir |
| `/usr/local/bin/powerview-refresh.sh` | Cron sweep script |
| `/etc/cron.d/powerview-refresh` | Cron schedule |
| `/var/log/powerview-refresh.log` | Sweep log |

## After plugin updates

`npm update` / Homebridge UI updating `homebridge-powerview-2` will overwrite `index.js` and erase the per-move verify patch. The cron + config flags survive.

To re-apply the patch after an update:

1. Find the `setPosition` function in `index.js` (search for `PowerViewPlatform.prototype.setPosition`).
2. Inside the `if (!err) { ... }` block, after `callback(null);`, insert:
   ```js
   // post-move verify: RF-query this shade later to catch motor stalls.
   // Coalesce per-shade so N rapid taps collapse to 1 verify (kills HomeKit tile churn).
   this._verifyTimers = this._verifyTimers || {};
   if (this._verifyTimers[shadeId]) clearTimeout(this._verifyTimers[shadeId]);
   this._verifyTimers[shadeId] = setTimeout(function () {
       delete this._verifyTimers[shadeId];
       this.log("post-move verify %d/%d", shadeId, position);
       this.updatePosition(shadeId, position, true, function (e) {
           if (e) this.log("post-move verify failed for %d/%d: %s", shadeId, position, e.message);
       }.bind(this));
   }.bind(this), [40237, 55357, 27062].includes(shadeId) ? 45000 : 30000);
   ```
3. `sudo systemctl restart homebridge`.

## Restore / rollback

Plugin only:
```
sudo cp /var/lib/homebridge/node_modules/homebridge-powerview-2/index.js.bak.20260425-222524 \
        /var/lib/homebridge/node_modules/homebridge-powerview-2/index.js
sudo systemctl restart homebridge
```

Config only:
```
sudo cp /var/lib/homebridge/config.json.bak.20260425-221255 /var/lib/homebridge/config.json
sudo systemctl restart homebridge
```

Cron only:
```
sudo trash /etc/cron.d/powerview-refresh /usr/local/bin/powerview-refresh.sh
```

## Diagnostic commands

```
# Watch homebridge log for PowerView events
sudo tail -f /var/lib/homebridge/homebridge.log | grep PowerView

# Force a sweep right now
sudo /usr/local/bin/powerview-refresh.sh

# Tail the sweep log
tail -f /var/log/powerview-refresh.log

# RF-query a single shade
curl -s "http://powerview-hub.local/api/shades/40237?refresh=true" | python3 -m json.tool
```

## Side note (separate issue)

`config.json` has the Flo-by-Moen password in plaintext. Worth rotating and moving behind credentials managed elsewhere.
