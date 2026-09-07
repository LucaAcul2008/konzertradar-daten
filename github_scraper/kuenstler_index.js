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
    return { mbid: a.id, name: a.name, land: a.country || null };
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
function speichereCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));
  } catch (e) {
    console.error('[Künstler] Cache-Speicherfehler:', e.message);
  }
}

// ─── Lauf ─────────────────────────────────────────────────────────────────────

async function main() {
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
      const e = roh.get(schluessel) || { anzahl: 0, bild: null, roh: kand };
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

  // Offene Namen nach Konzertzahl: die bekanntesten zuerst, damit die Datei
  // schon nach dem ersten Lauf brauchbar ist.
  const offen = [...roh.entries()]
    .filter(([s, e]) => cache[s] === undefined && e.anzahl >= MIN_KONZERTE)
    .sort((a, b) => b[1].anzahl - a[1].anzahl)
    .slice(0, MAX_MB_PRO_LAUF);

  console.log(`[Künstler] ${offen.length} neue Namen werden nachgeschlagen`);

  let gefunden = 0;
  let fehlerInFolge = 0;
  let seitLetzterSicherung = 0;
  let versucht = 0;
  const schluss = Date.now() + MAX_MINUTEN * 60 * 1000;
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

  // Datei bauen: nur bestätigte Künstler, mit kanonischer Schreibweise
  const liste = [];
  for (const [schluessel, e] of roh) {
    const mb = cache[schluessel];
    if (!mb) continue; // unbekannt oder noch nicht nachgeschlagen
    // Die MusicBrainz-ID steht bewusst NICHT in der ausgelieferten Datei: Die
    // App braucht sie nicht, und 36 Zeichen mal ~6000 Künstler sind gut 200 kB,
    // die jedes Gerät sonst mitlädt. Im Cache hier im Repo bleibt sie
    // erhalten, falls sie später gebraucht wird.
    liste.push({
      n: mb.name,          // kanonischer Name von MusicBrainz
      k: e.anzahl,         // angekündigte Konzerte
      b: e.bild || undefined,
      l: mb.land || undefined,
    });
  }
  liste.sort((a, b) => b.k - a.k || a.n.localeCompare(b.n));

  const ausgabe = {
    aktualisiert: new Date().toISOString(),
    quelle: 'MusicBrainz (CC0)',
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
