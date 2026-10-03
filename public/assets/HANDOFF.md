# Halloween asset handoff

Generated visual assets for gilbertlol/Halloween-gamd. No game code or repository files were changed.

## Included sheets

- characters.png: eight rows, eight columns. Rows: blue survivor, amber survivor, purple survivor, ghost, zombie, crawler, imp, demon. Observed direction pairs left to right: south, east, north, west. Each pair offers two pose candidates; inspect and align before animating. Crawler direction distinction needs particular review.
- props.png: six rows, six columns. Rows: keys and wood doors; iron gates, rune portals and vertical wood doors; chests, scroll, journal, candle, flashlight; crystal, rune, locket, watch, gear, fuse; pumpkins, gravestone, coffin, tree, roots; altar states, lever states, pressure plate states. Doors and some props use an elevated/front view common in overhead games; check against the engine's map perspective.
- terrain.png: six rows, six columns. Stone, forest and mansion floors; masonry walls and corners; mud/water/webs/occult/moss/basalt surfaces; advanced crypt and demon-area floors. Test repeating edges and wall joins; generated textures are not verified seamless.
- jumpscares.png: two rows, two columns. Ghost, zombie, crawler, demon, in reading order. These front-facing faces are screen overlays.

## Integration

These are generated source atlases, not validated engine-ready sprites. Use actual PNG dimensions. For a nominal grid boundary use round(column * width / columns) and round(row * height / rows); six-cell sheets may not divide into integer cells. Review object boundaries and padding visually before cropping. Keep per-sprite trim offsets and a consistent bottom-center character anchor. Use nearest-neighbor scaling for world assets. Check alpha channels and edges in your target renderer.

Use collision boxes independent of decorative silhouettes. Keep door states paired. Apply world darkness, visibility masks and fog dynamically in code; preserve bright interactive accents. Persist collected keys and mystery items using game state rather than the art.

Suggested progression: easy graveyard with ghosts; normal mansion with zombies; hard catacombs with crawlers and imps; extreme ritual realm with demons. Monster count, speed, timer, vision radius, cardinal-only movement, multiplayer synchronization and leaderboard behavior belong in game code.

No sound effects, music, UI kit, collision data or tested seamless tiles are included. Jump-scare frequency and presentation are controlled by the engine.
