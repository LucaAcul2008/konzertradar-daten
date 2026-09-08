/**
 * KonzertRadar — Künstlerindex
 *
 * Baut aus den gescrapten Konzerten eine Liste echter Künstlernamen und legt
 * sie als ../data/kuenstler.json ab. Die App sucht darin, statt im rohen
 * Konzertkatalog.
 *
 * Warum überhaupt: Das Feld `kuenstler` aus der Eventim-API ist der
 * Veranstaltungstitel, nicht der Künstler. Von 15.773 verschiedenen Werten
 * sind rund ein Drittel länger als 40 Zeichen ("Alexander Wurz & Die
 * Egerländer - 70 Jahre Egerländer - Die Jubiläumstour"), und die häufigsten
 * sind überhaupt keine Künstler ("Klavierkonzert" 220-mal, "House of Banksy
 * Stuttgart Zeitfensterticket" 144-mal). Eine Suche darin schlägt deshalb
 * "Weihnachten mit Wanda" vor, aber nicht Wanda.
 *
 * Warum MusicBrainz und nicht Deezer oder Spotify: Beide sind für diese App
 * rechtlich versperrt. Deezers Bedingungen (Abschnitt IV) erlauben die API
 * ausdrücklich nur "for a non-commercial purpose" und schließen jede direkte
 * oder indirekte Einnahme aus — die geplante oeticket-Partnerschaft ist genau
 * das. Spotify untersagt in IV.3.1.1, "compilations or databases of Spotify
 * Content" anzulegen, und nichts anderes wäre diese Datei. MusicBrainz steht
 * unter CC0 und darf ausdrücklich weiterverbreitet und kommerziell genutzt
 * werden.
 *
 * Warum hier und nicht in der App: MusicBrainz erlaubt eine Anfrage pro
 * Sekunde. Fünfzehntausend Namen bei jedem Nutzer nachzuschlagen ist
 * ausgeschlossen — einmal zentral nachgeschlagen und als fertige Datei
 * ausgeliefert dagegen kostet die App keinen einzigen Aufruf. Sie sucht
 * offline und ohne Wartezeit.
 *
 * Aufruf: node kuenstler_index.js   (nach scrape.js, die Daten müssen liegen)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(__dirname, 'kuenstler_cache.json');
const OUT_FILE = path.join(DATA_DIR, 'kuenstler.json');

// MusicBrainz verlangt eine aussagekräftige Kennung mit Kontaktadresse —
// anonyme Anfragen werden gedrosselt oder gesperrt.
const USER_AGENT = 'KonzertRadar/2.0 ( konzertradar@gmail.com )';

// Pro Lauf gedeckelt, damit die Action nicht ausufert: bei 1,1 s pro Anfrage
// sind 700 Namen rund 13 Minuten. Der Cache wächst über die Läufe hinweg, der
// Rückstand ist nach wenigen Tagen abgearbeitet und danach fallen nur noch
// die paar neu angekündigten Künstler an.
const MAX_MB_PRO_LAUF = parseInt(process.env.MAX_MUSICBRAINZ || '700', 10);

// Zusaetzlicher Deckel in Minuten, und der wichtigere von beiden.
//
// Wie lange ein Name dauert, schwankt stark: gemessen zwischen 2,2 s und
// 6,6 s, je nachdem wieviel Last MusicBrainz gerade global abwirft. Eine feste
// Namenszahl trifft die Laufzeit deshalb nicht. Laeuft der Schritt stattdessen
// in das Zeitlimit der Action, wird er hart abgeschossen und schreibt die
// fertige kuenstler.json nicht mehr — mit eigenem Budget steigt er vorher
// geordnet aus.
const MAX_MINUTEN = parseFloat(process.env.MAX_MINUTEN || '14');

// Ein Künstler kommt erst in die Datei, wenn MusicBrainz ihn kennt. Namen
// unterhalb dieser Konzertzahl werden gar nicht erst nachgeschlagen, solange
// noch bekanntere offen sind — die Reihenfolge macht den Rückstand nützlich,
// bevor er vollständig ist.
const MIN_KONZERTE = parseInt(process.env.MIN_KONZERTE || '1', 10);

// ─── Namensbereinigung ────────────────────────────────────────────────────────

// Veranstaltungsformate, die nie ein Künstler sind. Ohne diese Liste kämen
// "Klavierkonzert" und "Weihnachtskonzert" durch — MusicBrainz kennt beides
// als Werktitel und lieferte einen Treffer.
const KEIN_KUENSTLER = new RegExp(
  '(' +
    'bei kerzenschein|candlelight|musical|weihnachtskonzert|' +
    'neujahrskonzert|silvesterkonzert|advents?konzert|' +
    'zeitfensterticket|zeitfenster|führung|lesung|' +
    'hommage|klavierkonzert|orgelkonzert|kirchenkonzert|benefizkonzert|' +
    'sing.?along|mit.?sing|schlossbesichtigung' +
  ')',
  'i'
);

// Tribute-, Cover- und Mottoshows. Dasselbe Muster benutzt die App in
// kuenstler_matching.dart (_tributeMuster) — hier um die Formen erweitert,
// die in den Rohtiteln tatsächlich auftauchen.
//
// Entscheidend: Geprüft wird der VOLLE Titel, nicht der abgeschnittene Name.
// "Mamma Mia" für sich ist unauffällig und stand mit 182 Konzerten an der
// Spitze der Liste — erst der ganze Titel "Mamma Mia - The Ultimative Abba
// Night" verrät die Coverband. Genauso bei "One Night of Dire Straits -
// Tribute Show" und "Field Commander C. - The Songs of Leonard Cohen".
const TRIBUTE = new RegExp(
  '\\b(' +
    'tribute|tributo|coverband|cover band|revival|meets|' +
    'projekt|project|experience|forever band|' +
    'the music of|die musik von|musik von|the songs of|' +
    'performed by|performing|a celebration of|celebrating|' +
    'the best of|best of|the ultimative|die ultimative|' +
    'the .{2,20} story|zu gast' +
  ')\\b',
  'i'
);

// Dieselbe Regel wie in scrape.js (istZusatzpaket) — Ticketpakete sind
// Dubletten des eigentlichen Konzerts und tragen dessen Künstler im Titel.
const ZUSATZPAKET = new RegExp(
  '^\\s*(' +
    'premium[-\\w\\s]*|vip[-\\w\\s]*|gallery\\s*tickets?|gastroplus[-\\w\\s*]*|' +
    'hotel[-\\w\\s]*|meet\\s*&\\s*greet[-\\w\\s]*|suiten-?ticket[-\\w\\s]*|' +
    'komfort-?(ticket|upgrade)[-\\w\\s]*|logen?[-\\w\\s]*|business\\s*seat[-\\w\\s]*|' +
    '[-\\w\\s]*upgrade|[-\\w\\s]*ticket\\s*package|[-\\w\\s]*paket' +
  ')\\s*[-|]\\s+',
  'i'
);

/**
 * Schneidet aus dem Veranstaltungstitel den mutmaßlichen Künstlernamen.
 *
 * Über die Hälfte der Titel folgt dem Muster "Künstler - Tourtitel", der Teil
 * vor dem ersten " - " ist dann der Name. Gibt null zurück, wenn der Eintrag
 * erkennbar kein Künstler ist — dann spart der Lauf sich die Anfrage.
 */
