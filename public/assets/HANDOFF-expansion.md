# Nightfall expansion assets

Copy the PNGs and `audio/` folder into `public/assets/`. Open `preview.html` to inspect the art and play the effects. The files are delivered as assets; no repository code was changed.

## Images

All nine PNGs have real alpha transparency and exact export dimensions.

| File | Size | Use |
|---|---|---|
| flare.png | 64×64 | Burning red road flare, overhead view |
| ghost_player.png | 64×64 | Spectral blue survivor for a downed player; distinct from hostile ghosts |
| compass.png | 64×64 | Antique brass pointer facing right; rotate in code |
| banner_blackout.png | 1280×300 | BLACKOUT |
| banner_bell.png | 1280×300 | THE BELL TOLLS |
| banner_door.png | 1280×300 | A DOOR SLAMS |
| portrait_blue.png | 256×256 | Dark-haired blue survivor |
| portrait_amber.png | 256×256 | Brown-haired amber survivor |
| portrait_purple.png | 256×256 | Silver-haired purple survivor |

Banners use the intro's actual DejaVu Serif font and #e39c4a gold, with a small dark shadow. Sprite and portrait exports use nearest-neighbor sampling. Keep image smoothing disabled when enlarging world sprites. The spectral sprite has mint coloring and alpha; adjust runtime opacity for the desired ghost strength. Portrait order corresponds to player0, player1 and player2.

## Sounds

Original synthesized stereo effects, 44.1 kHz, OGG Vorbis, with click-free edges and room below digital clipping. Durations include tails.

| File | Duration | Description | Existing audio hook |
|---|---|---|---|
| audio/close_call.ogg | 0.5 s | Bright rising two-note close-call chime | closecall |
| audio/bell_toll.ogg | 3 s | Single low iron bell toll with reverberation | event_hunt; optionally bell |
| audio/door_slam.ogg | 1.5 s | Iron impact, low body, metallic rattle | event_slam |
| audio/blackout.ogg | 1.5 s | Failing ballast buzz followed by a low thud | event_blackout |
| audio/flare_ignite.ogg | 1 s | Scrape, ignition pop and burning hiss | flare |
| audio/compass_whisper.ogg | 1.5 s | Breathy synthesized “this way” whisper | whisper |

The whisper uses Flite's synthesized SLT voice as a source and replaces pitched excitation with noise in speech bands. It is synthetic, not a recording of a human performer. The current hintWhisper() calls whisper(null), so the whisper sample also replaces other uses of that hook. Add a separate hint hook in code if compass-only playback is desired.

## Manifest

`manifest.additions.json` is a merge fragment, not a replacement manifest. Merge its `sprites` and `audio` entries into the current manifest, retaining the atlases, themes, music and scream. The verified audio keys match the current main branch. New image keys are proposed for Claude to consume in the flare/ghost/compass renderers, event banners and survivor picker.

Use `compass_arrow` for the new pointer: the existing `compass` key already names a terrain tile. Preserve that terrain mapping.

Higher-resolution generated art and audio-building sources are in `source/`. `build_audio.py` needs NumPy, SciPy and FFmpeg and uses `whisper-voice.wav`. Final PNG sizes, alpha channels, audio durations and decodability were checked; in-game placement and mix levels still require integration testing.
