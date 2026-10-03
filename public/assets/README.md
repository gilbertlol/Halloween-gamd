# Nightfall asset spec

## What is in here now

The shipped art is four atlases (generated with ChatGPT, see `HANDOFF.md`):

| file | grid | contents |
|---|---|---|
| `characters.png` | 8 × 8 | rows: blue / amber / purple survivor, ghost, zombie, crawler, imp, demon. Column pairs: south, east, north, west; each pair is a two-frame walk cycle (`_s`/`_s2`, `_e`/`_e2`, …). |
| `props.png` | 6 × 6 | keys, doors, gates, the rune portal (exit), chests, relics, pumpkins, gravestones, coffins, altar states, levers, plates |
| `terrain.png` | 6 × 6 | stone / forest / wood floors, masonry walls, mud, water, webs, occult, moss, lava, bones, sigils |
| `jumpscares.png` | 2 × 2 | ghost, zombie, crawler, demon faces (full-screen scares, picked by the monster that got you) |

`manifest.json` maps every sprite the game uses to an atlas cell:

```json
"atlases": { "props": { "file": "props.png", "cols": 6, "rows": 6 } },
"sprites": { "altar": { "atlas": "props", "col": 0, "row": 5 } }
```

The loader cuts the cell out and trims transparent padding (`"trim": false`
keeps the whole cell, used for terrain). A sprite can also be a plain file
path (`"zombie_e": "sprites/zombie_e.png"`). Directional sprites use the
suffixes `_s _e _n _w`; the game falls back to `_s`, then to the bare key.
`themes` picks floor variants, accents, walls and decorative props per night.

Anything missing from the manifest keeps the built-in procedural fallback,
so files can be replaced one at a time.

## Video (`video/`)

| file | use |
|---|---|
| `intro.webm` | opening cinematic (VP9 + Opus), played once per room with sound |
| `intro.mp4` | same cinematic (H.264 + AAC) for browsers without VP9, such as Safari |
| `intro-muted.webm` | silent loop behind the lobby |

The server freezes the night until every client reports that its cinematic
ended or was skipped (safety limit `INTRO_MAX_SECONDS` in `server/index.js`),
so the video can be any length.

## Audio

`audio/music.mp3` (the intro's string score, looped under the synth bed) and
`audio/scream.mp3` (the jump-scare scream) are included. Everything else is
synthesized. To add more, drop files in `audio/` and list them under `"audio"`
in the manifest using the keys below.

| key            | file                       | length    | plays when |
|----------------|----------------------------|-----------|------------|
| `music`        | `audio/music_ambient.ogg`  | 60–180 s, seamless loop | throughout a night (looped) |
| `scream`       | `audio/scream.ogg`         | 0.7–1.2 s | jump scare |
| `zombie`       | `audio/zombie_groan.ogg`   | 1–2 s     | zombie within earshot |
| `ghost`        | `audio/ghost_wail.ogg`     | 2–3 s     | ghost within earshot |
| `crawler`      | `audio/crawler_skitter.ogg`| 0.5–1 s   | crawler patrolling |
| `crawler_dash` | `audio/crawler_dash.ogg`   | 0.5–1 s   | crawler lunges |
| `imp`          | `audio/imp_giggle.ogg`     | 0.6–1 s   | imp nearby / imp teleports |
| `demon`        | `audio/demon_growl.ogg`    | 1.5–2 s   | demon patrolling |
| `demon_roar`   | `audio/demon_roar.ogg`     | 1.5–2.5 s | demon spots a player |
| `whisper`      | `audio/whisper.ogg`        | 1–2 s     | random ambient scare |
| `knock`        | `audio/knock.ogg`          | 1–2 s     | random ambient scare |
| `creak`        | `audio/creak.ogg`          | 1–2 s     | random ambient scare |
| `key`          | `audio/key_pickup.ogg`     | ≤1 s      | key found |
| `fragment`     | `audio/fragment_pickup.ogg`| ≤1.5 s    | rune fragment found |
| `item`         | `audio/relic_pickup.ogg`   | ≤2 s      | relic found |
| `door`         | `audio/door_open.ogg`      | 1–1.5 s   | locked door opened |
| `bell`         | `audio/exit_bell.ogg`      | 3–5 s     | altar solved, exit opens |
| `caught`       | `audio/caught.ogg`         | ≤1 s      | a player is taken |
| `wrong`        | `audio/altar_wrong.ogg`    | 1–2 s     | wrong rune offering |
| `victory`      | `audio/victory.ogg`        | 3–6 s     | night survived |
| `defeat`       | `audio/defeat.ogg`         | 3–6 s     | night lost |

The monster voices are also used for the **phantom** sounds (fake approaches),
slightly muffled, so one file per monster covers both.
