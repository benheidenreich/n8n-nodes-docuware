# DocuWare-Node für n8n — Anleitung (Deutsch)

Diese Anleitung erklärt, wie die Community-Node `@benheidenreich/n8n-nodes-docuware` verwendet wird — inklusive Beispiel-Workflow zum Befüllen aller Felder.

## 1. Was die Node kann

| Ressource | Operation | Zweck |
|---|---|---|
| Document | Upload | Datei mit Indexfeldern in ein Archiv ablegen |
| Document | Get | Metadaten eines Dokuments abrufen |
| Document | Search | Dokumente über Indexfelder suchen |
| Document | Update Fields | Indexfelder eines bestehenden Dokuments ändern |
| Document | Delete | Dokument löschen |
| File Cabinet | Get Many | Alle Archive mit Name und ID auflisten |

## 2. Installation

**n8n Cloud / GUI:** `Settings → Community Nodes → Install` → Paketname `@benheidenreich/n8n-nodes-docuware` eingeben.

**Self-hosted (Docker/npm):**

```bash
npm install @benheidenreich/n8n-nodes-docuware
```

(im n8n-Datenverzeichnis unter `~/.n8n/nodes/`, danach n8n neu starten)

## 3. Credentials einrichten

1. In n8n: `Credentials → New → DocuWare API`
2. **Server URL**: Basis-URL Ihrer DocuWare-Installation, z.B. `https://ihre-firma.docuware.cloud` (ohne Slash am Ende)
3. **Username** und **Password** eines DocuWare-Benutzers mit Platform-API-Zugriff

Die Anmeldung läuft über den offiziellen DocuWare Identity Service (OAuth 2.0). Das Token wird automatisch zwischengespeichert und erneuert — Sie müssen sich um nichts kümmern.

## 4. Wichtig: Felder werden automatisch geladen — kein Mapping nötig

**Sobald Sie ein Archiv (File Cabinet) im Dropdown auswählen, zieht die Node die komplette Feldstruktur live aus DocuWare.** Sie müssen vorher nichts mappen und nichts konfigurieren:

- Die **Archiv-Liste** im Dropdown kommt live aus DocuWare.
- Die **Feldnamen-Dropdowns** (manueller Modus, Suchbedingungen) laden die Felder des gewählten Archivs automatisch nach.
- Die **Datentypen** (Text, Ganzzahl, Dezimal, Datum, Stichwörter) werden automatisch aus der Archiv-Definition erkannt und korrekt konvertiert.
- Im **Auto-Modus** werden die Properties Ihres Input-Items automatisch mit den Feldnamen des Archivs abgeglichen (Groß-/Kleinschreibung egal, DB-Name **oder** Anzeigename funktioniert). Properties ohne passendes Archivfeld werden einfach ignoriert.

Das einzige, was Sie tun müssen: **die Properties in der Vor-Node so benennen wie die Felder im Archiv heißen** (DB-Name, z.B. `INVOICE_NUMBER`).

## 5. Die drei Feld-Eingabemodi

### a) Auto From Input Data (empfohlen)

Struktur in einer Vor-Node (Set oder Code) definieren — die DocuWare-Node übernimmt den Rest:

```json
{
  "COMPANY": "Muster GmbH",
  "INVOICE_NUMBER": "RE-2026-00123",
  "DOCUMENT_DATE": "2026-07-12",
  "AMOUNT": 199.9
}
```

→ In der DocuWare-Node nur noch: Archiv wählen, Binary-Feld angeben, fertig.

### b) JSON

Felder als JSON-Objekt direkt im Parameter **Fields (JSON)**, z.B. per Expression:

```
={{ { "INVOICE_NUMBER": $json.rechnungsNr, "AMOUNT": $json.betrag } }}
```

Unbekannte Feldnamen erzeugen eine klare Fehlermeldung, die alle verfügbaren Felder des Archivs auflistet.

### c) Manually Select

Felder einzeln per Dropdown zusammenklicken — praktisch für Einzelfälle. Der Typ steht standardmäßig auf „Auto (Detect From File Cabinet)".

## 6. Beispiel: Upload mit allen Feldern (importierbare Datei)

Im Ordner [`examples/beispiel-workflow.json`](examples/beispiel-workflow.json) liegt ein fertiger Workflow zum Importieren (`Workflow → Import from File`):

```
Manuell starten → Beispieldaten (Set) → Base64 zu Datei → DocuWare Upload
```

