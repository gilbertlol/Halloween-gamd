# NIGHTFALL — co-op horror escape

A 2D online multiplayer Halloween game. Up to six players share one dark map,
hunted by monsters they cannot fight. Find the keys, open the doors, collect
the rune fragments, read the altar, and run for the exit before the clock runs
out. If the monsters take all of you, the night wins.

![lobby](docs/lobby.png)

## Play

```bash
npm install
npm start            # http://localhost:3000
```

One player creates a room and shares the 4-letter code (or the link
`/?room=CODE`). The host picks the night and starts. Everyone in the room
plays the same level at the same time.

| Control | Action |
|---|---|
| WASD / arrow keys / touch stick | move |
| walk into a locked door | opens it if the team holds its key |
| E / Space / the glowing action button | read the altar, or drop a flare as a ghost; the button only appears when there is something to do |
| stand beside a fallen friend | revive them (2 s) |
| M | mute |
| B | brightness: Dim, Normal, Bright (remembered per device) |

## Features

- **Tonight's Night.** One seeded map per day for everyone, with its own
  leaderboard that resets at midnight UTC. No unlock needed.
- **Open rooms.** Rooms are public by default and listed in the lobby, so
  strangers can join with one click; hosts can close a room to friends only.
- **A whisper points the way.** After 15 seconds without team progress, a
  compass needle shows each player the way to the nearest reachable key,
  fragment, altar or exit, following the corridors.
- **Ghosts stay in the game.** A downed player drifts as a ghost with wider
  sight, can be revived wherever they are, and drops a flare every 30 s that
  lights an area and reveals monsters for the team.
- **Tension events.** One to three times a night: a blackout halves vision
  for ten seconds, the bell tolls and everything hunts for fifteen, or a door
  you opened slams locked for twenty.
- **Close calls.** A monster that passes within a tile and misses you is a
  close call: chime, bonus points, and a streak multiplier that resets when
  you go down. Score is shown live.
- **Readable dark.** The camera zooms to your lantern's reach and keeps you centred, a minimap remembers what the team has explored, and a brightness setting lets each player tune the night.
- **First-night tutorial.** Until a device has escaped once, short tips walk
  the player through moving, the first rune, keys and doors, the altar and
  the exit, with an arrow along the corridors. A warning appears the first
  time a monster comes into view. Players can skip the tips.
- **Haptics.** On Android phones, close calls, jump scares, events, pickups and
  a heartbeat when a monster is very close vibrate the phone. iPhones have no
  vibration API; on iOS 18+ a light system tick is used as a best effort.
  Muting also silences vibration.
- **Name protection.** The first device to use a name claims it and gets a
  recovery code (shown in the room panel). Joining as that name from another
  device requires the code. Only a salted hash is stored on the server.
- **Share card.** The end screen draws a result card with copy-text, invite
  link and save-image buttons.
- **Survivors.** Three survivor looks unlock by surviving nights (cosmetic).

- **Eight nights, Easy to Extreme.** Each level scales the clock, the map
  size, the number and speed of monsters, the vision radius, how many locked
  doors and rune fragments there are, and how often the jump scares hit.
- **Procedural maps, always solvable.** Rooms, corridors, locked doors and
  keys are generated per game. Keys are always placed on the side of a door
  you can already reach, loops never bypass a lock, and every map is verified
  with a key-aware flood fill before it is served.
- **The mystery.** Rune fragments scattered over the map each carry a rune
  and a mark (I, II, III…). At the altar you offer the runes in order to open
  the exit. A wrong offering costs 15 seconds and wakes an imp. From Night 6
  the altar no longer reminds you of the order.
- **Relics for later nights.** Each night from 2 to 7 hides a relic that
  stays with your name forever: Lantern (vision), Gravekeeper Boots (speed),
  Skeleton Key (force one door per night), Amulet (survive one catch), Seer's
  Eye (keys and fragments glow through the dark), Salt Ward (demons lose you
  faster).
- **Monsters move in lanes.** Every monster moves in straight lines along a
  row or column and only turns at tile centres: zombies patrol, ghosts drift
  through walls toward you, crawlers wait and lunge, imps zig-zag and
  teleport, demons charge the moment you cross their line of sight.
- **Sound that lies to you.** The intro's string score loops over a
  synthesized drone and wind, random whispers,
  knocks and creaks, a heartbeat that quickens with proximity, positional
  monster voices panned and attenuated by distance, *phantom* monster sounds
  from empty corridors, and monsters that go silent for a while so they can
  come out of nowhere.
- **Opening cinematic.** The intro video plays the first time a room begins
  a night, with a Skip button. The server holds the night frozen until every
  player's video has ended or been skipped, so slow connections never cut it
  short and nobody loses clock time. The muted version loops behind the
  lobby, where a button replays the full intro.
- **Jump scares.** Random, when you are caught, and when the altar rejects
  you. Screen shake, chromatic flash, scream.
- **Co-op rules.** A caught player goes down; a teammate can revive them.
  The night is lost only when everyone still inside is down. Reaching the
  open exit starts a 15-second countdown for the rest of the team.
