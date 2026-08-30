# Umzug: Repo-Trennung durchführen

Alles ist lokal vorbereitet. Diese Schritte **in dieser Reihenfolge** ausführen —
das alte Repo erst am Ende auf privat stellen, sonst gibt es eine Lücke ohne
Daten.

---

## 0. Zuerst: Spotify-Secret rotieren 🔴

Das bisherige `SPOTIFY_CLIENT_SECRET` liegt in der Git-History des öffentlichen
Repos und ist damit kompromittiert — unabhängig davon, was du mit dem Repo
machst.

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) → App
   → **Settings** → *Rotate client secret*
2. Neuen Wert in die lokale `.env` eintragen
3. App neu bauen

Der alte Wert bleibt in der History; nach dem Rotieren ist er wertlos.

---

## 1. Daten-Repo anlegen und pushen

Auf GitHub ein neues **öffentliches** Repo `konzertradar-daten` anlegen
(ohne README, das existiert schon lokal), dann:

```sh
cd e:/VS_CODE/KonzertRadar/konzertradar-daten
git init
git add .
git commit -m "Scraper und Workflow aus dem App-Repo ausgelagert"
git branch -M main
git remote add origin https://github.com/LucaAcul2008/konzertradar-daten.git
git push -u origin main
```

## 2. Pages aktivieren und Workflow testen

1. Settings → Pages → Source: **Deploy from a branch**, Branch `gh-pages`
   (der Branch entsteht beim ersten Lauf — notfalls Schritt 3 zuerst)
2. Actions → „Konzerte scrapen" → **Run workflow**
3. Warten (~8 min), dann prüfen:

```sh
curl https://lucaacul2008.github.io/konzertradar-daten/index.json
```

Kommt gültiges JSON zurück, ist der Umzug geglückt.

> Beim ersten Lauf ist `neuAngekuendigt` gleich 0 — der Vergleichsstand fehlt
> noch. Ab dem zweiten Lauf füllt sich „Bald erhältlich" wieder.

## 3. App gegen die neue Adresse testen

`DATA_BASE_URL` zeigt in der `.env` bereits auf das neue Repo.

```sh
cd e:/VS_CODE/KonzertRadar/konzert_radar_fixed
flutter run
```

Konzerte da? Dann weiter.

## 4. App-Repo aufräumen und privat schalten

Im App-Repo sind Scraper, Workflow und der alte SSH-Key bereits entfernt —
die Änderungen müssen nur noch committet werden:

```sh
cd e:/VS_CODE/KonzertRadar/konzert_radar_fixed
git add -A
git commit -m "Scraper ausgelagert, Schluesseldatei entfernt, Daten-URL umgestellt"
git push
```

Dann: Settings → General → ganz unten **Change repository visibility** →
*Make private*.

> Der alte Workflow im App-Repo ist damit weg — es läuft nur noch der im
> Daten-Repo. Auch die alte Pages-Site (`.../konzert_radar_v2/`) wird beim
> Privatschalten abgeschaltet; deshalb Schritt 3 vorher testen.

---

## Danach prüfen

- [ ] `https://lucaacul2008.github.io/konzertradar-daten/index.json` liefert JSON
- [ ] App zeigt Konzerte
- [ ] Spotify-Login funktioniert mit dem neuen Secret
- [ ] Im Daten-Repo: Actions läuft nach Plan (alle 6 h)
- [ ] Im App-Repo: keine Workflows mehr aktiv

## Was der Umzug bringt

| | vorher | nachher |
|---|---|---|
| App-Code | öffentlich | **privat** |
| Scraper | im App-Repo | eigenes öffentliches Repo |
| Actions-Minuten | unbegrenzt (public) | unbegrenzt (Scraper liegt public) |
| GitHub Pages | ✅ | ✅ |
| Kosten | 0 € | 0 € |

Zusätzlich abgesichert: Der Scraper bricht jetzt nach 18 Minuten selbst ab
(`MAX_LAUFZEIT_MIN`), das Job-Limit steht auf 25 statt 45 Minuten. Zuvor liefen
28 % der Läufe ins 45-Minuten-Limit und lieferten keine frischen Daten.
