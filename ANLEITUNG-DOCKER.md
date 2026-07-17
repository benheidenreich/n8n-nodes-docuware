# DocuWare-Node sofort auf der eigenen n8n-Instanz nutzen (Linux + Docker)

Diese Anleitung zeigt, wie du die Node **sofort** auf deiner selbst gehosteten n8n-Instanz einsetzt — ohne auf die offizielle Verifizierung zu warten.

## Wichtig zu wissen: Verifizierung ≠ Installierbarkeit

Die **Verifizierung** durch n8n ist nur ein Qualitäts-Badge (u.a. für n8n Cloud). Auf einer **selbst gehosteten Instanz** kannst du jede Community-Node sofort installieren:

- **Sobald das Paket auf npm veröffentlicht ist** (dein `npm publish`, keine Prüfung durch n8n nötig): Installation direkt über die n8n-Oberfläche → **Weg 1**.
- **Noch vor dem npm-Publish** (z.B. zum Testen): Installation aus der lokalen Paketdatei → **Weg 2**.

---

## Weg 1: Nach `npm publish` — Installation über die n8n-Oberfläche (einfachste Variante)

1. Prüfe, dass Community-Nodes erlaubt sind (Standard: ja). Falls du die Variable explizit setzen willst, in deiner `docker-compose.yml`:

   ```yaml
   environment:
     - N8N_COMMUNITY_PACKAGES_ENABLED=true
   ```

2. In n8n als Owner anmelden → **Settings → Community Nodes → Install**.
3. Paketname eingeben: `@benheidenreich/n8n-nodes-docuware`, Risiko-Checkbox bestätigen, **Install**.
4. Fertig — die Node „DocuWare" erscheint sofort im Node-Panel. Updates später ebenfalls über Settings → Community Nodes.

Das funktioniert **direkt nachdem du selbst auf npm veröffentlicht hast** — die n8n-Verifizierung spielt dafür keine Rolle.

---

## Weg 2: Ohne npm-Publish — lokales Paket in den Docker-Container installieren

### Schritt 1: Paket auf dem Windows-PC bauen

```powershell
cd F:\ClaudeProjekte\N8n_Docuware_Skill\n8n-nodes-docuware
npm install
npm run build
npm pack
```

`npm pack` erzeugt die Datei **`benheidenreich-n8n-nodes-docuware-0.1.0.tgz`** — das ist exakt das, was auch auf npm landen würde (nur `dist/`, `package.json`, `README.md`; keine privaten Daten).

### Schritt 2: Datei auf den Linux-Server kopieren

```bash
scp benheidenreich-n8n-nodes-docuware-0.1.0.tgz benutzer@dein-server:/tmp/
```

(alternativ WinSCP o.ä.)

### Schritt 3: In den n8n-Container installieren

Community-Nodes leben im n8n-Datenverzeichnis unter `~/.n8n/nodes`. Container-Name ggf. anpassen (`docker ps` zeigt ihn; bei docker-compose oft `n8n`):

```bash
# Paketdatei in den Container kopieren
docker cp /tmp/benheidenreich-n8n-nodes-docuware-0.1.0.tgz n8n:/tmp/

# Als node-Benutzer (wichtig, sonst Rechteprobleme) installieren
docker exec -it -u node n8n sh -c "mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && npm install /tmp/benheidenreich-n8n-nodes-docuware-0.1.0.tgz"

# n8n neu starten, damit die Node geladen wird
docker restart n8n
```

Mit docker-compose entsprechend:

```bash
docker compose cp /tmp/benheidenreich-n8n-nodes-docuware-0.1.0.tgz n8n:/tmp/
docker compose exec -u node n8n sh -c "mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && npm install /tmp/benheidenreich-n8n-nodes-docuware-0.1.0.tgz"
docker compose restart n8n
```

**Hinweis:** Wenn dein `/home/node/.n8n` als Volume gemountet ist (Standard-Setup), überlebt die Installation auch Container-Neustarts und Image-Updates — sie liegt ja im Volume, nicht im Image.

### Schritt 4: Prüfen

1. n8n im Browser öffnen, neuen Workflow anlegen.
2. Im Node-Panel nach **„DocuWare"** suchen → die Node muss auftauchen.
3. Credentials anlegen (Server-URL, Benutzer, Passwort) und z.B. `File Cabinet → Get Many` ausführen — listet alle deine Archive.
4. Danach den Beispiel-Workflow importieren: `examples/beispiel-workflow.json` (siehe ANLEITUNG.md, Kapitel 6).

---

## Update auf eine neue Version (Weg 2)

1. Auf dem PC: Versionsnummer in `package.json` erhöhen (z.B. `0.1.1`), dann `npm run build && npm pack`.
2. Neue `.tgz` auf den Server kopieren und im Container erneut installieren (gleiche Befehle wie Schritt 3 — npm ersetzt die alte Version).
3. `docker restart n8n`.

## Wieder deinstallieren

```bash
docker exec -it -u node n8n sh -c "cd /home/node/.n8n/nodes && npm uninstall @benheidenreich/n8n-nodes-docuware"
docker restart n8n
```

---

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| Node erscheint nicht im Panel | Container wirklich neu gestartet? `docker logs n8n 2>&1 \| grep -i docuware` zeigt Ladefehler. |
| `EACCES` / Rechtefehler bei npm install | `docker exec` **mit `-u node`** ausführen; falls schon Root-Dateien entstanden sind: `docker exec -u root n8n chown -R node:node /home/node/.n8n/nodes` |
| „Community nodes disabled" | `N8N_COMMUNITY_PACKAGES_ENABLED=true` in der Umgebung setzen und Container neu erstellen (`docker compose up -d`). |
| Node lädt, aber Archiv-Dropdown bleibt leer | Credentials prüfen (Server-URL ohne Slash am Ende); der DocuWare-Benutzer braucht Platform-API-Zugriff. Details: ANLEITUNG.md Kapitel 10. |
| Sehr alte n8n-Version | Die Node nutzt natives `FormData` und benötigt Node.js ≥ 18 im Container — jedes n8n-Image ab ca. Version 1.0 erfüllt das. |