function kandidat(roh) {
  let n = (roh || '').trim();
  if (!n) return null;

  // Beides am vollen Titel prüfen: Der abgeschnittene Name allein ist zu
  // wenig, der verräterische Teil steht fast immer hinter dem Bindestrich.
  if (ZUSATZPAKET.test(n)) return null;
  if (TRIBUTE.test(n)) return null;
  if (KEIN_KUENSTLER.test(n)) return null;

  // Hängen immer hinten dran und gehören nie zum Namen
  n = n.replace(/\s+support:.*$/i, '');
  n = n.replace(/\s+(feat\.?|featuring)\s+.*$/i, '');

  const name0 = n.split(/\s+[-–—]\s+/)[0].trim();

  let name = name0
    .replace(/\s*\([^)]*\)\s*$/g, '')            // "(Verlegt)", "(Zusatzshow)"
    .replace(/\s+(tour|live|open.?air)\s*20\d\d$/i, '')
    .replace(/\s+20\d\d$/, '')
    // "Ina Müller und Band" ist Ina Müller. MusicBrainz kennt die Begleitband
    // nicht als eigenen Eintrag, der Name fiel deshalb komplett durch.
    .replace(/\s+(und|and|&|mit)\s+(band|freunde|friends|gästen|gaesten)$/i, '')
    .trim();

  if (!name || name.length < 2) return null;
  if (/^(konzert|open.?air|festival|gala|show|party)$/i.test(name)) return null;
  return name;
}

