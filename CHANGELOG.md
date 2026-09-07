# Changelog

All notable changes to this project are documented here.

## 1.3.1

### Fixed
- **Calibrate button in the Homebridge UI silently did nothing** (#5). The
  button gated the command behind `window.confirm()`, but Config UI X renders
  plugin custom UIs in a sandboxed iframe, and a sandbox without `allow-modals`
  suppresses the dialog and returns `false`. The handler returned at that guard
  before its `try` block, so no request was sent and no toast or status was
  shown either — the click was completely invisible. Confirmation is now done
  in-page: the first click arms the button ("Confirm calibrate", solid red,
  with a warning line), the second click runs it. The armed state cancels
  itself after 8 seconds, and using any other action on the row disarms it.
  `Check` and `Jog` were never affected.

## 1.3.0

### Added
- **Shade tools in the Homebridge UI** (custom settings page). Per-shade
  **Check** (real RF query), **Jog**, and **Calibrate** buttons, plus a hub
  scene list with per-shade target positions and an Activate button. Lets you
  recalibrate a shade remotely without the PowerView app. The regular settings
  form is still shown underneath. Adds a runtime dependency on
  `@homebridge/plugin-ui-utils`.
- `docs/SHADE_LIMITS.md`: step-by-step guide to setting electronic top/bottom
  limits with a Gen 2 Pebble/Surface remote (from Hunter Douglas' official
  procedure), so scenes can be plain 0% / 50% / 100%.

## 1.2.0

### Added
- **Hide scenes** (`excludeScenes`). A list of hub scenes to keep out of
  HomeKit when `exposeScenes` is on. Match by scene name (case-insensitive) or
  numeric hub scene id. Excluded scenes are never exposed as switches, and any
  switch previously exposed for them is removed on the next reconcile. The scene
  still lives on the hub for physical remotes and the PowerView app — only the
  HomeKit switch is hidden. Useful for scenes that have no HomeKit purpose.
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
