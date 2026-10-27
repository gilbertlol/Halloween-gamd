'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-store-'));
const store = require('../server/store');

test('the first player to use a name claims it and gets a recovery code', () => {
  const r = store.claimProfile('Gorlak');
  assert.ok(r.ok);
  assert.match(r.code, /^NF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const pub = store.publicProfile(r.profile);
  assert.strictEqual(pub.secretHash, undefined, 'hash never leaves the server');
  assert.strictEqual(pub.salt, undefined);
  assert.strictEqual(r.profile.secretHash.includes(r.code), false);
});

test('a claimed name needs its code; case, dashes and spacing in the code do not matter', () => {
  const first = store.claimProfile('Igor');
  assert.strictEqual(store.claimProfile('Igor').ok, false, 'no code');
  assert.strictEqual(store.claimProfile('igor ', 'NF-AAAA-BBBB-CCCC-DDDD').ok, false, 'wrong code, same name in another case');
  const again = store.claimProfile('IGOR', first.code.toLowerCase().replace(/-/g, ' '));
  assert.ok(again.ok, 'right code, any formatting');
  assert.strictEqual(again.code, undefined, 'no new code on a normal join');
  assert.strictEqual(again.profile, first.profile, 'same profile, relics and unlocks kept');
});

test('profiles from before name protection are claimed by the next player', () => {
  const p = store.getProfile('OldTimer'); // legacy: created without a secret
  p.wins = 4;
  const r = store.claimProfile('OldTimer');
  assert.ok(r.ok && r.code);
  assert.strictEqual(r.profile.wins, 4);
  assert.strictEqual(store.claimProfile('OldTimer').ok, false, 'now protected');
});
