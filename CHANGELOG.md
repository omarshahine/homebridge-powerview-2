# Changelog

All notable changes to this project are documented here.

## 1.1.0

First release published to NPM as `homebridge-powerview-gen2`. Continuation of
the `homebridge-powerview-2` fork, prepared for Homebridge verification.

### Added
- **Config Settings GUI** (`config.schema.json`) — all options are now editable
  from the Homebridge UI.
- **Coalesced post-move verify.** After each commanded move, one RF query is
  scheduled to catch motor stalls and hub-cache drift. Coalesced per shade so
  rapid taps collapse to a single verify.
- **In-plugin heal sweep.** Periodic sequential RF-refresh walk across all
  shades catches drift the hub cache misses (e.g. shades moved by a Pebble
  remote). Replaces the previous out-of-process cron script.
- **Configurable polling** (`pollIntervalMs`) and **slow-shade tuning**
  (`slowShades`, `slowVerifyDelay`).

### Changed
- Homebridge 2.0 compatibility; dropped `request` in favor of native `fetch`.
- Quieter logging — routine status moved to debug level.
- Node engines updated to `^22 || ^24`.

### Notes
- Supports PowerView Generation 1 and 2 hubs.
- The platform alias remains `PowerView`, so existing `config.json` entries and
  cached accessories continue to work unchanged.
