/**
 * Zusatzpakete sind keine Konzerte.
 *
 * Laufen ohne Netz und ohne Chrome:  node --test
 */
const test = require('node:test');
const assert = require('node:assert');

const { istZusatzpaket } = require('./scrape.js');

test('Pakete vorne', () => {
  assert.ok(istZusatzpaket('Premium Tickets - koRn'));
  assert.ok(istZusatzpaket('VIP: Rod Stewart + Special Guest'));
});

test('Upgrades hinten', () => {
  assert.ok(istZusatzpaket('Enkay - Meet & Greet Upgrade'));
  assert.ok(istZusatzpaket('Placebo - VIP Upgrade'));
  assert.ok(istZusatzpaket('Bilderbuch - Soundcheck Upgrade'));
});

test('echte Tickets bleiben', () => {
  assert.ok(!istZusatzpaket('Provinz & Zartmann - Burg VIP Ticket'));
  assert.ok(!istZusatzpaket('Placebo - 30th Anniversary Tour VIP Package'));
  assert.ok(!istZusatzpaket('Wanda'));
  assert.ok(!istZusatzpaket('Rammstein - Stadium Tour 2027'));
});
