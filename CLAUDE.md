# CLAUDE.md — ioBroker.unifi-access

## Projekt-Überblick

ioBroker-Adapter `ioBroker.unifi-access` für Ubiquiti UniFi Access (Tür-Reader, Doorbells, UA Ultra). Schwerpunkt: vollständige UA-Ultra-Unterstützung, Basis-Support für andere UniFi-Access-Geräte. Quelle der Wahrheit für die API ist `.doc/api_reference.pdf` im Repo (offizielle Developer-API von Ubiquiti).

Die PDF wurde einmalig in `.doc/api_reference.md` konvertiert (≈10 800 Zeilen Markdown). **Für API-Recherchen immer die Markdown-Datei per `grep` durchsuchen** — nie die PDF erneut konvertieren. Beispiele:
```bash
grep -n "door_thumbnail" .doc/api_reference.md
grep -A 30 "access.doorbell.incoming" .doc/api_reference.md
grep -n "firmware" .doc/api_reference.md
```

## Architektur

Drei unabhängig gebaute Teile:

| Teil | Quelle | Ausgabe | Script |
|---|---|---|---|
| Adapter-Core | `src/` (TypeScript) | `build/` | `npm run build` |
| Admin-customComponent | `src-admin/` (React/Vite) | `admin/custom/` | `npm run build:admin` |
| www-Panel | `src-www/` (React/Vite) | `www/` | `npm run build:www` |

Alle drei auf einmal: `npm run build:all`

## Tooling-Herkunft

| Bereich | Vorlage |
|---|---|
| eslint, prettier, tsconfig, vscode, gitignore, releaseconfig, CI | `/home/tim/ioBroker.icloud/` (1:1) |
| launch.json | `/home/tim/ioBroker.plex/.vscode/launch.json` (`iobroker.plex` → `iobroker.unifi-access`) |
| `src-admin/` (Vite, Module-Federation, Components) | `/home/tim/ioBroker.plex/src-admin/` |
| `src-www/` (Socket.io, React, Hooks) | `/home/tim/ioBroker.plex/src-www/` |
| `tasks.ts` (Admin-Copy-Script) | `/home/tim/ioBroker.plex/tasks.ts` (1:1) |
| Adapter-Lifecycle-Pattern (`main.ts`) | `/home/tim/ioBroker.plex/src/main.ts` |
| `library.ts` State-Manager | `/home/tim/ioBroker.plex/src/lib/library.ts` (ableiten) |

## Admin-UI: jsonConfig + customComponent

Konfiguration vollständig über `admin/jsonConfig.json`. Voraussetzung: `admin >=7.8.0` (in `globalDependencies`).

Module-Federation-customComponents:
- Federation-Name: `ConfigCustomUnifiAccessSet`
- Entry-Point: `admin/custom/customComponents.js` (generierter Output, nie direkt bearbeiten)
- Exponiert via `src-admin/src/Components.tsx`

### jsonConfig-Tabs

| Tab | Key | Inhalt |
|---|---|---|
| Verbindung | `_connectionTab` | `controllerHost`, `controllerPort` (12445), `apiToken`, `AuthSetup`-CustomComponent, `verifyTLS`, `caCert` |
| Geräte | `_devicesTab` | `DeviceManagement`-CustomComponent |
| Echtzeit | `_pollingTab` | `wsReconnectDelay` (5 s), `enablePolling` |
| Türen & Klingel | `_doorbellTab` | `defaultUnlockDuration` (Minuten, 0 = Puls; > 0 → `lock_rule type=custom` mit `interval` in Minuten) |
| Webhooks & Thumbnails | `_webhooksTab` | `enableWebhooks`, `webhookListenPort`, `webhookPath`, `webhookPublicUrl`, `enableThumbnailServer`, `thumbnailListenPort` |
| Events | `_eventsTab` | `forwardEvents` (table: event-type, deviceId, target-State) |

### Custom-Component-Referenz-Schema

