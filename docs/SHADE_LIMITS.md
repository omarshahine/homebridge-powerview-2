# Setting Shade Travel Limits (PowerView Gen 2, Pebble/Surface remote)

Why this matters: the hub's `0` and `65535` (HomeKit 0% and 100%) are the shade's
**electronic bottom and top limits**. Set those limits correctly on the shade itself and
every scene can just say 100% / 50% / 0%. No more capturing 98% or 1% as a workaround.

Source: Hunter Douglas, [Set Electronic Limits for Legacy PowerView](https://help.hunterdouglas.com/hc/en-us/articles/48739987220756-Set-Electronic-Limits-for-Legacy-PowerView)
(applies to all PowerView made before Fall 2022, which includes every Gen 2 hub install).

## Which procedure applies to the cabin shades

The cabin shades the hub reports as `type 1` are Designer Roller / Screen with firmware
2.2.2754 (2018-era), so they use the **fine-adjustment ("First Method")** steps below.

| Shade | Hub ID | Type |
|---|---|---|
| Kitchen Sink Blinds | 57249 | roller |
| Sliding Door Right Blinds | 40237 | roller |
| Sliding Door Left Blinds | 55357 | roller |
| Fireplace Blinds | 27062 | roller |
| Couch Blinds | 51934 | roller |
| Stairs Blinds | 40339 | roller |
| Transom North / South / East | 8517 / 38361 / 47409 | roller |
| Main Bedroom, Twin N/S, Double, Transom Blinds | 15050, 35080, 30417, 21120, 26341 | type 6 (different product; use the app or ask HD which method) |

## Two buttons you'll be using

- **Programming button** = the small button on the shade's headrail (has a tiny LED next to it).
  Also called the "manual button". Short press = move/stop the shade. **Holding it 6+ seconds
  starts a full recalibration**, so during limit-setting never hold it longer than ~5 s.
- **STOP** on the remote. Hold ~6 s until the remote's lights blink = **programming mode**.
  It times out after ~20 s; any button press extends it another 20 s.

## Before you start (2 minutes, saves 20)

1. **Test the remote can enter programming mode.** Hold STOP ~6 s. Lights should blink.
   If they don't, replace the remote's batteries first.
2. **Make sure the shade is joined to a group on that remote.** Press the group number and
   press OPEN; the shade should move. If not, join it (see bottom of this doc).
3. **Optional but recommended: factory-limit reset first.** Hold the shade's programming
   button ~6 s until it jogs, then let go. The shade runs fully up and fully down on its own.
   **Don't interrupt it.** This restores the limits set at the factory (the "hard stops").
   Do this if a shade has been mis-behaving; then only adjust what still needs it.

## Set the TOP limit

You'll want this when the shade doesn't tuck all the way into the headrail at 100%,
or to line up side-by-side shades (Sliding Door L/R, the transoms).

1. On the remote, press the **group number** the shade is joined to.
2. **Hold the shade's programming button** (under 5 s!) and, while holding it,
   **press and release OPEN** on the remote. Release the programming button.
3. The shade moves to its current top limit if it isn't there already, and the LED by
   the programming button turns **solid red** = fine-adjustment mode. You now have
   **one minute** to finish steps 4-6.
4. Use **OPEN / STOP / CLOSE** on the remote to nudge the shade to the exact top position
   you want. It moves slowly in this mode.
5. **Deselect all group numbers** on the remote, then hold **STOP** ~6 s until the lights
   blink (programming mode). Leave it blinking.
6. **Press and release OPEN.** The shade jogs once = new top limit saved, red LED goes out.
   (Shades built before Oct 2019 need the programming button held during this press;
   if the plain OPEN press doesn't jog it, redo step 6 while holding the programming button.)
7. Hold STOP ~6 s until the lights stop blinking (or just wait 20 s).
8. Run the shade down a bit and back up to confirm.

Notes: the electronic top limit can never be higher than the hard stop. When aligning
neighbours, match everyone to the shade with the *lowest* hard stop.

## Set the BOTTOM limit

Same dance, CLOSE instead of OPEN. Use it when the bottom rail should sit differently on
the sill or floor at 0%.

1. On the remote, press the **group number** the shade is joined to.
2. **Hold the shade's programming button** (under 5 s) and, while holding it,
   **press and release CLOSE** on the remote. Release the programming button.
3. Shade moves to its current bottom limit; LED turns **solid red**. One-minute clock starts.
   If it gets no movement command within a minute it reverts to the old limit.
4. Use **OPEN / STOP / CLOSE** to nudge to the exact bottom position you want.
5. **Deselect all groups**, hold **STOP** ~6 s until blinking.
6. **Press and release CLOSE.** Shade jogs = saved, red LED off.
   (Pre-Oct-2019 shades: hold the programming button while pressing CLOSE.)
7. Hold STOP ~6 s to exit programming mode.
8. Run it up a bit and back down to confirm.

## Undo a custom TOP limit (go back to the hard stop)

1. Run the shade to its current top limit.
2. Make sure **no group** is selected on the remote. Hold the programming button (under 5 s)
   and press and release OPEN, then release the button. Shade jogs = top limit cleared.
3. Now hold the programming button **6 s** until it jogs, release, and let the calibration
   run all the way up and down uninterrupted. Top limit is back at the hard stop.

## After the limits are right: fix the scenes

Once a shade's limits are where you want them, its scenes should hold clean values:

| Want | Hub value | HomeKit |
|---|---|---|
| fully open | 65535 | 100% |
| half | 32767 | 50% |
| closed | 0 | 0% |

Currently "Morning Blinds" stores 65421 / 64413 / 687 and "Evening Blinds" stores 657 for
Sliding Door Left, because they were captured from HomeKit percentages. Either re-save the
scenes in the PowerView app after moving each shade to a clean position, or have the scene
members rewritten over the hub API (`PUT /api/scenemembers/<id>`) so nothing is off by a percent.

Quick check from the Pi (`ssh hb-cabin`):

```bash
# what a shade physically reports (real RF query, ~3 s)
curl -s "http://192.168.1.202/api/shades/57249?refresh=true" | python3 -m json.tool

# what every scene tells every shade to do
curl -s http://192.168.1.202/api/scenemembers | python3 -m json.tool
```

## Appendix: joining a shade to a remote group

1. Hold STOP ~6 s until the remote blinks.
2. Press the group number you want the shade in.
3. Hold the shade's programming button (under 5 s) and press and release OPEN on the remote.
   Shade jogs = joined.
4. Hold STOP ~6 s to exit.

To remove from a group: same, but press CLOSE instead of OPEN in step 3.
