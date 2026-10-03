'use strict';

// Every level scales the whole experience: time limit, monster roster and
// speed, map size, vision radius, number of keys/doors, mystery fragments,
// jump-scare frequency and the relic hidden on the map for later levels.

const ITEMS = {
  lantern:  { name: 'Lantern of the Drowned', desc: '+1.5 tiles of vision on every level.' },
  boots:    { name: 'Gravekeeper Boots',      desc: '+12% movement speed.' },
  skeleton: { name: 'Skeleton Key',           desc: 'Opens one locked door per level without its key.' },
  amulet:   { name: 'Amulet of the Fallen',   desc: 'Survive one catch per level.' },
  eye:      { name: "Seer's Eye",             desc: 'Keys and fragments glow through the dark.' },
  ward:     { name: 'Salt Ward',              desc: 'Demons lose your trail twice as fast.' },
};

const LEVELS = [
  {
    n: 1, name: 'The Graveyard', difficulty: 'Easy',
    time: 240, cols: 3, rows: 3, cellW: 11, cellH: 9,
    monsters: { zombie: 2, ghost: 1 }, speed: 1.0, vision: 7.0,
    keys: 1, fragments: 2, loops: 2, scare: [70, 120], item: null,
    intro: 'The dead are restless tonight. Find the rune fragments, read the altar, and leave before the bell tolls.',
  },
  {
    n: 2, name: 'The Crypt', difficulty: 'Easy',
    time: 270, cols: 4, rows: 3, cellW: 11, cellH: 9,
    monsters: { zombie: 3, ghost: 2 }, speed: 1.05, vision: 6.5,
    keys: 2, fragments: 3, loops: 3, scare: [55, 100], item: 'lantern',
    intro: 'Something drowned here long ago still carries a light. Take it, if you dare.',
  },
  {
    n: 3, name: 'Haunted Manor', difficulty: 'Normal',
    time: 300, cols: 4, rows: 4, cellW: 11, cellH: 9,
    monsters: { zombie: 3, ghost: 2, crawler: 2 }, speed: 1.1, vision: 6.0,
    keys: 2, fragments: 3, loops: 4, scare: [45, 90], item: 'boots',
    intro: 'The manor remembers every guest. The crawlers remember them better.',
  },
  {
    n: 4, name: 'The Catacombs', difficulty: 'Normal',
    time: 330, cols: 5, rows: 4, cellW: 11, cellH: 9,
    monsters: { zombie: 4, ghost: 2, crawler: 3, imp: 1 }, speed: 1.15, vision: 5.5,
    keys: 3, fragments: 4, loops: 5, scare: [40, 80], item: 'skeleton',
    intro: 'Miles of bone. An imp laughs somewhere in the dark and nothing is where it was a moment ago.',
  },
  {
    n: 5, name: 'The Asylum', difficulty: 'Hard',
    time: 360, cols: 5, rows: 5, cellW: 11, cellH: 9,
    monsters: { zombie: 4, ghost: 3, crawler: 3, imp: 2, demon: 1 }, speed: 1.2, vision: 5.0,
    keys: 3, fragments: 4, loops: 6, scare: [35, 70], item: 'amulet',
    intro: 'The patients never left. Neither did the thing they summoned in ward six. Do not stand in its line of sight.',
  },
  {
    n: 6, name: "Demon's Cathedral", difficulty: 'Hard',
    time: 390, cols: 6, rows: 5, cellW: 11, cellH: 9,
    monsters: { zombie: 5, ghost: 3, crawler: 4, imp: 3, demon: 2 }, speed: 1.3, vision: 4.5,
    keys: 4, fragments: 5, loops: 7, scare: [30, 60], item: 'eye',
    intro: 'A cathedral built upside down. The congregation is still in attendance.',
  },
  {
    n: 7, name: 'The Abyss', difficulty: 'Very Hard',
    time: 420, cols: 7, rows: 5, cellW: 11, cellH: 9,
    monsters: { zombie: 5, ghost: 4, crawler: 5, imp: 4, demon: 3 }, speed: 1.4, vision: 4.0,
    keys: 4, fragments: 5, loops: 8, scare: [25, 50], item: 'ward',
    intro: 'There is no floor here, only the memory of one. Keep moving.',
  },
  {
    n: 8, name: 'Nightmare', difficulty: 'Extreme',
    time: 420, cols: 7, rows: 6, cellW: 11, cellH: 9,
    monsters: { zombie: 6, ghost: 5, crawler: 6, imp: 5, demon: 4 }, speed: 1.55, vision: 3.5,
    keys: 5, fragments: 6, loops: 9, scare: [18, 40], item: null,
    intro: 'You were never meant to get this far. Everything that hunts in the dark is here, and it is faster than you.',
  },
];

// Base speeds in tiles per second (multiplied by the level speed factor).
const MONSTERS = {
  zombie:  { speed: 1.7, radius: 0.42, turnChance: 0.12 },
  ghost:   { speed: 1.7, radius: 0.40, retarget: [3, 6] },
  crawler: { speed: 1.2, radius: 0.38, dash: 6.0, wait: [1.2, 2.6], dashTiles: [3, 7] },
  imp:     { speed: 3.0, radius: 0.32, turnChance: 0.5, teleport: [9, 16] },
  demon:   { speed: 1.9, radius: 0.48, charge: 6.5, sight: 9, memory: 1.6 },
};

const PLAYER = { speed: 4.3, radius: 0.3, reviveSeconds: 2.0 };

const RUNES = ['ᚠ', 'ᚢ', 'ᚦ', 'ᚨ', 'ᚱ', 'ᚲ', 'ᚷ', 'ᚹ', 'ᚺ', 'ᚾ', 'ᛁ', 'ᛃ'];

module.exports = { LEVELS, MONSTERS, PLAYER, ITEMS, RUNES };