```jsonc
{
  "type": "custom",
  "name": "ConfigCustomUnifiAccessSet/Components/AuthSetup",
  "url": "custom/customComponents.js",
  "i18n": true,
  "bundlerType": "module",
  "newLine": true,
  "xs": 12, "sm": 12, "md": 12, "lg": 12, "xl": 12
}
```

### Komponenten

- **`AuthSetup.tsx`** — Statusbadge + "Test connection"-Button. Prüft via `sendTo('getConnectionStatus')` ob Controller erreichbar, via `sendTo('verifyToken', {host, port, token})` Probe-Call ohne State-Mutation.
- **`DeviceManagement.tsx`** — listet Devices per `sendTo('listDevices')`, zeigt Modell-Tag und Capability-Chips (`event-thumbnail`, `doorbell`, `door-unlock`, `live-events`).

## Build-Pipeline (admin/custom/)

`tasks.ts` (Root) kopiert nach dem Vite-Build:
- `src-admin/build/customComponents.js` → `admin/custom/customComponents.js`
- `src-admin/build/assets/*.js` → `admin/custom/assets/`
- `src-admin/src/i18n/*.json` → `admin/custom/i18n/`

Aufruf: `npx tsx tasks.ts admin:copy` (intern von `build:admin`).

`admin/custom/` ist generierter Output — nie manuell bearbeiten.

## www-Seite (Status & Steuerung)

Vite-Bundle nach `www/`. Komponenten:

| Komponente | ioBroker-States/Calls |
|---|---|
| `ControllerStatusBadge` | `useIobState('info.connection')` |
| `DoorList` / `DoorCard` | `doors.<id>.*`-States, `setIobState('doors.<id>.unlock', true)` |
| `LastThumbnailCard` | `<img src="<webhookPublicHost>/unifi-access/<i>/thumbnail/<deviceId>.jpg">` (vom Adapter über den Thumbnail-Server gegen den Bearer-authentifizierten `/system/static`-Endpoint geproxyt) |
| `DoorbellCallsCard` | nur passive Anzeige von `doorbell.activeCallId/.activeFromDevice/.activeStartedAt` (kein Accept/Reject — kein dokumentierter Endpoint) |
| `EventLogCard` | `useIobState('events.last')` (JSON-Array, letzte 50) |
| `SettingsPanel` | persistiert in `admin.uiSettings` |

Socket.io-Loader und Hooks (`useConnection`, `useIobState`, `setIobState`, `useThemeMode`) 1:1 von Plex übernommen.

## Adapter-Code (`src/`)

```
src/
├── main.ts                 # Adapter-Klasse, Lifecycle, sendTo-Handler, Webhook-Mount
├── lib/
│   ├── library.ts          # State-/Object-Erzeugung
│   ├── unifiHttp.ts        # axios-basierter HTTPS-Client (Bearer-Header)
│   ├── unifiWebSocket.ts   # ws-Paket, wss://.../notifications, Reconnect + Heartbeat
│   ├── deviceModels.ts     # UA-Ultra (volle Features) vs. Basis-Modelle
│   ├── adapter-config.d.ts # AdapterConfig-Typing
│   └── types.ts            # eigene Typen + Webhook-Typen
├── webhooks/
│   ├── server.ts           # HTTP-Receiver mit HMAC-SHA256 Signature-Verify
│   └── registration.ts     # Self-Registration via /webhooks/endpoints
└── webserver/
    └── snapshotEndpoint.ts # /unifi-access/<i>/thumbnail/<deviceId>.jpg → /system/static
```

### sendTo-Handler (in `src/main.ts`)

