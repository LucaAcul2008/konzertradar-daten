/**
 * Tests für die Koordinaten-Logik.
 *
 * Anlass: Am 10.09.2026 lag "SCHILLER — Sommerklang 2026" in Konstanz am
 * Bodensee laut Daten bei 46,62/14,26 — vier Kilometer neben Klagenfurt und
 * damit im 180-km-Umkreis von Salzburg. Ursache war ein Koordinatenspeicher,
 * dessen Schlüssel nur der Ortsname war: Deutschland und Österreich teilten
 * sich einen Eintrag.
 *
 * Laufen ohne Netz und ohne Chrome:  node --test
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  BEKANNTE_STAEDTE,
  LAND_UMRISS,
  geoSchluessel,
  imSendegebiet,
  liegtImLand,
  verwerfeUnplausible,
} = require('./scrape.js');

// Echte Koordinaten zum Gegenrechnen
const KONSTANZ_DE = { lat: 47.6603, lon: 9.1758 };
const KLAGENFURT_AT = { lat: 46.6247, lon: 14.3053 };
const HOF_DE = { lat: 50.3134, lon: 11.9124 };

test('Schlüssel trennt gleichnamige Orte nach Land', () => {
  assert.notStrictEqual(geoSchluessel('Konstanz', 'DE'), geoSchluessel('Konstanz', 'AT'));
  assert.strictEqual(geoSchluessel('Konstanz', 'DE'), 'konstanz|de');
});

test('Schlüssel ist unabhängig von Groß- und Kleinschreibung', () => {
  assert.strictEqual(geoSchluessel('ST. PÖLTEN', 'at'), geoSchluessel('st. pölten', 'AT'));
});

test('Klagenfurt gilt nicht als deutscher Ort', () => {
  // Genau der Wert, der als "Konstanz" im Speicher stand.
  assert.strictEqual(liegtImLand(46.6201728, 14.2637461, 'de'), false);
  assert.strictEqual(liegtImLand(46.6201728, 14.2637461, 'at'), true);
});

test('echte Orte liegen in ihrem Land', () => {
  assert.ok(liegtImLand(KONSTANZ_DE.lat, KONSTANZ_DE.lon, 'de'));
  assert.ok(liegtImLand(KLAGENFURT_AT.lat, KLAGENFURT_AT.lon, 'at'));
  assert.ok(liegtImLand(HOF_DE.lat, HOF_DE.lon, 'de'));
});

test('unbekanntes Land lehnt nichts ab', () => {
  assert.ok(liegtImLand(0, 0, 'xx'));
  assert.ok(liegtImLand(0, 0, ''));
});

test('jedes Land im Umriss hat einen sinnvollen Rahmen', () => {
  for (const [land, u] of Object.entries(LAND_UMRISS)) {
    assert.ok(u.latVon < u.latBis, `${land}: Breitengrade verdreht`);
    assert.ok(u.lonVon < u.lonBis, `${land}: Längengrade verdreht`);
  }
});

test('die Tabelle bekannter Städte liegt in ihrem eigenen Umriss', () => {
  // Ein Tippfehler in dieser handgepflegten Tabelle schlägt sofort auf
  // Tausende Konzerte durch, ohne dass irgendetwas nachgeschlagen wird.
  for (const [ort, c] of Object.entries(BEKANNTE_STAEDTE)) {
    const irgendwo = ['de', 'at', 'ch'].some((l) => liegtImLand(c.lat, c.lon, l));
    assert.ok(irgendwo, `${ort} liegt bei ${c.lat},${c.lon} — nicht in DE/AT/CH`);
  }
});

test('Koordinaten außerhalb Mitteleuropas werden verworfen', () => {
  const konzerte = [
    { ort: 'Wien', latitude: 48.2082, longitude: 16.3738 },
    { ort: 'Irgendwo', latitude: 40.7128, longitude: -74.006 }, // New York
    { ort: 'Ort unbekannt', latitude: null, longitude: null },
  ];
  assert.strictEqual(verwerfeUnplausible(konzerte), 1);
  assert.strictEqual(konzerte[0].latitude, 48.2082); // bleibt
  assert.strictEqual(konzerte[1].latitude, null); // weg
  assert.strictEqual(konzerte[1].longitude, null);
});

test('vertauschte Achsen werden gedreht, nicht weggeworfen', () => {
  // Genau der Fall aus den Daten vom 10.09.2026: Bremen kam von der API mit
  // 8,78 Nord / 53,10 Ost — das liegt im Indischen Ozean.
  const konzerte = [
    { ort: 'Bremen', latitude: 8.781388888364196, longitude: 53.10944441805594 },
  ];
  assert.strictEqual(verwerfeUnplausible(konzerte), 0, 'darf nichts verwerfen');
  assert.strictEqual(konzerte[0].latitude, 53.10944441805594);
  assert.strictEqual(konzerte[0].longitude, 8.781388888364196);
});

test('richtige Koordinaten werden nie gedreht', () => {
  // Die Bereiche duerfen sich nicht ueberschneiden, sonst waere ein Dreher
  // nicht eindeutig erkennbar: kein Laengengrad des Gebiets (5,8-17,2) darf
  // ein gueltiger Breitengrad sein (45,8-55,1).
  const konzerte = [];
  for (const [ort, c] of Object.entries(BEKANNTE_STAEDTE)) {
    konzerte.push({ ort, latitude: c.lat, longitude: c.lon });
  }
  assert.strictEqual(verwerfeUnplausible(konzerte), 0);
  for (const k of konzerte) {
    assert.strictEqual(k.latitude, BEKANNTE_STAEDTE[k.ort].lat, `${k.ort} gedreht`);
  }
});

test('unrettbare Koordinaten verlieren ihre Position', () => {
  const konzerte = [{ ort: 'Irgendwo', latitude: 40.7128, longitude: -74.006 }];
  assert.strictEqual(verwerfeUnplausible(konzerte), 1);
  assert.strictEqual(konzerte[0].latitude, null);
});

test('das Sendegebiet ist ein Rechteck ohne Achsenueberschneidung', () => {
  assert.ok(imSendegebiet(47.8095, 13.0432)); // Salzburg
  assert.ok(imSendegebiet(47.6603, 9.1758)); // Konstanz
  assert.ok(!imSendegebiet(13.0432, 47.8095)); // Salzburg gedreht
});

test('grenznah verkaufte Karten bleiben erhalten', () => {
  // oeticket verkauft Karten für München, Eventim welche für Wien. Die
  // Prüfung darf deshalb nicht am Land der Quelle hängen.
  const konzerte = [
    { ort: 'München', latitude: 48.1351, longitude: 11.582 },
    { ort: 'Konstanz', latitude: KONSTANZ_DE.lat, longitude: KONSTANZ_DE.lon },
  ];
  assert.strictEqual(verwerfeUnplausible(konzerte), 0);
});

test('der Speicher enthält keine Orte ohne Land mehr', () => {
  const cache = require('./geo_cache.json');
  const ohneLand = Object.keys(cache).filter((k) => !k.includes('|'));
  assert.deepStrictEqual(ohneLand, [], 'alte Schlüssel ohne Land gefunden');
});

test('jeder gespeicherte Ort liegt in seinem Land', () => {
  const cache = require('./geo_cache.json');
  const falsch = [];
  for (const [key, c] of Object.entries(cache)) {
    if (!c) continue; // null = nicht auffindbar
    const land = key.slice(key.lastIndexOf('|') + 1);
    // Grenznahes ist erlaubt, grob Falsches nicht: geprüft wird gegen alle
    // drei Länder, so wie es der Scraper auch tut.
    const irgendwo = ['de', 'at', 'ch'].some((l) => liegtImLand(c.lat, c.lon, l));
    if (!irgendwo) falsch.push(`${key} → ${c.lat},${c.lon} (${land})`);
  }
  assert.deepStrictEqual(falsch, []);
});
