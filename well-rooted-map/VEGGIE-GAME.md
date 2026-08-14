# 🥕 Veggie Hunt — Pokémon Go for labeling vegetables

Kids run around the farm tagging veggies. Two ways to play, both against
the same API and scoring; veggies appear live as pins on
well-rooted-map.proc.io and scores at **/leaderboard**:

- **Any phone/tablet with GPS**: open **/tag** in the browser — big
  tappable menus, no name needed. Works on Android too. Built for weak
  field signal: menus are bundled (zero network to browse), a GPS watch
  keeps a fix warm, and claims queue in localStorage with idempotent
  retry (`cid` dedupe server-side) when the signal drops — tags are never
  lost and never double-counted. (Testing hook: `/tag?lat=..&lon=..`
  skips geolocation.)
- **iPhone / paired Apple Watch**: the Apple Shortcut below (synced to a
  watch via its ⓘ ▸ Show on Apple Watch).

**Family Setup caveat**: cellular Apple Watches set up WITHOUT their own
iPhone (Apple "Family Setup") do not get the Shortcuts app at all, and
their web viewer has no geolocation — kids with those watches should play
via /tag on a borrowed phone. A published watchOS App Store app would
reach them (Family Setup watches do have the on-watch App Store); that's a
future project.

## Rules

- **First find**: +10. Naming the variety (Watermelon) +13; the exact
  cultivar (Golden Midget Watermelon) +16. Harder names = more points.
- **Confirm** someone else's find (tag within ~12 m of it): +3, or +5 if
  you name the exact variety back.
- **Refine**: upgrade a generic find with the real name (+3 per
  specificity step, so "Melon (not sure)" → Golden Midget = +9).
- You can't score the same plant twice in a row, and there's a 15-second
  breather between tags (no button mashing).

Scores are always derived from the claims ledger, never stored. Wipe for a
new game day via **Reset game…** at the bottom of /leaderboard (asks for
the passphrase, set with `bunx wrangler secret put WIPE_PASS`; comparison
is constant-time), or `POST /api/veggie/wipe {pass}`, or directly:
`bunx wrangler d1 execute well-rooted-map --remote --command
"DELETE FROM claims; DELETE FROM veggies; DELETE FROM players;"`

## The Shortcut (build once, share to each kid)

In the iPhone **Shortcuts** app, create a shortcut named **Tag a Veggie**
with these 10 actions (type the action name into the search bar):

1. **Get Device Details** — set to **Device Name** *(no per-kid edit needed:
   the device name — "Ravi's iPhone" — is the identity; map it to a display
   name later via POST /api/veggie/name, or just send a `player` field too)*
2. **Get current location**
3. **Get contents of URL** — `https://well-rooted-map.proc.io/api/veggie/menu`
   (Method GET)
4. **Get dictionary value** — key `groups` in *Contents of URL*
5. **Choose from list** — list: *Dictionary Value*, prompt: `What did you find?`
6. **Get contents of URL** — same URL as step 3, Method **POST**, Request
   Body **JSON**, one field: `group` = *Chosen Item*
7. **Get dictionary value** — key `options` in *Contents of URL*
8. **Choose from list** — list: *Dictionary Value*, prompt: `Which kind?`
9. **Get contents of URL** — `https://well-rooted-map.proc.io/api/veggie/claim`,
   Method **POST**, Request Body **JSON**, four fields:
   - `device` = *Device Details* (step 1)
   - `label` = *Chosen Item* (step 8)
   - `lat` = *Current Location ▸ Latitude*
   - `lon` = *Current Location ▸ Longitude*
10. **Show result** — *Contents of URL* (step 9)

Then in the shortcut's settings (ⓘ) enable **Show on Apple Watch**.

**Distribute**: Share ▸ Copy iCloud Link, text it to each kid; they tap
*Add Shortcut*, change the step-1 Text to their own name, and it syncs to
their watch automatically (allow location on first run). On the watch it
runs from the Shortcuts app or a watch-face complication.

The menus are fetched from the server (`GET/POST /api/veggie/menu`), so
editing the taxonomy in `apps/web/worker/veggie-logic.ts` updates every
player's watch instantly — no shortcut changes needed.

## API (no auth; cooldown is the only rate limit)

- `GET /api/veggie/menu` → `{groups: [...]}`; `POST` with `{group}` →
  `{options: [...]}`
- `POST /api/veggie/claim` `{device?, player?, label, lat, lon}` → plain-text
  result (always 200 so Shortcuts shows the message instead of erroring).
  Identity key = `device` if present, else `player`; sending both stores the
  device→name mapping. Unnamed device keys display as Player-xxxx.
- `POST /api/veggie/name` `{device, name}` — set/change a display name
  (retroactive: leaderboard, pins, and messages all resolve through it)
- `GET /api/veggie/leaderboard.json`, `GET /api/veggie/points.geojson`
- Pages: `/leaderboard` (auto-refreshing), pins render live on the map

Known trade-off for a family game: no auth, and two simultaneous claims on
the same new plant can both score as discoveries (claim resolution isn't
transactional). Fine at nephew scale.