| Command | Payload | Antwort |
|---|---|---|
| `getConnectionStatus` | — | `{connected, hasToken, lastError, controllerName, webhookRegistered}` |
| `verifyToken` | `{host, port, token, verifyTLS}` | `{ok:true, controllerName}` / `{ok:false, error:'unauthorized'\|'network'}` |
| `listDevices` | — | Devices mit `id, name, alias, type, model, firmware, online, capabilities, lastSeenAt` |
| `reregisterWebhook` | — | `{ok:true, id}` / `{ok:false, error}` — löscht und erzeugt den Webhook-Endpunkt neu (frisches Secret) |

### `onStateChange` Steuer-States

- `doors.<id>.unlock = true` →
  - `defaultUnlockDuration === 0` (Default): `PUT /api/v1/developer/doors/<id>/unlock` (Puls).
  - `defaultUnlockDuration > 0`: `PUT /api/v1/developer/doors/<id>/lock_rule {type:"custom", interval:<minutes>}` (Wert wird direkt als Minuten an die API durchgereicht).

### UniFi-API-Endpoints (`unifiHttp.ts`)

Stand der offiziellen Developer-Doku (`.doc/api_reference.md`).

| Methode | Endpoint | Methode | Hinweis |
|---|---|---|---|
| `verify()` / `listDevices()` | `/api/v1/developer/devices` | GET | Response: `{data: Device[][]}` (verschachtelt, wird geflattet) |
| `listDoors()` | `/api/v1/developer/doors` | GET | |
| `listUsers()` | `/api/v1/developer/users` | GET | |
| `unlockDoor(id)` | `/api/v1/developer/doors/:id/unlock` | PUT | Body nur `actor_id`/`actor_name`/`extra` (kein `duration`) |
| `setDoorLockRule(id, payload)` | `/api/v1/developer/doors/:id/lock_rule` | PUT | `type` und (bei `custom`) `interval` in Minuten |
| `getStaticResource(path)` | `/api/v1/developer/system/static/:path` | GET | Pfad aus `door_thumbnail`-Feld in Events |
| `listWebhookEndpoints()` | `/api/v1/developer/webhooks/endpoints` | GET | |
| `createWebhookEndpoint(payload)` | `/api/v1/developer/webhooks/endpoints` | POST | Antwort enthält `id` und `secret` |
| `deleteWebhookEndpoint(id)` | `/api/v1/developer/webhooks/endpoints/:id` | DELETE | |

WebSocket: `wss://host:port/api/v1/developer/devices/notifications` (Bearer-Auth-Header).

TLS-Konfiguration: `httpsAgent` mit `rejectUnauthorized: config.verifyTLS`, `ca: config.caCert`.

### Geräte-Feature-Matrix (`deviceModels.ts`)

```ts
type UnifiDeviceModel = 'UA-Ultra' | 'UA-G2-Pro' | 'UA-G3-Pro' | 'UA-Hub' | 'unknown';
type DeviceCapability = 'event-thumbnail' | 'doorbell' | 'door-unlock' | 'live-events';
// UA Ultra / UA G3 Pro: event-thumbnail, doorbell, door-unlock, live-events
// UA G2 Pro: door-unlock, live-events
// UA Hub: live-events
```

### Realtime-Events

**WebSocket** (`/devices/notifications`) — die einzigen drei Event-Strings, die hier ankommen:
- `access.remote_view` — Doorbell klingelt (Felder `channel`/`token` sind WebRTC-Zugangsdaten, werden NICHT genutzt)
- `access.remote_view.change` — Doorbell-Status (`reason_code` 105 timeout, 106 admin reject, 107 admin unlock, 108 visitor cancel, 400 answered elsewhere)
- `access.data.device.remote_unlock` — Admin hat eine Tür remote entsperrt

**Webhook-Events** (über `_webhooksTab` aktivierbar, HMAC-signiert, Adapter ist Receiver):
- `access.doorbell.incoming` / `.completed` / `.incoming.REN`
- `access.device.dps_status` (Türsensor)
- `access.door.unlock`
- `access.device.emergency_status`
- `access.unlock_schedule.activate` / `.deactivate`
- `access.temporary_unlock.start` / `.end`
- `access.visitor.status.changed`