/**
 * Ausweichnamen, falls der volle Name nirgends bekannt ist.
 *
 * Doppel-Headliner und Begleitbands stehen mit "&" oder "und" im Titel:
 * "Pizzera & Jaus & folkshilfe" (18 Konzerte), "Clueso & SWR Big Band",
 * "Gitte Haenning & Band: Ich bin Stark" (15 Konzerte). Als Ganzes kennt die
 * niemand, der erste Teil dagegen schon.
 *
 * Deshalb von hinten kürzen statt am ersten "&" zu trennen: "Simon &
 * Garfunkel" und "dicht & ergreifend" heissen wirklich so und werden zuerst
 * am Stück versucht — erst wenn das nichts findet, wird gekürzt.
 */
function alternativen(name) {
  const teile = name.split(/\s+(?:&|und)\s+/i);
  if (teile.length < 2) return [];
  const raus = [];
  for (let i = teile.length - 1; i >= 1; i--) {
    const kurz = teile.slice(0, i).join(' & ').trim();
    if (kurz.length >= 2 && kurz !== name) raus.push(kurz);
  }
  return raus.slice(0, 3);
}

/**
 * Vergleichsform eines Namens.
 *
 * Achtung, sieht nach einem Fehler aus, ist aber Absicht: Hier wird "ä" zu
 * "a", während normalizeArtistName in der App "ä" zu "ae" macht. Die beiden
 * vergleichen gegen Verschiedenes — diese Fassung gegen MusicBrainz-
 * Schreibweisen, die der App gegen Konzerttitel. Angleichen würde die
 * Trefferquote hier senken.
 */
function normalisiere(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ─── MusicBrainz ──────────────────────────────────────────────────────────────

/**
 * Schlägt einen Namen bei MusicBrainz nach.
 *
 * Rückgabe wie beim Geo-Cache in scrape.js: undefined = technischer Fehler
 * (nicht cachen, sonst brennt ein Ausfall den Namen dauerhaft als "unbekannt"
 * ein), null = kein Künstler dieses Namens, sonst der Datensatz.
 */
async function musicbrainz(name) {
  const q = encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`);
  const url = `https://musicbrainz.org/ws/2/artist?query=${q}&fmt=json&limit=5`;

  // MusicBrainz wirft Last global ab: Messung am 7.9.2026 ergab 8 von 10
  // Antworten als 503, mit X-RateLimit-Zone "global" und Remaining 14 — es
  // liegt also nicht an unserer Rate, der Dienst schuetzt sich insgesamt.
  // Die 503 kommen in Millisekunden zurueck, Wiederholen kostet daher fast
  // nichts und hebt die Quote je Name deutlich.
  let j = null;
  for (let versuch = 0; versuch < 4; versuch++) {
    if (versuch > 0) await new Promise((r) => setTimeout(r, 400 * versuch));
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 503 || res.status === 429) continue; // Lastabwurf
      if (!res.ok) return undefined;
      j = await res.json();
      break;
    } catch (_) {
      // Zeitueberschreitung oder Netzfehler — naechster Versuch
    }
  }
  if (j === null) return undefined;

  try {
    const treffer = j.artists || [];
    if (treffer.length === 0) return null;

    const gesucht = normalisiere(name);

    // Nur Namensgleichheit zählt, nicht der Score. Der trügt: bei "Wanda"
    // steht "Wanda Jackson" mit Score 100 vor der österreichischen Band mit 95.
    const passend = treffer.filter(
      (a) =>
        normalisiere(a.name) === gesucht ||
        (a.aliases || []).some((al) => normalisiere(al.name) === gesucht)
    );
    if (passend.length === 0) return null;

    // Bei gleichem Namen entscheidet das Land: Diese App zeigt Konzerte in
    // Österreich und Deutschland — der heimische Träger ist fast immer gemeint.
    const heim = (x) =>
      x.country === 'AT' ? 0 : x.country === 'DE' ? 1 : x.country === 'CH' ? 2 : 3;
    passend.sort((a, b) => heim(a) - heim(b) || (b.score || 0) - (a.score || 0));

    const a = passend[0];
    return {
      mbid: a.id,
      name: a.name,
      land: a.country || null,
      quelle: 'musicbrainz',
    };
  } catch (_) {
    return undefined;
  }
}

// ─── Wikidata: der schnelle Durchgang ─────────────────────────────────────────

