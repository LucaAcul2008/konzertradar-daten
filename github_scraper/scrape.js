/**
 * KonzertRadar-Scraper — Eventim Public-Search-API
 *
 * Holt Konzerte über dieselbe JSON-API, die eventim.de und oeticket.com selbst
 * benutzen, und schreibt fertige JSON-Dateien nach ../data/. Die App lädt diese
 * Dateien direkt (GitHub Pages / raw.githubusercontent) — es gibt keinen Server mehr.
 *
 * Warum ueberhaupt Chrome, obwohl es nur um JSON geht: Akamai blockt HTTP-Clients
 * (curl/node-fetch) per TLS-Fingerprint mit 403, einen echten Chrome aber nicht.
 * Chrome dient hier also nur als HTTP-Client — es wird kein DOM gescrapt.
 *
 * Das 10.000-Treffer-Limit der API (max. 100 Seiten à 100) wird umgangen, indem
 * monatsweise über date_from/date_to abgefragt wird.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const API = 'https://public-api.eventim.com/websearch/search/api/exploration/v1/products';
const OUT_DIR = path.join(__dirname, '..', 'data');
const GEO_CACHE_FILE = path.join(__dirname, 'geo_cache.json');

// Basis-URL der zuletzt veröffentlichten Daten. Daraus liest der Lauf die
// bereits bekannten Event-IDs, um neu angekündigte Konzerte zu erkennen
// ("Bald erhältlich"). Die API selbst liefert kein Verkaufsstart-Datum.
const PAGES_URL = process.env.PAGES_URL || '';

const PAGE_SIZE = 100;
// 24 Monate, nicht 12.
//
// Gemessen am 09.09.2026 gegen die API: In den Monaten 1-12 liegen 31.845
// (DE) und 6.141 (AT) Konzerte, in den Monaten 13-24 noch einmal 1.517 und
// 368 — rund fünf Prozent mehr. Jenseits von 24 Monaten ist praktisch
// nichts mehr da (11 beziehungsweise 0), deshalb endet es hier.
//
// Diese 1.885 sind nicht irgendwelche: Es sind die Touren, die weit im
// Voraus angekündigt werden. Genau bei denen zählt es, früh Bescheid zu
// wissen. Die Monate sind dünn besetzt, der Lauf wird dadurch nur um
// wenige Seitenabrufe länger.
const MONATE_VORAUS = parseInt(process.env.MONATE_VORAUS || '24', 10);
// Zeitraum der Standarddatei, die die App beim Start lädt.
const MONATE_STANDARD = parseInt(process.env.MONATE_STANDARD || '6', 10);
// Für lokale Tests: MAX_MONATE=1 node scrape.js
const MAX_MONATE = parseInt(process.env.MAX_MONATE || '0', 10) || MONATE_VORAUS;
const MAX_GEOCODE_PRO_LAUF = parseInt(process.env.MAX_GEOCODE || '150', 10);
// Obergrenze für **alles** Geocoding eines Laufs.
//
// `ergaenzeKoordinaten` läuft viermal (zwei Quellen, je Konzerte und
// Highlights) und hatte je 150 Abfragen frei. Bei 1,1 s Wartezeit sind das
// schon 11 Minuten, und seit unauffindbare Orte ein zweites Mal ohne
// Länderfilter gefragt werden, im schlimmsten Fall 22 — mehr als der
// Watchdog bei 18 Minuten durchgehen lässt. Ein gemeinsames Zeitbudget
// deckelt das unabhängig davon, wie oft die Funktion noch aufgerufen wird.
const GEOCODE_BUDGET_MIN = parseInt(process.env.GEOCODE_BUDGET_MIN || '6', 10);
const geocodeFrist = Date.now() + GEOCODE_BUDGET_MIN * 60 * 1000;

// Notbremse: Ein normaler Lauf dauert ~8 Minuten. Rund ein Viertel der Läufe
// blieb aber irgendwo hängen (vermutlich eine Chrome-Navigation, die trotz
// Timeout nicht zurückkehrt) und lief in das Job-Limit von 45 Minuten.
// Der Watchdog beendet den Prozess vorher — bewusst mit Fehlercode und ohne
// zu schreiben, damit die zuletzt veröffentlichten Daten unangetastet bleiben.
const MAX_LAUFZEIT_MIN = parseInt(process.env.MAX_LAUFZEIT_MIN || '18', 10);
const watchdog = setTimeout(() => {
  console.error(
    `[Scraper] ABBRUCH: Zeitlimit von ${MAX_LAUFZEIT_MIN} Minuten erreicht — ` +
    'die bestehenden Daten bleiben unverändert.'
  );
  process.exit(1);
}, MAX_LAUFZEIT_MIN * 60 * 1000);
watchdog.unref(); // darf den regulären Programmablauf nicht offenhalten

// Beginn des heutigen Tages — heute stattfindende Konzerte bleiben erhalten.
const TAGESBEGINN = new Date(new Date().setHours(0, 0, 0, 0));

const QUELLEN = [
  {
    key: 'eventim_de',
    webId: 'web__eventim-de',
    quelle: 'Eventim',
    countryCode: 'DE',
    referer: 'https://www.eventim.de/',
  },
  {
    key: 'oeticket_at',
    webId: 'web__oeticket-at',
    quelle: 'Oeticket',
    countryCode: 'AT',
    referer: 'https://www.oeticket.com/',
  },
];

// ─── Koordinaten-Fallback ─────────────────────────────────────────────────────
// Die API liefert geoLocation nur bei ~60 % der Events. Der Rest wird über diese
// Tabelle bzw. den persistenten Nominatim-Cache aufgelöst.
const BEKANNTE_STAEDTE = {
  wien: { lat: 48.2082, lon: 16.3738 },
  graz: { lat: 47.0707, lon: 15.4395 },
  linz: { lat: 48.3069, lon: 14.2858 },
  salzburg: { lat: 47.8095, lon: 13.0432 },
  innsbruck: { lat: 47.2692, lon: 11.4041 },
  klagenfurt: { lat: 46.6247, lon: 14.3053 },
  bregenz: { lat: 47.5031, lon: 9.7471 },
  wels: { lat: 48.1572, lon: 14.0286 },
  villach: { lat: 46.6111, lon: 13.8558 },
  'st. pölten': { lat: 48.2043, lon: 15.6229 },
  berlin: { lat: 52.52, lon: 13.405 },
  münchen: { lat: 48.1351, lon: 11.582 },
  hamburg: { lat: 53.5511, lon: 9.9937 },
  köln: { lat: 50.9333, lon: 6.95 },
  frankfurt: { lat: 50.1109, lon: 8.6821 },
  'frankfurt am main': { lat: 50.1109, lon: 8.6821 },
  stuttgart: { lat: 48.7758, lon: 9.1829 },
  düsseldorf: { lat: 51.2217, lon: 6.7762 },
  dortmund: { lat: 51.5136, lon: 7.4653 },
  essen: { lat: 51.4556, lon: 7.0116 },
  bremen: { lat: 53.0793, lon: 8.8017 },
  hannover: { lat: 52.3759, lon: 9.732 },
  nürnberg: { lat: 49.4521, lon: 11.0767 },
  leipzig: { lat: 51.3397, lon: 12.3731 },
  dresden: { lat: 51.0509, lon: 13.7383 },
  bochum: { lat: 51.4818, lon: 7.2162 },
  wuppertal: { lat: 51.2562, lon: 7.1508 },
  bielefeld: { lat: 52.0302, lon: 8.5325 },
  bonn: { lat: 50.7374, lon: 7.0982 },
  mannheim: { lat: 49.4875, lon: 8.466 },
  karlsruhe: { lat: 49.0069, lon: 8.4037 },
  augsburg: { lat: 48.3715, lon: 10.8985 },
  chemnitz: { lat: 50.8333, lon: 12.9167 },
  magdeburg: { lat: 52.1277, lon: 11.6292 },
  'freiburg im breisgau': { lat: 47.999, lon: 7.8421 },
  kiel: { lat: 54.3233, lon: 10.1228 },
  rostock: { lat: 54.0887, lon: 12.1405 },
  erfurt: { lat: 50.9787, lon: 11.0328 },
  mainz: { lat: 49.9929, lon: 8.2473 },
  kassel: { lat: 51.3127, lon: 9.4797 },
  'halle (saale)': { lat: 51.4828, lon: 11.9697 },
  münster: { lat: 51.9607, lon: 7.6261 },
  braunschweig: { lat: 52.2689, lon: 10.5268 },
  lübeck: { lat: 53.8655, lon: 10.6866 },
  aachen: { lat: 50.7753, lon: 6.0839 },
  würzburg: { lat: 49.7944, lon: 9.9294 },
  heidelberg: { lat: 49.4094, lon: 8.6941 },
  regensburg: { lat: 49.0134, lon: 12.1016 },
  ulm: { lat: 48.4011, lon: 9.9876 },
  ingolstadt: { lat: 48.7665, lon: 11.4257 },
};

// ─── Geo-Cache (wird mit ins Repo committet) ─────────────────────────────────
let geoCache = {};
function ladeGeoCache() {
  try {
    if (fs.existsSync(GEO_CACHE_FILE)) {
      geoCache = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8'));
      console.log(`[Geo] ${Object.keys(geoCache).length} Orte aus Cache geladen`);
    }
  } catch (e) {
    console.error('[Geo] Cache-Ladefehler:', e.message);
  }
}
function speichereGeoCache() {
  try {
    fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(geoCache, null, 0));
  } catch (e) {
    console.error('[Geo] Cache-Speicherfehler:', e.message);
  }
}

// Grobe Umrisse der Länder, in denen wir Konzerte führen.
//
// Zweites Netz hinter der Länderprüfung: `countrycodes` schränkt Nominatim
// zwar ein, aber bei einem Ortsnamen, den es im gefragten Land gar nicht
// gibt, liefert es irgendetwas Ähnliches statt gar nichts. Genau so wurde
// "Konstanz" mit AT-Filter zu einem Punkt vier Kilometer neben Klagenfurt.
const LAND_UMRISS = {
  de: { latVon: 47.2, latBis: 55.1, lonVon: 5.8, lonBis: 15.1 },
  at: { latVon: 46.3, latBis: 49.1, lonVon: 9.5, lonBis: 17.2 },
  ch: { latVon: 45.8, latBis: 47.9, lonVon: 5.9, lonBis: 10.6 },
};

function liegtImLand(lat, lon, land) {
  const u = LAND_UMRISS[(land || '').toLowerCase()];
  if (!u) return true; // unbekanntes Land: nicht ablehnen
  return lat >= u.latVon && lat <= u.latBis && lon >= u.lonVon && lon <= u.lonBis;
}

/// Ab welchem Rang ein Treffer keine Ortschaft mehr ist.
///
/// Nominatim staffelt: Land 4, Bundesland 8, Stadt 16, Dorf 19, Stadtteil
/// bis 22, Strasse 26, einzelnes Gebäude 30. Wir suchen Städtenamen, also
/// ist alles über 22 der falsche Treffer. Zweite Absicherung neben
/// `featureType=settlement` — falls der Parameter einmal ignoriert wird.
const MAX_ORTSRANG = 22;

/// Eine Abfrage. undefined = technischer Fehler, null = kein brauchbarer
/// Treffer, sonst die Koordinaten.
async function nominatimAbfrage(ort, laender, pruefeLand) {
  // featureType=settlement: nur Ortschaften von der Stadt bis zum Weiler.
  //
  // Ohne das lieferte "Konstanz" mit AT-Filter das "Mini-Fährschiff
  // Konstanz" — ein Modellboot im Minimundus-Park in Klagenfurt, Rang 30.
  // Der Punkt lag brav in Österreich und bestand jede Länderprüfung.
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(ort)}`
    + `&format=json&limit=1&addressdetails=1&featureType=settlement`
    + `&countrycodes=${laender}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'KonzertRadar/2.0 (konzertradary@gmail.com)' },
      // Ohne Timeout kann ein hängender Request den ganzen Job blockieren
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return undefined; // technischer Fehler (z.B. Rate-Limit)
    const j = await res.json();
    if (!Array.isArray(j) || j.length === 0) return null; // nicht auffindbar

    const lat = parseFloat(j[0].lat);
    const lon = parseFloat(j[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (j[0].place_rank > MAX_ORTSRANG) return null;

    const geliefert = ((j[0].address && j[0].address.country_code) || '').toLowerCase();
    if (pruefeLand) {
      // Sagt die Antwort selbst, sie liege woanders? Dann nicht nehmen.
      if (geliefert && geliefert !== pruefeLand) return null;
      if (!liegtImLand(lat, lon, pruefeLand)) return null;
    } else if (geliefert && !liegtImLand(lat, lon, geliefert)) {
      return null;
    }
    return { lat, lon };
  } catch (_) {
    return undefined;
  }
}

// Nominatim erlaubt 1 Anfrage/Sekunde — deshalb pro Lauf gedeckelt.
async function nominatim(ort, countryCode) {
  const land = (countryCode || '').toLowerCase();
  if (!land) return nominatimAbfrage(ort, 'at,de,ch', null);

  const imLand = await nominatimAbfrage(ort, land, land);
  if (imLand !== null) return imLand; // Treffer oder technischer Fehler

  // Kein Treffer im eigenen Land. Das ist normal: oeticket verkauft auch
  // Karten für München und Konstanz, Eventim welche für Wien. Also noch
  // einmal ohne Länderfilter fragen, bevor der Ort als unauffindbar gilt.
  // Genau hier wird aus dem österreichischen "Konstanz" der Bodensee.
  await new Promise((r) => setTimeout(r, 1100)); // Nominatim: 1 req/s
  return nominatimAbfrage(ort, 'at,de,ch', null);
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────
function cleanString(str) {
  if (!str) return '';
  return str.replace(/[<>{}[\]\\^`|~@#$%*+=;?]/g, '').replace(/\s+/g, ' ').trim();
}

function generateId(quelle, productId) {
  return `${quelle.toLowerCase()}_${productId}`;
}

// Eventim listet Ticket-Zusatzpakete als eigene Produkte ("Premium Tickets -
// koRn", "VIP Upgrade - ...", "GastroPlus Gold - ..."). In der App sind das
// Dubletten des eigentlichen Konzerts. Der SPECIAL-Tag der API taugt nicht zum
// Filtern — den tragen auch normale Konzerte. Das Namensmuster dagegen ist
// trennscharf: es trifft ~2 % der Einträge, alles echte Pakete.
const ZUSATZPAKET = new RegExp(
  '^\\s*(' +
    'premium[-\\w\\s]*|vip[-\\w\\s]*|gallery\\s*tickets?|gastroplus[-\\w\\s*]*|' +
    'hotel[-\\w\\s]*|meet\\s*&\\s*greet[-\\w\\s]*|suiten-?ticket[-\\w\\s]*|' +
    'komfort-?(ticket|upgrade)[-\\w\\s]*|logen?[-\\w\\s]*|business\\s*seat[-\\w\\s]*|' +
    '[-\\w\\s]*upgrade|[-\\w\\s]*ticket\\s*package|[-\\w\\s]*paket' +
  ')\\s*[-|]\\s+',
  'i'
);

function istZusatzpaket(name) {
  return ZUSATZPAKET.test(name || '');
}

// Inhaltlicher Schlüssel: dasselbe Konzert kann unter mehreren productIds
// auftauchen. Verschiedene Uhrzeiten bleiben getrennt — das sind echte
// Doppelvorstellungen.
function dublettenKey(k) {
  return `${k.kuenstler.toLowerCase().trim()}|${k.datum}|${k.ort.toLowerCase()}`;
}

// ─── Genre ────────────────────────────────────────────────────────────────────
// Eventim (DE) und Oeticket (AT) benennen dieselben Genres verschieden
// ("Festival"/"Festivals", "Hard & Heavy"/"Hard 'n' Heavy") — hier vereinheitlicht,
// sonst stünde in der App jedes Genre doppelt im Filter.
const GENRE_ALIAS = {
  'rock & pop': 'Rock & Pop',
  'hard & heavy': 'Hard & Heavy',
  "hard 'n' heavy": 'Hard & Heavy',
  'festival': 'Festivals',
  'festivals': 'Festivals',
  'schlager & volksmusik': 'Schlager & Volksmusik',
  'volksmusik & schlager': 'Schlager & Volksmusik',
  'hiphop & r’n‘b': 'HipHop & Rap',
  "hiphop & r'n'b": 'HipHop & Rap',
  'rap, hip hop': 'HipHop & Rap',
  'jazz & blues': 'Jazz & Blues',
  'electronic & dance': 'Electronic & Dance',
  'clubkonzerte': 'Clubkonzerte',
  'party & feste': 'Party & Feste',
  'country & folk': 'Country & Folk',
  'klassische konzerte': 'Klassik',
  'weitere konzerte': 'Sonstiges',
  'mehr konzerte': 'Sonstiges',
};

function ermittleGenre(categories) {
  const subs = (categories || [])
    .filter((c) => c.parentCategory && c.parentCategory.name === 'Konzerte')
    .map((c) => c.name);
  for (const s of subs) {
    const treffer = GENRE_ALIAS[s.toLowerCase().trim()];
    // "Sonstiges" nur nehmen, wenn nichts Konkreteres dabei ist
    if (treffer && treffer !== 'Sonstiges') return treffer;
  }
  return subs.length > 0 ? 'Sonstiges' : null;
}

function monatsFenster(anzahl) {
  const fenster = [];
  const heute = new Date();
  let jahr = heute.getUTCFullYear();
  let monat = heute.getUTCMonth();
  for (let i = 0; i < anzahl; i++) {
    const von = new Date(Date.UTC(jahr, monat, 1));
    const bis = new Date(Date.UTC(jahr, monat + 1, 0));
    fenster.push({
      von: von.toISOString().slice(0, 10),
      bis: bis.toISOString().slice(0, 10),
      label: `${von.getUTCFullYear()}-${String(von.getUTCMonth() + 1).padStart(2, '0')}`,
    });
    monat++;
    if (monat > 11) { monat = 0; jahr++; }
  }
  return fenster;
}

// ─── API-Zugriff über Chrome ──────────────────────────────────────────────────
let browser;
let page;

async function initBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36'
  );
}

// Navigation statt fetch(): umgeht CORS, das je nach webId sonst blockt.
async function apiGet(url, referer, versuche = 3) {
  for (let i = 1; i <= versuche; i++) {
    try {
      await page.setExtraHTTPHeaders({ referer });
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const text = await page.evaluate(() => document.body.innerText);
      if (res.status() !== 200) throw new Error(`HTTP ${res.status()}`);
      return JSON.parse(text);
    } catch (e) {
      if (i === versuche) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

function baueUrl(quelle, params) {
  const q = new URLSearchParams({
    webId: quelle.webId,
    language: 'de',
    retail_partner: 'EVE',
    categories: 'Konzerte',
    page_size: String(PAGE_SIZE),
    ...params,
  });
  return `${API}?${q.toString()}`;
}

// ─── Mapping: API-Produkt → Konzert-Eintrag (Schema der App) ─────────────────
function mapProdukt(p, quelle) {
  const le = p.typeAttributes?.liveEntertainment;
  if (!le) return null;
  // Abgesagte und ausverkaufte Veranstaltungen gehören nicht in die App.
  // Die API kennt genau drei Werte: Available, SoldOut, Cancelled.
  if (p.status === 'Cancelled' || p.status === 'SoldOut') return null;
  // Ticket-Zusatzpakete sind Dubletten des eigentlichen Konzerts
  if (istZusatzpaket(p.name)) return null;
  // Das Monatsfenster beginnt am Monatsersten — bereits gelaufene Termine
  // deshalb aussortieren. Mehrtägiges (Festivals) zählt bis zum Enddatum.
  const ende = le.endDate || le.startDate;
  if (ende && new Date(ende) < TAGESBEGINN) return null;
  const loc = le.location || {};
  const geo = loc.geoLocation;
  const ort = (loc.city || '').trim();
  // Felder, die die API nicht liefert (spotifyUrl, preis, verkaufsstartDatum),
  // werden weggelassen — Konzert.fromBackendJson behandelt sie als null.
  const k = {
    id: generateId(quelle.quelle, p.productId),
    kuenstler: cleanString(p.name) || 'Unbekannt',
    ort: ort || 'Ort unbekannt',
    datum: le.startDate || null,
    imageUrl: p.imageUrl || '',
    ticketUrl: p.link || (p.url ? `${p.url.domain}${p.url.path}` : ''),
    quelle: quelle.quelle,
  };
  if (geo) {
    k.latitude = geo.latitude;
    k.longitude = geo.longitude;
  }
  const venue = (loc.name || '').trim();
  if (venue) k.venue = venue;
  const genre = ermittleGenre(p.categories);
  if (genre) k.genre = genre;
  return k;
}

// ─── Eine Quelle vollständig abholen (monatsweise) ───────────────────────────
async function holeQuelle(quelle) {
  console.log(`\n=== ${quelle.quelle} (${quelle.countryCode}) ===`);
  const alle = new Map(); // productId → Konzert
  const gesehen = new Set(); // inhaltliche Schlüssel gegen Dubletten
  const fenster = monatsFenster(MAX_MONATE);
  let fehler = 0;

  for (const f of fenster) {
    let seite = 1;
    let seiten = 1;
    let imMonat = 0;
    do {
      const url = baueUrl(quelle, {
        sort: 'DateAsc',
        date_from: f.von,
        date_to: f.bis,
        page: String(seite),
      });
      try {
        const json = await apiGet(url, quelle.referer);
        seiten = Math.min(json.totalPages || 1, 100); // API-Limit: 100 Seiten
        if (seite === 1 && (json.totalResults || 0) > PAGE_SIZE * 100) {
          console.warn(`  ! ${f.label}: ${json.totalResults} Treffer > 10.000 — Rest wird abgeschnitten`);
        }
        for (const p of json.products || []) {
          const k = mapProdukt(p, quelle);
          if (!k || !k.datum || alle.has(k.id)) continue;
          const dk = dublettenKey(k);
          if (gesehen.has(dk)) continue;
          gesehen.add(dk);
          alle.set(k.id, k);
          imMonat++;
        }
      } catch (e) {
        console.error(`  Fehler ${f.label} Seite ${seite}: ${e.message}`);
        fehler++;
        break;
      }
      seite++;
    } while (seite <= seiten);
    console.log(`  ${f.label}: +${imMonat} (gesamt ${alle.size})`);
  }

  return { konzerte: Array.from(alle.values()), fehler };
}

// ─── Highlights: von der API empfohlene Events ───────────────────────────────
async function holeHighlights(quelle) {
  const konzerte = [];
  for (let seite = 1; seite <= 3; seite++) {
    try {
      const json = await apiGet(
        baueUrl(quelle, { sort: 'Recommendation', in_stock: 'true', page: String(seite) }),
        quelle.referer
      );
      for (const p of json.products || []) {
        const k = mapProdukt(p, quelle);
        if (k && k.datum) konzerte.push(k);
      }
    } catch (e) {
      console.error(`  Highlights-Fehler (${quelle.quelle}): ${e.message}`);
      break;
    }
  }
  return konzerte;
}

// ─── Koordinaten ergänzen ─────────────────────────────────────────────────────
/// Schlüssel im Koordinatenspeicher: Ortsname **und** Land.
///
/// Ohne das Land teilen sich Deutschland und Österreich einen Eintrag.
/// "Konstanz" steht in beiden Datensätzen — 21 Konzerte in DE, 5 in AT.
/// Der österreichische Lauf schlug es mit AT-Filter nach, bekam einen Punkt
/// neben Klagenfurt und legte ihn unter `konstanz` ab. Danach las der
/// deutsche Lauf denselben Eintrag: SCHILLER am Bodensee lag plötzlich im
/// 180-km-Umkreis von Salzburg. 214 Ortsnamen kommen in beiden Ländern vor,
/// 178 davon standen im Speicher — jeder einzelne konnte so kippen.
function geoSchluessel(ort, land) {
  return `${ort.toLowerCase()}|${(land || '').toLowerCase()}`;
}

/// Umriss über alle Länder, in denen wir Konzerte führen.
function imSendegebiet(lat, lon) {
  return lat >= 45.8 && lat <= 55.1 && lon >= 5.8 && lon <= 17.2;
}

/// Letzte Sicherung, egal woher die Koordinate stammt.
///
/// Zwei Fälle, in dieser Reihenfolge:
///
/// 1. **Vertauschte Achsen.** Die Eventim-API liefert bei einem kleinen Teil
///    der Events `geoLocation` mit Länge und Breite in der falschen Ordnung.
///    Gemessen am 10.09.2026: 208 von 36.986 Konzerten an 67 Orten — Bremen
///    32-mal, Münster 27-mal. Bremen lag damit bei 8,78 Nord und 53,10 Ost,
///    also im Indischen Ozean. Eine Verwechslung ist hier eindeutig
///    erkennbar: Kein Längengrad des Sendegebiets (5,8–17,2) kann ein
///    gültiger Breitengrad sein (45,8–55,1), die Bereiche überschneiden sich
///    nicht. Also drehen statt wegwerfen.
/// 2. **Alles andere ausserhalb.** Lieber gar keine Koordinate — dann fällt
///    das Konzert im Umkreisfilter auf den Ortsnamen zurück, statt tausend
///    Kilometer entfernt aufzutauchen.
///
/// Absichtlich **nicht** gegen das Land der Quelle geprüft: Eventim verkauft
/// 999 Wiener Konzerte, oeticket 341 Kölner. Beides ist richtig so.
function verwerfeUnplausible(konzerte) {
  let gedreht = 0;
  let verworfen = 0;
  for (const k of konzerte) {
    if (k.latitude == null) continue;
    if (imSendegebiet(k.latitude, k.longitude)) continue;

    if (imSendegebiet(k.longitude, k.latitude)) {
      const lat = k.longitude;
      k.longitude = k.latitude;
      k.latitude = lat;
      gedreht++;
      continue;
    }

    console.warn(`  ! ${k.ort}: ${k.latitude},${k.longitude} — verworfen`);
    k.latitude = null;
    k.longitude = null;
    verworfen++;
  }
  if (gedreht > 0) console.log(`  Achsen gedreht: ${gedreht}`);
  return verworfen;
}

async function ergaenzeKoordinaten(konzerte, countryCode) {
  const ohne = konzerte.filter((k) => k.latitude == null && k.ort !== 'Ort unbekannt');
  // Auch wenn nichts nachzuschlagen ist: die Koordinaten aus der API selbst
  // sind ungeprüft und müssen durch dieselbe Kontrolle.
  if (ohne.length === 0) {
    verwerfeUnplausible(konzerte);
    return konzerte.filter((k) => k.latitude != null).length;
  }

  let ausTabelle = 0;
  const offen = new Set();
  for (const k of ohne) {
    const key = geoSchluessel(k.ort, countryCode);
    // BEKANNTE_STAEDTE ist von Hand gepflegt und führt nur Großstädte, die
    // es je nur einmal gibt — dort genügt der bloße Ortsname.
    const treffer = BEKANNTE_STAEDTE[k.ort.toLowerCase()] || geoCache[key];
    if (treffer) {
      k.latitude = treffer.lat;
      k.longitude = treffer.lon;
      ausTabelle++;
    } else if (geoCache[key] !== null) {
      offen.add(k.ort);
    }
  }

  // Neue Orte nachschlagen (gedeckelt, damit der Lauf nicht ausufert)
  const neu = Array.from(offen).slice(0, MAX_GEOCODE_PRO_LAUF);
  let geladen = 0;
  let fehlerInFolge = 0;
  for (const ort of neu) {
    if (Date.now() > geocodeFrist) {
      console.warn(`  Geocoding vertagt (Zeitbudget von ${GEOCODE_BUDGET_MIN} min aufgebraucht)`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1100)); // Nominatim: 1 req/s
    const coords = await nominatim(ort, countryCode);
    if (coords === undefined) {
      // Technischer Fehler — nicht als "nicht auffindbar" cachen
      if (++fehlerInFolge >= 5) {
        console.warn('  Geocoding abgebrochen (Nominatim antwortet nicht)');
        break;
      }
      continue;
    }
    fehlerInFolge = 0;
    // null merken = nicht auffindbar
    geoCache[geoSchluessel(ort, countryCode)] = coords;
    if (coords) geladen++;
  }
  if (neu.length > 0) speichereGeoCache();

  // Frisch geladene Koordinaten eintragen
  for (const k of konzerte) {
    if (k.latitude != null) continue;
    const treffer = geoCache[geoSchluessel(k.ort, countryCode)];
    if (treffer) {
      k.latitude = treffer.lat;
      k.longitude = treffer.lon;
    }
  }

  const verworfen = verwerfeUnplausible(konzerte);

  const mitKoords = konzerte.filter((k) => k.latitude != null).length;
  console.log(
    `  Koordinaten: ${mitKoords}/${konzerte.length}`
    + ` (Tabelle/Cache: ${ausTabelle}, neu geocodiert: ${geladen}, offen: ${offen.size - neu.length}`
    + `${verworfen ? `, verworfen: ${verworfen}` : ''})`
  );
  return mitKoords;
}

// ─── Neu angekündigte Events ("Bald erhältlich") ─────────────────────────────
// Die Eventim-API kennt kein Verkaufsstart-Datum. Ersatzweise vergleichen wir
// mit dem letzten Lauf: Was neu dazugekommen ist, wurde frisch angekündigt.
async function ladeBekannteIds() {
  if (!PAGES_URL) return null;
  try {
    const res = await fetch(`${PAGES_URL}/bekannte_ids.json`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const gesamt = Object.values(j).reduce((n, arr) => n + arr.length, 0);
    console.log(`[Neu] ${gesamt} bekannte Event-IDs vom letzten Lauf geladen`);
    return j;
  } catch (e) {
    console.log(`[Neu] Keine Vorgängerdaten (${e.message}) — Ticketalarm bleibt diesmal leer`);
    return null;
  }
}

// Weiter als ein Jahr voraus gilt nichts mehr als "neu angekündigt".
//
// Zwei Gründe. Erstens ist der Tab "Bald verfügbar" eine Sache der nächsten
// Monate — ein Konzert in zwei Jahren gehört dort nicht hin. Zweitens, und
// das war der Anlass: Als das Fenster von 12 auf 24 Monate erweitert wurde,
// tauchten rund 1.900 Konzerte zum ersten Mal auf. Alle galten als neu
// angekündigt, obwohl sie längst angekündigt waren — sie lagen nur bisher
// außerhalb. Die App verschickt daraus Benachrichtigungen; das wäre ein
// Schwall aus lauter alten Meldungen gewesen.
const NEU_HORIZONT_MONATE = 12;

function ermittleNeue(konzerte, bekannteIds) {
  // Beim allerersten Lauf gibt es keine Referenz — dann wäre alles "neu",
  // was den Tab mit tausenden Einträgen fluten würde.
  if (!bekannteIds) return [];
  const bekannt = new Set(bekannteIds);
  const grenze = new Date();
  grenze.setMonth(grenze.getMonth() + NEU_HORIZONT_MONATE);

  return konzerte
    .filter((k) => !bekannt.has(k.id))
    .filter((k) => k.datum && new Date(k.datum) <= grenze)
    .sort((a, b) => new Date(a.datum) - new Date(b.datum))
    .slice(0, 500);
}

// ─── Schreiben ────────────────────────────────────────────────────────────────
function schreibe(dateiname, daten) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ziel = path.join(OUT_DIR, dateiname);
  fs.writeFileSync(ziel, JSON.stringify(daten));
  const kb = Math.round(fs.statSync(ziel).size / 1024);
  console.log(`  → data/${dateiname}: ${Array.isArray(daten) ? daten.length : '-'} Einträge, ${kb} KB`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const start = Date.now();
  console.log(`[Scraper] Start — ${MAX_MONATE} Monate voraus, page_size ${PAGE_SIZE}`);
  ladeGeoCache();
  const bekannteIds = await ladeBekannteIds();
  await initBrowser();

  const index = { aktualisiert: new Date().toISOString(), quellen: {} };
  const alleIds = {};
  let gesamtFehler = 0;
  let gesamtKonzerte = 0;

  for (const quelle of QUELLEN) {
    const { konzerte, fehler } = await holeQuelle(quelle);
    gesamtFehler += fehler;

    if (konzerte.length === 0) {
      console.error(`[FEHLER] ${quelle.quelle}: 0 Konzerte — Datei wird NICHT überschrieben`);
      gesamtFehler += 10;
      continue;
    }

    await ergaenzeKoordinaten(konzerte, quelle.countryCode);
    konzerte.sort((a, b) => new Date(a.datum) - new Date(b.datum));

    // Zwei Dateien, damit die App beim Start nicht alles laden muss:
    //   <key>.json       — die nächsten MONATE_STANDARD Monate (Umgebungs-Tab)
    //   <key>_full.json  — der komplette Zeitraum (Tour-Karte, Künstlersuche)
    const grenze = new Date();
    grenze.setMonth(grenze.getMonth() + MONATE_STANDARD);
    const nahe = konzerte.filter((k) => new Date(k.datum) <= grenze);
    schreibe(`${quelle.key}.json`, nahe);
    schreibe(`${quelle.key}_full.json`, konzerte);

    const highlights = await holeHighlights(quelle);
    if (highlights.length > 0) {
      await ergaenzeKoordinaten(highlights, quelle.countryCode);
      schreibe(`${quelle.key}_highlights.json`, highlights);
    }

    // Seit dem letzten Lauf neu dazugekommene Konzerte → "Bald erhältlich"
    const neue = ermittleNeue(konzerte, bekannteIds?.[quelle.key]);
    schreibe(`${quelle.key}_ticketalarm.json`, neue);
    alleIds[quelle.key] = konzerte.map((k) => k.id);

    index.quellen[quelle.key] = {
      quelle: quelle.quelle,
      countryCode: quelle.countryCode,
      konzerte: nahe.length,
      konzerteFull: konzerte.length,
      highlights: highlights.length,
      neuAngekuendigt: neue.length,
      mitKoordinaten: konzerte.filter((k) => k.latitude != null).length,
    };
    gesamtKonzerte += konzerte.length;
  }

  // Referenz für den nächsten Lauf
  schreibe('bekannte_ids.json', alleIds);
  schreibe('index.json', index);
  await browser.close();

  const dauer = Math.round((Date.now() - start) / 1000);
  console.log(`\n[Scraper] Fertig in ${dauer}s — ${gesamtKonzerte} Konzerte, ${gesamtFehler} Fehler`);

  // Fail-Loud: lieber ein rotes Kreuz als stille Leerdaten
  if (gesamtKonzerte === 0) {
    console.error('[Scraper] ABBRUCH: keine Daten erhalten');
    process.exit(1);
  }
  process.exit(gesamtFehler > 20 ? 1 : 0);
}

// Nur beim direkten Aufruf loslaufen. Wird die Datei von einem Test
// geladen, sollen bloß die Funktionen herausfallen — sonst startet jeder
// `node --test` einen echten Scraper-Lauf.
if (require.main === module) {
  main().catch(async (e) => {
    console.error('[Scraper] Fatal:', e.message);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  });
} else {
  module.exports = {
    BEKANNTE_STAEDTE,
    LAND_UMRISS,
    geoSchluessel,
    imSendegebiet,
    liegtImLand,
    verwerfeUnplausible,
  };
}