### Webhook-Receiver

`src/webhooks/server.ts` startet einen lokalen HTTP-Server (Default Port 8095, Pfad `/unifi-access-webhook`). Jede Anfrage hat Header `Signature: t=<unix>,v1=<hmac-hex>`; geprüft per HMAC-SHA256 über `<t>.<rawBody>` mit dem bei der Registrierung erhaltenen Secret. Antworten: 200 ok, 401 bei fehlender/ungültiger Signatur. Maximaler Zeitversatz (`t`): 5 Minuten.

`src/webhooks/registration.ts` registriert die in `webhookPublicUrl` konfigurierte URL bei UniFi via `POST /webhooks/endpoints` und persistiert das zurückgegebene Secret in `info.webhookSecret` und im Adapter-`native`-Object. `reregister()` löscht und legt neu an, um ein frisches Secret zu erhalten (z. B. nach Verlust). Der User triggert das via sendTo `reregisterWebhook` aus dem Admin-Panel.

## i18n

- `admin/i18n/{lang}.json` — von jsonConfig genutzt (`"i18n": true`).
- `src-admin/src/i18n/{lang}.json` — via `tasks.ts` nach `admin/custom/i18n/` kopiert.
- Neue Keys mind. `en` + `de` zwingend; andere Sprachen mit englischem Fallback bis manuelle Übersetzung folgt.

## sendTo / Message-Handler

`"messagebox": true` in `io-package.json`. Custom-Components kommunizieren über `socket.sendTo('unifi-access.<instance>', '<command>', payload)`. Handler in `src/main.ts` im `onMessage`-Block.

## Changelog & Releases

### Versionsnummern-Schema (Semantic Versioning)

| Typ | Kommando | Wann |
|---|---|---|
| Patch `0.0.X` | `npm run release patch` | Bugfixes, interne Bereinigungen, keine neuen Features |
| Minor `0.X.0` | `npm run release minor` | Neue, rückwärtskompatible Features |
| Major `X.0.0` | `npm run release major` | Breaking Changes: geänderte State-Pfade, entfernte Features, API-Brüche |

### Pre-Release-Checkliste (manuell, vor `npm run release`)

1. **README.md** — alle neuen Einträge in `### **WORK IN PROGRESS**` eingetragen (Format: `* (ticaki) beschreibung`)
2. **io-package.json `news`** — Eintrag für die neue Version in allen Sprachen vorhanden (`en` + `de` zwingend; andere Sprachen dürfen englischen Fallback haben bis zur manuellen Übersetzung)
3. **Build** — `npm run build:all` läuft sauber durch (0 Fehler)
4. **Lint** — `npm run lint` zeigt 0 Errors (Warnings sind tolerierbar)
5. **Tests** — `npm test` grün

### Changelog-Format in README.md

```markdown
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
* (ticaki) kurze, nutzersichtbare Beschreibung der Änderung

### 0.0.2 (2026-05-02)
* (ticaki) weitere Änderung
```

Regeln:
- Einträge nur nutzersichtbar — keine Implementierungsdetails, keine Dateinamen, keine Commit-Verweise.
- Jeder Eintrag eine Zeile: `* (ticaki) ...`
- Verb-Konvention: `fixed:`, `new:`, `changed:` am Anfang der Beschreibung (Präfix klein, Doppelpunkt).

### news-Block in io-package.json

Der `news`-Block spiegelt den README-Changelog. Aufbau:

```jsonc
"news": {
  "0.0.3": {
    "en": "fixed: brief English description",
    "de": "behoben: kurze deutsche Beschreibung",
    "ru": "...",   // Fallback: englischer Text bis zur manuellen Übersetzung
    "pt": "...",
    "nl": "...",
    "fr": "...",
    "it": "...",
    "es": "...",
    "pl": "...",
    "uk": "...",
    "zh-cn": "..."
  }
}
```

