# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added
- **Slider debounce** (`setPositionDebounceMs`, default 1500ms). Dragging the
  HomeKit slider fires a stream of position updates ~1s apart; the shade used to
  chase every intermediate value. Now the plugin acks HomeKit instantly and only
  sends the final value in a burst, so the shade moves once to the target.
  Set to `0` for the previous send-every-change behavior.

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
