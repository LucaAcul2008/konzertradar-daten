/**
 * Tests für die Liste neu angekündigter Konzerte (*_ticketalarm.json).
 *
 * Sie hielt früher nur, was seit dem letzten Lauf dazukam. Lief der
 * Hintergrunddienst der App nicht genau dazwischen, war die Ankündigung
 * für die Benachrichtigungen verloren. Jetzt hält sie sieben Tage.
 *
 * Laufen ohne Netz und ohne Chrome:  node --test
 */
const test = require('node:test');
const assert = require('node:assert');

const { fortschreiben } = require('./scrape.js');

const jetzt = new Date('2026-10-06T12:00:00Z');
const tage = (n) => new Date(jetzt.getTime() - n * 24 * 3600 * 1000).toISOString();
const k = (id, datum = '2026-11-01T20:00:00+01:00') => ({ id, kuenstler: id, ort: 'Wien', datum });

test('Neues bekommt neuSeit = jetzt', () => {
  const r = fortschreiben([k('a')], [], [k('a')], jetzt);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].neuSeit, jetzt.toISOString());
});

test('Ältere Ankündigungen bleiben sieben Tage', () => {
  const letzte = [
    { ...k('b'), neuSeit: tage(2) },
    { ...k('c'), neuSeit: tage(8) },
  ];
  const r = fortschreiben([], letzte, [k('b'), k('c')], jetzt);
  assert.deepStrictEqual(r.map((x) => x.id), ['b']);
  assert.strictEqual(r[0].neuSeit, tage(2));
});

test('Was der Katalog nicht mehr führt, fällt heraus', () => {
  const r = fortschreiben([], [{ ...k('weg'), neuSeit: tage(1) }], [], jetzt);
  assert.strictEqual(r.length, 0);
});

test('Alte Listen ohne neuSeit zählen als vom letzten Lauf', () => {
  const r = fortschreiben([], [k('alt')], [k('alt')], jetzt);
  assert.strictEqual(r.length, 1);
  assert.ok(new Date(r[0].neuSeit) < jetzt);
});

test('Doppelt angekündigt: das neue gewinnt, nach Datum sortiert', () => {
  const r = fortschreiben(
    [k('x', '2026-12-01T20:00:00+01:00')],
    [{ ...k('x'), neuSeit: tage(3) }, { ...k('y', '2026-10-20T20:00:00+02:00'), neuSeit: tage(1) }],
    [k('x', '2026-12-01T20:00:00+01:00'), k('y', '2026-10-20T20:00:00+02:00')],
    jetzt,
  );
  assert.deepStrictEqual(r.map((x) => x.id), ['y', 'x']);
  assert.strictEqual(r[1].neuSeit, jetzt.toISOString());
});