Mehrere Einträge für eine Version werden zeilenweise verbunden: `"fixed: X\nnew: Y"`.

### Release-Kommando

```bash
npm run release patch   # oder minor / major
```

Das `@alcalzone/release-script` führt automatisch aus:
1. Bumpt Version in `package.json` **und** `io-package.json` synchron.
2. Ersetzt `### **WORK IN PROGRESS**` → `### X.Y.Z (YYYY-MM-DD)` in `README.md`.
3. Führt `npm run build:all` aus (via `.releaseconfig.json` `before_commit`-Hook).
4. Öffnet einen manuellen Review-Schritt (`manual-review`-Plugin) — letzter Ausstiegs-Checkpoint.
5. Erstellt Git-Commit + Tag `vX.Y.Z`.
6. Pusht nach GitHub (CI triggert daraufhin den `deploy`-Job, der NPM-Publish durchführt).

> **Wichtig**: `npm run release` **nie** auf einem Dirty-Working-Tree aufrufen. Vor dem Release alle Änderungen commiten.

## Was bewusst nicht in v1 enthalten ist

- **WebRTC-Live-Video / Doorbell Accept/Reject** — kein dokumentierter Endpoint, würde zweiten WebRTC-Stack im Adapter erfordern. Doorbell-Anrufe werden nur passiv angezeigt.
- **On-Demand-Snapshot per HTTP** — die Developer-API bietet keinen `/snapshot`-Endpoint; Bilder gibt es nur als `door_thumbnail`-Pfad in Events (passiv via `event-thumbnail`-State).
- **Two-Way-Audio / Microphone / Speaker** — keinerlei Audio-API in der Doku.
- **Cloud-Login (UI Identity / OAuth)** — nur API-Token lokal.
- **User/Visitor-Management (schreibend)** — Read-only in v1.
- **Rate-Limit-/Quota-Tracking**

## Externe Referenzen

| Ressource | Pfad |
|---|---|
| UniFi Access API-Dokumentation (PDF, im Repo) | `.doc/api_reference.pdf` |
| **Durchsuchbare Markdown-Version (für `grep`)** | **`.doc/api_reference.md`** |
| Online-Quelle (zur Verifikation) | https://assets.identity.ui.com/unifi-access/api_reference.pdf |

## Wichtige Dateien

| Datei | Zweck |
|---|---|
| `admin/jsonConfig.json` | Komplette Admin-UI-Definition |
| `src-admin/src/Components.tsx` | Re-Export aller customComponents |
| `src-admin/src/AuthSetup.tsx` | Verbindungs-Status + Test-Button (customComponent) |
| `src-admin/src/DeviceManagement.tsx` | Geräteverwaltungs-Panel (customComponent) |
| `src-admin/vite.config.ts` | Module-Federation-Konfiguration (`ConfigCustomUnifiAccessSet`) |
| `tasks.ts` | Kopiert Admin-Build-Output nach `admin/custom/` |
| `src/main.ts` | Adapter-Einstiegspunkt, Message-Handler, Webhook-Mount |
| `src/lib/unifiHttp.ts` | HTTPS-Client gegen UniFi Controller |
| `src/lib/unifiWebSocket.ts` | WebSocket-Listener für Echtzeit-Events |
| `src/lib/deviceModels.ts` | Feature-Gating nach Geräte-Modell |
| `src/webhooks/server.ts` | HTTP-Receiver für Webhook-Events (HMAC-validiert) |
| `src/webhooks/registration.ts` | Self-Registration des Webhook-Endpunkts |
| `src/webserver/snapshotEndpoint.ts` | Thumbnail-Proxy (event-driven) |
| `io-package.json` | Adapter-Metadaten, `adminUI.config: "json"`, `localLinks` |
| `.doc/api_reference.pdf` | Quelle der Wahrheit für API-Endpoints und Events |
| `.doc/api_reference.md` | Durchsuchbare Markdown-Version der API-Doku (via `grep`) |
