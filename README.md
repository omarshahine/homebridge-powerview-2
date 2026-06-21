# homebridge-powerview-gen2

[![npm](https://img.shields.io/npm/v/homebridge-powerview-gen2.svg)](https://www.npmjs.com/package/homebridge-powerview-gen2)

Homebridge plugin for [Hunter Douglas PowerView](https://www.hunterdouglas.com/operating-systems/motorized/powerview-motorization) shades on **Generation 1 & 2 hubs**, with post-move verify and self-healing to keep HomeKit tiles accurate.

A continuation of [`owenselles/homebridge-powerview-2`](https://github.com/owenselles/homebridge-powerview-2) (last upstream commit Jan 2024, npm package abandoned), republished under a maintained npm name with resilience features for installs that see HomeKit tile drift on Gen 2 hubs.

## Installation

Install from the Homebridge UI (search **Hunter Douglas PowerView (Gen 1 & 2)**), or from the command line:

```
npm install -g homebridge-powerview-gen2
```

Then configure it from the Homebridge UI, or add the `PowerView` platform to your `config.json`:

```json
{
  "platforms": [
    { "platform": "PowerView" }
  ]
}
```

The hub is auto-discovered via the default `powerview-hub.local` mDNS name. The defaults work for most setups.

## Resilience features

- **Coalesced post-move verify.** After every commanded move, schedule one RF query to the hub to catch motor stalls / hub-cache drift. Coalesced per shade — N rapid taps collapse to 1 verify, instead of N stacked timers churning HomeKit characteristic state.
- **In-plugin heal sweep.** A periodic sequential `?refresh=true` walk across every shade catches drift the hub cache misses (e.g. shades moved via a Pebble remote). Configurable via `healSweepIntervalMinutes` (default twice daily; `0` disables).
- **Configurable slow-shade list.** Some shades (heavy fabric, long travel) need a longer settle before the verify fires. Configure via `slowShades` + `slowVerifyDelay`.

All options are editable from the Homebridge UI. See [`docs/CABIN_NOTES.md`](docs/CABIN_NOTES.md) for the full rationale.

```jsonc
{
  "platform": "PowerView",
  "pollShadesForUpdate": true,        // recommended ON for Gen 2
  "refreshShades": false,             // leave OFF on Gen 2 (HomeKit timeouts)

  "enablePostMoveVerify": true,       // default true; set false to disable verify
  "defaultVerifyDelay": 30000,        // ms; verify fires this long after setPosition
  "slowVerifyDelay": 45000,           // ms; used for slowShades
  "slowShades": [40237, 55357, 27062],// shade IDs that travel slowly
  "healSweepIntervalMinutes": 720     // RF-refresh sweep interval; 0 to disable
}
```

## About PowerView shades

Supported Shades:

 * Roller Shades.
 * Shades with Horizontal Vanes (e.g. Silhouette, Pirouette). The main accessory controls the vertical movement of the shades, and a slider under Details controls the tilt of the vanes when closed.
 * Shades with Vertical Vanes (e.g. Luminette). The main accessory controls the horizontal movement of the shades, and a slider under Details controls the tilt of the vanes when closed.
 * Top-Down/Bottom-Up Shades (e.g. Duette). You will get two accessories, one for the bottom of the shade, and one of the top. They can be controlled independently or combined using HomeKit scenes.

Shades can participate in HomeKit scenes and automations.

## Configuration

Just specifying the platform should work for most people — the hub is found using the default `powerview-hub.local` mDNS hostname.

### Hostname or IP

If your PowerView hub is configured with a different default hostname, you can specify that, or the hub's IP address, by adding a `host` key to the platform configuration:

```
"host" : "192.168.1.1"
```

### Shade Types

The plugin uses the information from the PowerView hub to determine the types of shades, however it doesn't yet know all of the possible values. You may see the following warning in your log:

```
*** Shade 12345 has unknown type 66, assuming roller ***
```

If you see this, first please file an issue and provide details about the kind of shade that this is, so I can correctly recognize it in future versions.

You can then add a `forceRollerShades`, `forceTopBottomShades`, `forceHorizontalShades`, or `forceVerticalShades` key to your `config.json` to force shades to be a certain type, e.g.:

```
"forceTopBottomShades": [ 12345, 98765 ]
```

## Shade Examples

For all shades, you can tab the accessory icons in the Home app to open and close the shades, or long-press to set any arbitrary position between closed and 100% open.

![Roller Shades](https://i.imgur.com/Ti2mc5z.png)

### Horizontal and Vertical Shades

For shades with horizontal or vertical vanes, after long-pressing you can tap Details to adjust the tilt angle. For horizontal shades this will range from 0&deg; to 90&deg;, where the vanes are closed at 0&deg;, and the vanes tilted fully open at 90&deg;. For vertical shades it will range from -90&deg; to 90&deg;, with the shades fully open at 0&deg;, and fully closed in either direction at -90&deg; and 90&deg;.

Adjusting the vane tilt angle will automatically close the shades if necessary, likewise adjusting the standard shade position will automatically return the vanes to 0&deg;. When creating scenes, you should ensure that if the scene intends to tilt the vanes, the shade is Closed in the scene; likewise if the scene is intended to set a shade position, that the tilt is set to 0&deg;. HomeKit isn't smart enough to update the scene itself.

![Horizontal Shades](https://i.imgur.com/CPNtR4g.png)

### Top-Down/Bottom-Up Shades

For shades with a movable top and bottom, two accessory controls will be created; one for the movable bottom of the shade, and the other for the movable top.

These can be controlled independantly, or combined in scenes.

![Top-Down/Bottom-Up Shades](https://i.imgur.com/ZFZXuPK.png)
![Top-Down/Bottom-Up Scene](https://i.imgur.com/ylG0Yrp.png)