- **Hall of the Survived.** A persistent leaderboard (score, team, night) and
  per-name profiles with unlocked nights and relics, stored as JSON on disk.

## Assets

Art comes from four atlases in `public/assets/` (characters with four
facings, props, themed terrain, jump-scare faces), mapped to game sprites by
`public/assets/manifest.json`. Each night has its own terrain theme and
decorations. All audio is synthesized with WebAudio; to add recorded sound,
list files under `audio` in the manifest. Anything not in the manifest keeps
a built-in procedural fallback, so the game runs with no assets at all. See
[`public/assets/README.md`](public/assets/README.md) for the full spec.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/gilbertlol/Halloween-gamd)

Any Node host works (Render, Railway, Fly.io, a VPS). The server is a single
process that serves the static client and the WebSocket on the same port.
Config files are included for the three common free tiers:

| Host | File | Notes |
|---|---|---|
| Render | `render.yaml` | free web service; sleeps after 15 min idle, no persistent disk on the free plan |
| Fly.io | `fly.toml` | uses the Dockerfile and a 1 GB volume for scores and relics |
| Railway | `railway.json` | Nixpacks build; add a volume mounted at `/app/data` |

```bash
docker build -t nightfall .
docker run -p 3000:3000 -v nightfall-data:/app/data nightfall
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP + WebSocket port |
| `DATA_DIR` | `./data` | where `scores.json`, `profiles.json` and `events.ndjson` live |
| `ADMIN_TOKEN` | unset | enables the private stats page at `/admin/stats?token=<value>` |
| `DATABASE_URL` | unset | Postgres connection string; when set, all data is kept in the database |

Put it behind HTTPS (the client switches to `wss://` automatically). Rooms are
in memory, so run one instance, or pin players to one instance with sticky
sessions if you scale out.

## Keeping data when the server restarts (free database)

Render's free plan wipes the server's disk on every deploy and restart, so
by default scores, protected names, relics and stats reset. Point the game
at a free Postgres database and they survive:

1. Create a free account at [neon.com](https://neon.com) (sign in with
   GitHub) and create a project named `nightfall`. Pick the region closest to
   your Render service (Render's default, Oregon, is AWS `us-west-2`).
2. On the project dashboard click **Connect** and copy the connection string.
   It looks like `postgresql://user:password@ep-....neon.tech/neondb?sslmode=require`.
3. In Render, open the service, go to **Environment**, add `DATABASE_URL` with
   that string, and save. Render redeploys.
4. In the deploy log you should see `[db] connected, tables ready` and
   `storage: database`.

The server creates its tables on first start and copies any existing file
data in. All data is held in memory while the server runs and written to the
database within a few seconds of each change, and again on shutdown. If the
database cannot be reached at startup, the server retries for about 30
seconds, then runs on local files with a warning in the log, without ever
overwriting the database. Analytics events older than 60 days are pruned to
stay inside the free storage.

Without `DATABASE_URL` everything stays in JSON files in `DATA_DIR`, which is
the simplest setup for local development. Run the database tests with
`TEST_DATABASE_URL=postgres://... npm run test:db`.

## Analytics

The server records anonymous gameplay events (visits, joins, nights started
and finished, deaths with the monster, time and position, quits mid-night,
tutorial steps, intro watched or skipped) with a random per-device id, never
a name. Open `/admin/stats?token=<ADMIN_TOKEN>` for the funnel, win rate per
night, deaths by monster and by minute, quits, tutorial completion and a death
heatmap on today's Tonight's Night map (`/admin/stats.json` for raw numbers).
Events are kept in `DATA_DIR/events.ndjson`; on a host without a persistent
disk they reset on every deploy.

## Operations and launch

- [`docs/SERVICES.md`](docs/SERVICES.md): the services that run the game (Render, Neon, UptimeRobot, GitHub), where settings live, limits, and a runbook.
- [`marketing/LAUNCH.md`](marketing/LAUNCH.md): trailers, share images and ready-to-post launch copy.

## Development

```bash
npm run dev          # restarts on file change
npm test             # map solvability + gameplay bot tests
```

Layout:

```
server/index.js    HTTP static server, WebSocket rooms, lobby, leaderboard
server/game.js     authoritative simulation: players, monsters, doors, puzzle
server/mapgen.js   procedural dungeon generator + solvability verifier
server/levels.js   the eight nights, monster stats, relics
server/store.js    scores and profiles in memory, saved to files or the database
server/db.js       optional Postgres persistence (DATABASE_URL)
server/analytics.js anonymous gameplay events and the stats summary
public/client.js   rendering, fog of war, HUD, puzzle, scares, input
public/audio.js    synthesized ambient score, voices, phantoms, stingers
public/assets.js   optional external sprite/audio loader
```

Protocol: clients send `join`, `setLevel`, `start`, `input {dx,dy}`,
`solve {seq}`; the server broadcasts `room`, `start` (map), `state`
(15 snapshots/s with events), and `end`.