1. **Beispieldaten (Set-Node)**: enthält die Beispiel-Felder `COMPANY`, `INVOICE_NUMBER`, `DOCUMENT_DATE`, `AMOUNT` sowie ein eingebettetes Mini-Beispiel-PDF als Base64. **Passen Sie die Feldnamen an die DB-Namen Ihres Archivs an** — genau diese Namen werden im Auto-Modus gematcht.
2. **Base64 zu Datei (Convert to File)**: wandelt das Base64-PDF in das Binary-Feld `data` um. In echten Workflows kommt die Datei stattdessen z.B. aus einem E-Mail-Trigger, HTTP-Request oder "Read Binary File".
3. **DocuWare Upload**: Credentials zuweisen, Archiv im Dropdown wählen — fertig. Feld-Eingabemodus steht auf Auto.

**Welche DB-Namen hat mein Archiv?** Entweder im manuellen Modus das Feld-Dropdown öffnen (zeigt `Anzeigename (DBNAME)`), oder einmal `File Cabinet → Get Many` ausführen.

## 7. Suchen, Aktualisieren, Löschen

**Suchen:** Archiv wählen, Bedingungen hinzufügen (Feld-Dropdown + Wert, Wildcard `*` erlaubt, mehrere Bedingungen = UND). Ergebnis ist standardmäßig vereinfacht: Indexfelder als flaches Objekt, Datumswerte als ISO 8601, Dokument-ID als `DWDOCID`. Für die Rohantwort **Simplify** ausschalten.

**Update Fields:** Dokument-ID (z.B. `DWDOCID` aus einer Suche) + Felder wie beim Upload (alle drei Modi verfügbar):

```
Dokument-ID: ={{ $json.DWDOCID }}
```

**Delete:** Archiv + Dokument-ID. Gibt `{ "success": true, "documentId": ... }` zurück.

## 8. Archiv dynamisch wählen (Expression)

Wenn je nach Datensatz in unterschiedliche Archive geschrieben werden soll: beim Parameter **File Cabinet** auf Expression umschalten und die Archiv-ID übergeben:

```
={{ $json.zielArchivId }}
```

Mapping-Beispiel in einer Code-Node davor (IDs per `File Cabinet → Get Many` ermitteln):

```javascript
const archivMapping = {
  invoice: '00000000-0000-0000-0000-000000000001',
  contract: '00000000-0000-0000-0000-000000000002',
};

return items.map((item) => ({
  json: {
    ...item.json,
    zielArchivId: archivMapping[item.json.dokumenttyp],
  },
}));
```

## 9. Feldtypen und Formate

| DocuWare-Feldtyp | Erwartetes Eingabeformat | Beispiel |
|---|---|---|
| Text / Memo | Beliebiger Text | `"Muster GmbH"` |
| Numeric (Ganzzahl) | Zahl oder Zahlen-String | `42` |
| Decimal | Zahl oder Zahlen-String | `199.9` |
| Date / DateTime | `yyyy-MM-dd`, ISO 8601 oder `/Date(ms)/` | `"2026-07-12"` |
| Keywords (Stichwörter) | Array oder Einzelwert | `["intern", "geprüft"]` |

Ungültige Werte (z.B. Text in einem Zahlenfeld) erzeugen eine Fehlermeldung mit Feldname und Item-Nummer.

## 10. Fehlerbehebung

- **„DocuWare authentication failed"** → Server-URL/Benutzer/Passwort prüfen; der Benutzer braucht Platform-API-Zugriff.
- **Feld wird beim Upload nicht befüllt (Auto-Modus)** → Property-Name muss dem DB-Namen oder Anzeigenamen des Archivfelds entsprechen; leere Werte (`""`, `null`) werden bewusst übersprungen.
- **Einzelne fehlerhafte Items sollen den Workflow nicht stoppen** → in den Node-Settings „On Error → Continue" aktivieren; Fehler-Items behalten die Zuordnung zum Eingabe-Item.

## 11. Checkliste vor der Veröffentlichung (npm / n8n-Verifizierung)

1. In `package.json` die Platzhalter ersetzen: `YOUR_NAME`, `YOUR_EMAIL`, `YOUR_GITHUB_USER` (Repository-URL).
2. Optional: eigenes Icon in `nodes/DocuWare/docuware.svg` (das mitgelieferte ist ein neutrales Dokument-Icon; das offizielle DocuWare-Logo nur mit Genehmigung von DocuWare verwenden).
3. `npm run build` und `npm run lint` müssen fehlerfrei durchlaufen (Stand jetzt: ✅ beides grün).
4. GitHub-Repository anlegen und pushen, dann `npm publish` (beim ersten Mal `npm login`).
5. Für die offizielle Verifizierung durch n8n: [Verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/) — englische UI ✅, keine Runtime-Dependencies ✅, README-Vorlage ✅.
