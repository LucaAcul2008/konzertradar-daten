# KonzertRadar — Datenquelle

Öffentliche Datenversorgung für die KonzertRadar-App. Hier liegt **nur** der
Scraper; die App selbst ist ein separates, privates Repository.

Ein GitHub-Actions-Job holt alle 6 Stunden Konzerte über die öffentliche
Such-API von Eventim/Oeticket und veröffentlicht sie als statische JSON-Dateien
über GitHub Pages.

```
GitHub Actions (alle 6 h)
   └─ github_scraper/scrape.js
        └─ Eventim-Such-API  ──►  data/*.json  ──►  gh-pages
                                                       │
                                          KonzertRadar-App lädt per GET
```

## Warum ein eigenes Repo?

GitHub Pages und unbegrenzte Actions-Minuten gibt es im Free-Plan nur für
öffentliche Repositories. Der App-Code soll aber privat bleiben — also liegt
hier ausschließlich der Scraper, der nichts Schützenswertes enthält.

## Endpunkte

Basis-URL: `https://lucaacul2008.github.io/konzertradar-daten/`

| Datei | Inhalt |
|---|---|
| `index.json` | Zeitstempel und Statistik je Quelle |
| `eventim_de.json` | Deutschland, nächste 6 Monate |
| `eventim_de_full.json` | Deutschland, 12 Monate |
| `oeticket_at.json` | Österreich, nächste 6 Monate |
| `oeticket_at_full.json` | Österreich, 12 Monate |
| `*_highlights.json` | Von der Plattform empfohlene Konzerte |
| `*_ticketalarm.json` | Seit dem letzten Lauf neu angekündigt |
| `bekannte_ids.json` | Referenz, um neue Konzerte zu erkennen |

Format eines Eintrags:

```json
{
  "id": "eventim_21094202",
  "kuenstler": "Beispielband - Tour 2026",
  "ort": "Salzburg",
  "venue": "Rockhouse",
  "genre": "Rock & Pop",
  "datum": "2026-11-14T20:00:00+01:00",
  "imageUrl": "https://...",
  "ticketUrl": "https://...",
  "latitude": 47.8095,
  "longitude": 13.0432,
  "quelle": "Oeticket"
}
```

## Lokal ausführen

```sh
cd github_scraper
npm install
MAX_MONATE=1 node scrape.js   # schneller Testlauf über einen Monat
node scrape.js                # kompletter Lauf (12 Monate, ~2 min)
```

| Variable | Standard | Wirkung |
|---|---|---|
| `MONATE_VORAUS` | 12 | Zeitraum insgesamt |
| `MONATE_STANDARD` | 6 | Zeitraum der Datei, die die App beim Start lädt |
| `MAX_MONATE` | – | Nur die ersten N Monate (Testläufe) |
| `MAX_GEOCODE` | 150 | Nominatim-Anfragen pro Lauf |
| `MAX_LAUFZEIT_MIN` | 18 | Notbremse gegen hängende Läufe |
| `PAGES_URL` | – | Vorlauf-Daten, um neu angekündigte Konzerte zu erkennen |

## Einrichtung

1. Settings → Pages → Branch `gh-pages`
2. Actions → „Konzerte scrapen" → Run workflow
3. Prüfen: `https://lucaacul2008.github.io/konzertradar-daten/index.json`

`github_scraper/geo_cache.json` wird vom Job selbst aktualisiert und
zurückcommittet — er spart bei jedem Lauf Geocoding-Anfragen.

## Wartung

Der Job hatte zeitweise Aussetzer: Rund ein Viertel der Läufe lief in das
45-Minuten-Limit, ohne Daten zu liefern. Ursache war der Chrome-Download
während der Installation mit einer veralteten Puppeteer-Version (21.x, laut
npm nicht mehr unterstützt).

Dagegen wirken jetzt vier Dinge:

- **Puppeteer 25** statt 21 — und ohne `puppeteer-extra`/Stealth, das für den
  reinen JSON-Abruf nicht gebraucht wird. Eine Abhängigkeit statt drei,
  0 gemeldete Schwachstellen.
- **Chrome wird zwischengespeichert** (`actions/cache` auf `~/.cache/puppeteer`),
  statt bei jedem Lauf rund 150 MB neu zu laden.
- **Zeitlimits pro Schritt** (6 min Installation, 20 min Scraping) statt nur
  eines Limits für den ganzen Job.
- **Notbremse im Skript**: Nach `MAX_LAUFZEIT_MIN` (Standard 18) beendet sich
  der Scraper selbst — mit Fehlercode und **ohne zu schreiben**, damit die
  zuletzt veröffentlichten Daten unangetastet bleiben.

## Hinweis

Die Daten stammen aus der öffentlichen Such-API von Eventim/Oeticket.
Koordinaten teils über [Nominatim](https://nominatim.openstreetmap.org)
(© OpenStreetMap-Mitwirkende).