// MusicBrainz beantwortet eine Anfrage pro Sekunde und damit einen Namen nach
// dem anderen — die 10.400 Kandidaten wären 6 bis 19 Stunden. Wikidata nimmt
// per SPARQL hundert Namen auf einmal und ist in gut zwei Minuten durch den
// ganzen Katalog. Ebenfalls CC0, also unter denselben Bedingungen nutzbar.
//
// Wikidata kennt weniger Künstler als MusicBrainz, vor allem im langen Ende.
// Deshalb nur der erste Durchgang: Was hier durchfällt, geht danach den
// langsamen Weg über MusicBrainz.
const WIKIDATA = 'https://query.wikidata.org/sparql';
const WD_PRO_STAPEL = parseInt(process.env.WD_STAPEL || '100', 10);

/**
 * Fragt einen Stapel Namen bei Wikidata ab.
 *
 * Gibt eine Map Name -> kanonische Schreibweise zurück; undefined bei einem
 * technischen Fehler, damit der Aufrufer den Stapel nicht als "nichts
 * gefunden" verbucht.
 */
async function wikidataStapel(namen) {
  // Die Label-Literale in Wikidata sind sprachmarkiert — ein Vergleich ohne
  // Sprachtag findet grundsätzlich nichts. "mul" ist der neuere Code für
  // sprachübergreifende Namen, den viele Bands inzwischen tragen.
  const werte = namen
    .flatMap((n) => ['de', 'en', 'mul'].map((t) => `"${n.replace(/["\\]/g, '')}"@${t}`))
    .join(' ');

  // Zwei Fälle, die beide zählen: Bands (eine Art musikalische Gruppe) und
  // Menschen mit einem Musikberuf. Ohne den zweiten fehlten alle Solisten —
  // Hubert von Goisern und Matthias Reim fielen im Test glatt durch.
  const query = `SELECT ?name ?item ?itemLabel WHERE {
  VALUES ?name { ${werte} }
  ?item rdfs:label|skos:altLabel ?name .
  { ?item wdt:P31/wdt:P279* wd:Q215380 }
  UNION
  { ?item wdt:P31 wd:Q5 ; wdt:P106 ?beruf .
    VALUES ?beruf { wd:Q639669 wd:Q177220 wd:Q36834 wd:Q488205 wd:Q753110 wd:Q855091 wd:Q486748 } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". }
}`;

  try {
    const res = await fetch(WIKIDATA, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ query }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) return undefined;
    const j = await res.json();
    const treffer = new Map();
    for (const r of j.results.bindings) {
      const gesucht = r.name.value;
      if (!treffer.has(gesucht)) treffer.set(gesucht, r.itemLabel.value);
    }
    return treffer;
  } catch (_) {
    return undefined;
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let cache = {};
function ladeCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log(`[Künstler] ${Object.keys(cache).length} Namen aus Cache geladen`);
    }
  } catch (e) {
    console.error('[Künstler] Cache-Ladefehler:', e.message);
  }
}
/**
 * Der Treffer zu einem Eintrag — erst der volle Name, dann die Ausweichnamen.
 *
 * Gibt den Datensatz zurück, oder undefined wenn noch keiner der Namen einen
 * Treffer hatte.
 */
function trefferZu(schluessel, e) {
  if (cache[schluessel]) return cache[schluessel];
  for (const a of e.alt || []) {
    const t = cache[normalisiere(a)];
    if (t) return t;
  }
  return undefined;
}

function speichereCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));
  } catch (e) {
    console.error('[Künstler] Cache-Speicherfehler:', e.message);
  }
}

// ─── Lauf ─────────────────────────────────────────────────────────────────────

async function main() {
  // Das Zeitbudget gilt für den ganzen Lauf, beide Durchgänge zusammen —
  // sonst käme die Wikidata-Zeit oben drauf und der Schritt liefe doch ins
  // Zeitlimit der Action.
  const schluss = Date.now() + MAX_MINUTEN * 60 * 1000;

  ladeCache();

  // Rohtitel einsammeln, dabei je Künstler ein Bild und die Konzertzahl merken
  const roh = new Map(); // kandidat -> { anzahl, bild }
  let konzerteGesamt = 0;

  for (const datei of ['eventim_de_full.json', 'oeticket_at_full.json']) {
    const p = path.join(DATA_DIR, datei);
    if (!fs.existsSync(p)) {
      console.warn(`[Künstler] ${datei} fehlt — übersprungen`);
      continue;
    }
    for (const k of JSON.parse(fs.readFileSync(p, 'utf8'))) {
      konzerteGesamt++;
      const kand = kandidat(k.kuenstler);
      if (!kand) continue;
      const schluessel = normalisiere(kand);
      if (!schluessel) continue;
      const e = roh.get(schluessel) ||
        { anzahl: 0, bild: null, roh: kand, alt: alternativen(kand) };
      e.anzahl++;
      // Das Bild aus dem Konzertdatensatz — Eventim und oeticket liefern es
      // ohnehin mit. Ein fremder Bilderdienst erübrigt sich damit, und die
      // Rechtefrage stellt sich nicht neu.
      if (!e.bild && k.imageUrl) e.bild = k.imageUrl;
      roh.set(schluessel, e);
    }
  }

  console.log(
    `[Künstler] ${konzerteGesamt} Konzerte -> ${roh.size} Namenskandidaten`
  );

  // ── Erster Durchgang: Wikidata, stapelweise ──────────────────────────────
  //
  // Läuft bei jedem Mal über alle noch offenen Namen. Fehltreffer werden
  // absichtlich NICHT als "kein Künstler" gemerkt: Wikidata kennt das lange
  // Ende schlecht, MusicBrainz soll sie danach trotzdem noch bekommen. Der
  // ganze Durchgang kostet nur gut zwei Minuten, ein Cache dafür lohnt nicht.
  const wdOffen = [...roh.entries()]
    .filter(([s, e]) => cache[s] === undefined && !trefferZu(s, e) && e.anzahl >= MIN_KONZERTE)
    .sort((a, b) => b[1].anzahl - a[1].anzahl);

  if (wdOffen.length > 0) {
    console.log(`[Künstler] Wikidata: ${wdOffen.length} Namen in Stapeln zu ${WD_PRO_STAPEL}`);
    let wdGefunden = 0;
    let wdFehler = 0;

    for (let i = 0; i < wdOffen.length; i += WD_PRO_STAPEL) {
      if (Date.now() > schluss) {
        console.log('[Künstler] Wikidata: Zeitbudget erreicht, Rest beim nächsten Lauf');
        break;
      }
      const teil = wdOffen.slice(i, i + WD_PRO_STAPEL);

      // Ausweichnamen kommen mit in denselben Stapel — bei Wikidata kostet ein
      // Name mehr in der Anfrage praktisch nichts, eine zweite Runde dagegen
      // schon.
      const zuFragen = [];
      for (const [, e] of teil) {
        zuFragen.push(e.roh);
        for (const a of e.alt || []) zuFragen.push(a);
      }
      const treffer = await wikidataStapel([...new Set(zuFragen)]);

      if (treffer === undefined) {
        // Technischer Fehler: Stapel überspringen, nicht als "nichts" werten
        if (++wdFehler >= 5) {
          console.warn('[Künstler] Wikidata antwortet nicht — Durchgang abgebrochen');
          break;
        }
        continue;
      }
      wdFehler = 0;

      for (const [schluessel, e] of teil) {
        const voll = treffer.get(e.roh);
        if (voll) {
          cache[schluessel] = { name: voll, land: null, quelle: 'wikidata' };
          wdGefunden++;
          continue;
        }
        // Kein Treffer auf den vollen Namen — die Ausweichnamen probieren
        let ersatz = null;
        for (const a of e.alt || []) {
          const t = treffer.get(a);
          if (t) { ersatz = [a, t]; break; }
        }
        if (!ersatz) continue; // MusicBrainz bekommt ihn später
        cache[normalisiere(ersatz[0])] =
          { name: ersatz[1], land: null, quelle: 'wikidata' };
        wdGefunden++;
      }

      if ((i / WD_PRO_STAPEL) % 10 === 9) {
        console.log(`[Künstler] Wikidata ${i + teil.length}/${wdOffen.length}, ${wdGefunden} erkannt`);
      }
    }

    console.log(`[Künstler] Wikidata: ${wdGefunden} Künstler erkannt`);
    if (wdGefunden > 0) speichereCache();
  }

  // ── Zweiter Durchgang: MusicBrainz, Name für Name ────────────────────────
  //
  // Offene Namen nach Konzertzahl: die bekanntesten zuerst, damit die Datei
  // schon nach dem ersten Lauf brauchbar ist.
  const offen = [...roh.entries()]
    .filter(([s, e]) => cache[s] === undefined && !trefferZu(s, e) && e.anzahl >= MIN_KONZERTE)
    .sort((a, b) => b[1].anzahl - a[1].anzahl)
    .slice(0, MAX_MB_PRO_LAUF);

  console.log(`[Künstler] MusicBrainz: ${offen.length} weitere Namen`);

  let gefunden = 0;
  let fehlerInFolge = 0;
  let seitLetzterSicherung = 0;
  let versucht = 0;
  for (const [schluessel, e] of offen) {
    if (Date.now() > schluss) {
      console.log(
        `[Künstler] Zeitbudget von ${MAX_MINUTEN} min erreicht — ` +
        `${versucht} von ${offen.length} versucht, Rest beim nächsten Lauf`
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 1100)); // MusicBrainz: 1 Anfrage/s

    // Fortschritt ins Log: Ohne das sieht man im Action-Protokoll eine
    // Viertelstunde lang gar nichts und weiss nicht, ob der Schritt arbeitet
    // oder haengt.
    if (++versucht % 50 === 0) {
      console.log(
        `[Künstler] ${versucht}/${offen.length} versucht, ${gefunden} bestätigt`
      );
    }

    const mb = await musicbrainz(e.roh);
    if (mb === undefined) {
      // Grosszuegiger als beim Geo-Cache: Dort heisst ein Fehler, dass
      // Nominatim streikt. Hier sind vereinzelte Fehlschlaege der Normalfall
      // (globaler Lastabwurf), erst eine lange Serie bedeutet einen Ausfall.
      if (++fehlerInFolge >= 40) {
        console.warn('[Künstler] Abbruch — MusicBrainz antwortet dauerhaft nicht');
        break;
      }
      continue;
    }
    fehlerInFolge = 0;
    cache[schluessel] = mb; // null merken = kein Künstler dieses Namens
    if (mb) gefunden++;

    // Zwischendurch sichern. Erst am Ende zu schreiben hiesse: Läuft der
    // Schritt ins Zeitlimit der Action, ist die Arbeit von einer
    // Viertelstunde verloren und der nächste Lauf fängt wieder von vorn an.
    if (++seitLetzterSicherung >= 25) {
      speichereCache();
      seitLetzterSicherung = 0;
    }
  }
  if (offen.length > 0) speichereCache();

  // Datei bauen: nur bestätigte Künstler, mit kanonischer Schreibweise.
  //
  // Zusammengefasst wird über den kanonischen Namen, nicht über den Rohtitel:
  // "Ina Müller und Band", "Ina Müller - Die 6.0 Tour" und "Ina Müller" sind
  // derselbe Mensch und müssen als ein Eintrag mit der Summe ihrer Konzerte
  // erscheinen, sonst steht sie dreimal in der Liste.
  const zusammen = new Map();
  for (const [schluessel, e] of roh) {
    const treffer = trefferZu(schluessel, e);
    if (!treffer) continue; // unbekannt oder noch nicht nachgeschlagen

    const key = normalisiere(treffer.name);
    const vorhanden = zusammen.get(key);
    if (vorhanden) {
      vorhanden.k += e.anzahl;
      if (!vorhanden.b && e.bild) vorhanden.b = e.bild;
      if (!vorhanden.l && treffer.land) vorhanden.l = treffer.land;
    } else {
      // Die MusicBrainz-ID steht bewusst NICHT in der ausgelieferten Datei:
      // Die App braucht sie nicht, und 36 Zeichen mal mehrere tausend Künstler
      // sind gut 200 kB, die jedes Gerät sonst mitlädt. Im Cache hier im Repo
      // bleibt sie erhalten, falls sie später gebraucht wird.
      zusammen.set(key, {
        n: treffer.name,      // kanonische Schreibweise der Quelle
        k: e.anzahl,          // angekündigte Konzerte
        b: e.bild || undefined,
        l: treffer.land || undefined,
      });
    }
  }

  const liste = [...zusammen.values()];
  liste.sort((a, b) => b.k - a.k || a.n.localeCompare(b.n));

  const ausgabe = {
    aktualisiert: new Date().toISOString(),
    // Beide Quellen nennen, nicht nur eine: Der Grossteil der Namen kommt
    // inzwischen aus dem schnellen Wikidata-Durchgang, nicht aus MusicBrainz.
    quelle: 'Wikidata und MusicBrainz (CC0)',
    anzahl: liste.length,
    kuenstler: liste,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(ausgabe));

  const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
  console.log(
    `[Künstler] ${gefunden} neu bestätigt | ${liste.length} in kuenstler.json (${kb} kB) | ` +
    `${Object.keys(cache).length} im Cache`
  );
}

main();
