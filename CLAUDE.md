# CLAUDE.md — ioBroker.unifi-access

## Projekt-Überblick

ioBroker-Adapter `ioBroker.unifi-access` für Ubiquiti UniFi Access (Tür-Reader, Doorbells, UA Ultra). Schwerpunkt: vollständige UA-Ultra-Unterstützung, Basis-Support für andere UniFi-Access-Geräte; optional UniFi-Protect-Snapshots zu Tür-Events und ein generischer Webhook-Empfänger („Alarm Manager“). Quelle der Wahrheit für die API ist `.doc/api_reference.pdf` im Repo (offizielle Developer-API von Ubiquiti, Stand v4.2.16).

Die PDF wurde einmalig in `.doc/api_reference.md` konvertiert (≈10 800 Zeilen Markdown). **Für API-Recherchen immer die Markdown-Datei per `grep` durchsuchen** — nie die PDF erneut konvertieren. Beispiele:
```bash
grep -n "door_thumbnail" .doc/api_reference.md
grep -A 30 "access.doorbell.incoming" .doc/api_reference.md
grep -n "Permission Key" .doc/api_reference.md
```

Nutzer-Doku: `README.md` (Überblick, Changelog), `README_ENGLISH.md` und `README_GERMAN.md` (inhaltlich gleich, beide pflegen).

## Architektur

Drei unabhängig gebaute Teile:

| Teil | Quelle | Ausgabe | Script |
|---|---|---|---|
| Adapter-Core | `src/` (TypeScript) | `build/` | `npm run build` |
| Admin-customComponents | `src-admin/` (React/Vite, eigenes `package.json`) | `admin/custom/` | `npm run build:admin` |
| www-Panel | `src-www/` (React/Vite, eigenes `package.json`) | `www/` | `npm run build:www` |

Alle drei auf einmal: `npm run build:all`. Alle drei Ausgaben sind **committet** (`build/` für Installationen von GitHub, `admin/custom/` und `www/` werden vom `deploy`-Job unverändert veröffentlicht). Nach jeder Änderung an `src-admin/` bzw. `src-www/` das Bundle neu bauen und mitcommitten — die CI prüft das (Schritt „Committed bundle is up to date“).

Abhängigkeiten installieren: `npm run npm` (Root, `src-admin`, `src-www`). Die Frontends brauchen zusätzlich das Root-`node_modules` (Prettier-Konfiguration, geteilte Module aus `src/lib`).

## Tooling-Herkunft

| Bereich | Vorlage |
|---|---|
| eslint, prettier, tsconfig, vscode, gitignore, releaseconfig, CI | `/home/tim/ioBroker.icloud/` (1:1) |
| launch.json | `/home/tim/ioBroker.plex/.vscode/launch.json` (`iobroker.plex` → `iobroker.unifi-access`) |
| `src-admin/` (Vite, Module-Federation, Components) | `/home/tim/ioBroker.plex/src-admin/` |
| `src-www/` (Socket.io, React, Hooks) | `/home/tim/ioBroker.plex/src-www/` |
| `tasks.ts` (Admin-Copy-Script) | `/home/tim/ioBroker.plex/tasks.ts` (abgeleitet) |
| Adapter-Lifecycle-Pattern (`main.ts`) | `/home/tim/ioBroker.plex/src/main.ts` |
| `library.ts` State-Manager | `/home/tim/ioBroker.plex/src/lib/library.ts` (abgeleitet) |

### Formatierung

- Root (`src/`, `test/`, Konfiguration): `prettier.config.mjs` = `@iobroker/eslint-config/prettier.config.mjs` mit **Tabs**, Single Quotes.
- `src-admin/`, `src-www/`: **4 Leerzeichen** (Basis-Konfiguration von `@iobroker/eslint-config`). Frontend-Dateien deshalb mit `npx prettier --config node_modules/@iobroker/eslint-config/prettier.config.mjs <datei>` formatieren, nicht mit der Root-Konfiguration.
- TypeScript bleibt auf 6.0.x (typescript-eslint, ts-node und `@iobroker/adapter-dev` unterstützen 7.x noch nicht; in `.github/dependabot.yml` gesperrt).

## Admin-UI: jsonConfig + customComponents

Konfiguration vollständig über `admin/jsonConfig.json`. Voraussetzung: `admin >=8.0.12` (in `globalDependencies`).

Module-Federation-customComponents:
- Federation-Name: `ConfigCustomUnifiAccessSet`
- Entry-Point: `admin/custom/customComponents.js` (generierter Output, nie direkt bearbeiten)
- Exponiert via `src-admin/src/Components.tsx`

### jsonConfig-Tabs

| Tab | Key | Inhalt |
|---|---|---|
| Verbindung | `_connectionTab` | `controllerHost`, `controllerPort` (12445), `apiToken` (Passwortfeld), `AuthSetup`-CustomComponent, `verifyTLS` (Default aus), `caCert` (mehrzeilig, aktiv bei `verifyTLS` oder `enableProtect && protectVerifyTLS`), `wsReconnectDelay` (5 s, 1–300) |
| Geräte & Türen | `_devicesTab` | `DeviceManagement`-CustomComponent, Klingel-Hinweis, `defaultUnlockDuration` (Minuten 0–600, 0 = Puls), `unlockActorId` (`ActorSelect`-CustomComponent, ohne `attr`), Hinweis `_unlockActorNote` |
| HTTP-Server | `_serverTab` | `listenPort` (8095), `listenIp` (0.0.0.0), `publicBaseUrl` (optional, Validator), `enableTls` + Zertifikatsauswahl (`certPublic`/`certPrivate`/`certChained`), `enableWebhooks`, sendTo-Button `_reregisterWebhook` (`reregisterWebhook`), `enableThumbnailServer` |
| Alarm Manager | `_genericWebhookTab` | `enableGenericWebhook`, `genericWebhookPath` (`/webhook`, Validator inkl. reservierter Pfade), `genericWebhookAuth` (`none`/`basic`/`bearer`), `genericWebhookUsername`/`genericWebhookPassword`/`genericWebhookToken`, `GenericWebhookUrl`-CustomComponent |
| UniFi Protect | `_protectTab` | `enableProtect`, `protectUsername`, `protectPassword`, `protectVerifyTLS` (Default **aus**) |
| Event-Weiterleitung | `_eventsTab` | `forwardEvents` (Tabelle: `event`, `deviceId`, `targetState`) |

Nur in `native` (kein Feld): `protectPort` (443), `webhookEndpointId`, `webhookSecret`. Verschlüsselt (`encryptedNative` = `protectedNative`): `apiToken`, `webhookSecret`, `genericWebhookPassword`, `genericWebhookToken`, `protectPassword`. Jedes jsonConfig-Attribut braucht einen Default in `io-package.json` `native` (geprüft in `src/lib/packageConfig.test.ts` und `src-admin/src/jsonConfig.test.ts`).

### Custom-Component-Referenz-Schema

```jsonc
{
  "type": "custom",
  "name": "ConfigCustomUnifiAccessSet/Components/AuthSetup",
  "url": "custom/customComponents.js",
  "i18n": true,
  "guiApi": 2,
  "newLine": true,
  "xs": 12, "sm": 12, "md": 12, "lg": 12, "xl": 12
}
```

### Komponenten (`src-admin/src/`)

- **`AuthSetup.tsx`** — „Test connection“: `sendTo('verifyToken', {host, port, token, verifyTLS, caCert})` mit den Formularwerten; zeigt `deviceCount` bzw. einen eigenen Text für `unauthorized`/`network`/`tls` (+ `detail`).
- **`DeviceManagement.tsx`** — listet Devices per `sendTo('listDevices')`, zeigt Modell-Tag und Capability-Chips (`event-thumbnail`, `doorbell`, `door-unlock`, `live-events`).
- **`ActorSelect.tsx`** — Auswahl des Unlock-Akteurs per `sendTo('listUsers')`.
- **`GenericWebhookUrl.tsx`** — zeigt die URL des Alarm-Manager-Webhooks nach `getServerInfo` (tatsächlicher Serverzustand) und `getNetworkInterfaces`; Hinweise bei TLS-Fehler, gestopptem Server und ungespeicherten Änderungen.
- **`serverUrl.ts`** — importfreie Kopie der Adapter-Regeln für Basis-URL, Pfad und Port (muss zu `src/lib/publicBaseUrl.ts`, `src/webhooks/genericWebhookServer.ts`, `src/lib/controlValues.ts` passen).
- **`adapterRequest.ts`** — `requestAdapter()` (sendTo mit Timeout, prüft vorher selbst, ob die Instanz läuft) und Fehlertexte.

Die Frontend-Tests (`src-admin/src/test/harness.ts`, `src-www/src/test/socketMock.ts`) bilden das echte Verhalten von Admin bzw. Socket nach (u. a. Echo + Bestätigung eines `setState`, verzögerte Zustellung über `holdDeliveries`/`deliverNext`, `setAdapterRunning`).

## Build-Pipeline (admin/custom/)

`tasks.ts` (Root) leert `admin/custom/` und kopiert nach dem Vite-Build:
- `src-admin/build/customComponents.js` → `admin/custom/customComponents.js`
- `src-admin/build/mf-manifest.json` → `admin/custom/mf-manifest.json`
- `src-admin/build/assets/*.js` → `admin/custom/assets/`
- `src-admin/src/i18n/*.json` → `admin/custom/i18n/`

Aufruf: `npx tsx tasks.ts admin:copy` (intern von `build:admin`).

`admin/custom/` ist generierter Output — nie manuell bearbeiten.

## www-Seite (Status & Steuerung)

Vite-Bundle nach `www/`, erreichbar über den Web-Adapter unter `/unifi-access/index.html?instance=<n>` (`localLinks._default`). Komponenten:

| Komponente | ioBroker-States/Calls |
|---|---|
| `ControllerStatusBadge` | `useIobState('info.connection')` + Socket-Verbindung |
| `DoorList` / `DoorCard` | `doors.<id>.*` (inkl. `lockRuleType`/`lockRuleEndsAt`), `setIobState('doors.<id>.unlock', true)`; `doors.emergency.*` ist keine Tür, sondern ein Hinweisbanner |
| `LastThumbnailCard` | `<img src>` aus `devices.<id>.lastThumbnailUrl` (vom Adapter über den Thumbnail-Server gegen den Bearer-authentifizierten `/system/static`-Endpoint geproxyt) |
| `DoorbellCallsCard` | nur passive Anzeige von `doorbell.activeCallId/.activeFromDevice/.activeStartedAt` (kein Accept/Reject — kein dokumentierter Endpoint) |
| `EventLogCard` / `EventMediaModal` | `events.last` (JSON-Array, letzte 50), Protect-Snapshot mit Countdown nur für live eintreffende Events, „Access denied“ bei `granted === false` |
| `SettingsPanel` | persistiert in `admin.uiSettings` (Adapter validiert und bestätigt); nur Hell/Dunkel im `localStorage` |
| `SocketLoadErrorAlert` | Meldung, wenn `socket.io.js` des Web-Adapters nicht ladbar ist |

Socket.io-Loader in `src-www/index.html`: lädt `../lib/js/socket.io.js` (funktioniert auch mit Pfad-Präfix hinter einem Reverse-Proxy und setzt dann `window.socketPath`), Fallback `/lib/js/socket.io.js`. Hooks in `socket.ts`: `useConnection`, `useConnectionStatus`, `useIobState`, `useIobStates`, `useIobStateArrival`, `setIobState`; `theme.ts`: `useThemeMode`. Das Panel ist nur englischsprachig.

## Adapter-Code (`src/`)

```
src/
├── main.ts                       # Adapter-Klasse, Lifecycle, sendTo-Handler, Steuer-States, Webhook-/Protect-Logik
├── lib/
│   ├── library.ts                # State-/Object-Erzeugung (schreibt nur über stoppfeste Wrapper)
│   ├── unifiHttp.ts              # axios-HTTPS-Client (Bearer), API-Hülle, Fehlerklassen, Berechtigungs-Hinweis bei 403
│   ├── unifiWebSocket.ts         # ws-Paket, wss://…/notifications, Reconnect-Back-off, Heartbeat (30 s)
│   ├── protectHttp.ts            # UniFi-Protect-Client (Login, Snapshot, Event-Meta, Clip-Stream)
│   ├── deviceModels.ts           # Modell-Erkennung + Capabilities
│   ├── controlValues.ts          # Prüfung der Steuerwerte (unlock_duration 0–600, lock_rule 0–4, Port)
│   ├── eventNormalizer.ts        # WebSocket-/Webhook-Envelope → NormalizedEvent, Maskierung
│   ├── caCert.ts                 # PEM-Reparatur des CA-Felds, System-CAs + eigenes CA
│   ├── tlsErrors.ts              # TLS-Fehlercodes → verständliche Hinweise
│   ├── publicBaseUrl.ts          # Prüfung/Normalisierung von publicBaseUrl
│   ├── pathSafety.ts             # Validierung von Thumbnail-/Clip-Pfaden
│   ├── snapshotCache.ts          # Protect-Snapshot-Cache (50 Einträge / 32 MiB)
│   ├── secretMigration.ts        # Verschlüsselung von Klartext-Geheimnissen in native
│   ├── logThrottle.ts            # gedrosselte Wiederholungs-Logs
│   ├── stopSignal.ts             # StoppedError / isStoppedError / throwIfStopped
│   ├── timerHost.ts              # Timer über die Adapter-API (kein globales setTimeout/setInterval)
│   ├── adapter-config.d.ts       # AdapterConfig-Typing
│   └── types.ts                  # eigene Typen + Webhook-/Event-Typen
├── webhooks/
│   ├── server.ts                 # UniFi-Webhook-Receiver mit HMAC-SHA256-Signature-Verify
│   ├── registration.ts           # Self-Registration via /webhooks/endpoints (ensureRegistration, reregister)
│   └── genericWebhookServer.ts   # Alarm-Manager-Webhook (none/basic/bearer, reservierte Pfade)
└── webserver/
    ├── sharedHttpServer.ts       # gemeinsamer HTTP(S)-Server für alle Handler
    ├── snapshotEndpoint.ts       # /unifi-access/<i>/thumbnail/<deviceId>.jpg → /system/static
    └── protectSnapshotEndpoint.ts # /unifi-access/<i>/protect-snapshot/… und /protect-video/…
```

Tests liegen neben dem Code (`*.test.ts`) bzw. unter `test/` (`test/mock/`, `test/contract/`, `test/functional/`, `test/integration.js`, `test/package.js`).

### Stopp-Mechanismus („Arbeit nach dem Stopp“)

Nach `onUnload` darf laufende Arbeit nichts mehr bewirken: keine Requests an Controller/Protect, keine State-/Object-Schreibvorgänge, keine neuen Timer, kein „connected“-Log. Umsetzung in `src/lib/stopSignal.ts`:
- `UnifiHttp`, `ProtectHttp` und die Webhook-Registrierung bekommen `isStopped` und verweigern danach jeden neuen Request (`StoppedError`).
- `main.ts` schreibt nur über `writeState`, `writeForeignState`, `startTimer`, `startInterval`; `library.ts` nur über `set`/`extend`/`create`. Handler erkennen den Abbruch mit `isStoppedError` bzw. `rethrowIfStopped` und enden still.
- Durchgesetzt per ESLint-Regel `no-restricted-syntax` in `eslint.config.mjs` (für `src/main.ts` und `src/lib/library.ts`): direkte Aufrufe von `setState*`, `setForeignState*`, `extend*Object*`, `setObject*`, `delObject*`, `delState*`, `setTimeout`, `setInterval` sind Fehler, außer direkt nach `throwIfStopped()`.

### Start-Verhalten

Reihenfolge in `onReady`: `info.connection` = false → Altobjekte löschen (`info.webhookSecret`) → Basis-Objekte → `info.webhookRegistered`/`info.protectConnected` = false, aktiven Klingelruf löschen → Installationskennung laden → Konfiguration prüfen (Host/Token, CA, `publicBaseUrl`) → Controller-Client anlegen → Subscriptions → HTTP-Server starten (nur wenn ein Handler aktiv ist) → Webhook-Prüfung starten → Bootstrap (`GET /devices`, `/doors`, Lock-Rules, Emergency) + WebSocket → `finishStartup()` → zuletzt Protect-Login (`initProtect`, Klartext-Passwort wird dabei verschlüsselt), damit Türsteuerung und Events nicht darauf warten. sendTo-Anfragen in `STATE_DEPENDENT_COMMANDS` warten bis zu 8 s (`STARTUP_WAIT_MS`) auf das Ende des Starts.

### sendTo-Handler (in `src/main.ts`)

Jede Nachricht mit Callback wird genau einmal beantwortet; Fehler stehen im String-Feld `error`. Geloggt wird nur das Kommando, nie der Payload.

| Command | Payload | Antwort |
|---|---|---|
| `getConnectionStatus` | — | `{connected, hasToken, lastError, controllerName, webhookRegistered}` (vom Frontend derzeit nicht genutzt) |
| `verifyToken` | `{host, port, token, verifyTLS?, caCert?}` | `{ok:true, deviceCount}` / `{ok:false, error:'missing-fields'\|'unauthorized'\|'network'}` / `{ok:false, error:'tls', detail:<Code>}` — eigener Probe-Client, keine State-Mutation; fehlende `verifyTLS`/`caCert` → gespeicherte Werte |
| `listDevices` | — | `{devices:[{id, name, alias, type, model, firmware, online, capabilities, lastSeenAt}]}` |
| `listUsers` | — | `{users:[{id, name}]}` / `{users:[], error:'not-configured'\|'unauthorized'\|'network'}` (liest alle Seiten) |
| `reregisterWebhook` | — | `{ok:true, id}` / `{ok:false, error}` mit `not-configured`, `webhooks-disabled`, `receiver-not-running`, `unloading` oder Fehlertext — löscht nur eigene Endpunkte und legt neu an (frisches Secret); antwortet, bevor das Speichern des Secrets die Instanz neu startet |
| `getServerInfo` | — | `{running, scheme, port, baseUrl, tlsEnabled, tlsActive, tlsError, publicBaseUrl}` — tatsächlicher Zustand des eingebauten Servers |
| `getNetworkInterfaces` | — | `{addresses: string[]}` (nicht-interne IPv4) |
| unbekannt | — | `{ok:false, error:'unknown-command'}` |

Den Vertrag Frontend ↔ Adapter prüft `test/contract/frontendContract.test.ts` (echter Adapter mit Fake-Core und Mock-Controller gegen die Frontend-Quelltexte). Bei Änderungen an Antwortformaten, Fehlercodes oder State-IDs beide Seiten anpassen.

### `onStateChange` Steuer-States

Nur Schreibvorgänge mit `ack: false`. Befehle werden **abgewiesen** (Warnung, State mit `ack` auf den letzten bestätigten Wert zurück, nichts vorgemerkt), solange kein Controller konfiguriert ist, der Bootstrap seit dem Start nie gelang oder die Verbindung verloren ist (`commandBlocker()`), sowie bei ungültigen Werten.

- `doors.<id>.unlock = true` →
  - `defaultUnlockDuration === 0` (Default): `PUT /api/v1/developer/doors/<id>/unlock` (Puls, mit `actor_id`/`actor_name` des konfigurierten `unlockActorId`).
  - `defaultUnlockDuration > 0`: `PUT /api/v1/developer/doors/<id>/lock_rule {type:"custom", interval:<minutes>}` (Minuten direkt an die API).
- `doors.<id>.unlock_duration` (0–600 Minuten, 0 = Puls) → wie oben für genau diesen Aufruf.
- `doors.<id>.lock_rule` (Index 0–4 → `reset`, `keep_unlock`, `keep_lock`, `lock_now`, `lock_early`) → `PUT …/lock_rule {type}`.
- `doors.emergency.lockdown` / `.evacuation` (nur Booleans) → `PUT /doors/settings/emergency`; das andere Flag wird vorher frisch gelesen.
- `admin.uiSettings` (JSON-String ≤ 10 000 Zeichen) → validiert und bestätigt.
- Nach jedem Tür-Befehl und Tür-Event wird der Türstatus vom Controller zurückgelesen (`locked`, `position`, Lock-Rule); am Regelende (`lockRuleEndsAt`) erneut.

### UniFi-API-Endpoints (`unifiHttp.ts`)

Stand der offiziellen Developer-Doku (`.doc/api_reference.md`). Antwort-Hülle `{code, msg, data}`; ein `code` ≠ `SUCCESS` bei HTTP 200 gilt als Fehler.

| Methode | Endpoint | HTTP | Berechtigung | Hinweis |
|---|---|---|---|---|
| `listDevices()` | `/api/v1/developer/devices?refresh=true` | GET | `view:device` | Response `{data: Device[][]}` (verschachtelt, wird geflattet); auch Sonde für `verifyToken` |
| `listDoors()` | `/api/v1/developer/doors` | GET | `view:space` | |
| `getDoor(id)` | `/api/v1/developer/doors/:id` | GET | `view:space` | Status-Rücklesen |
| `getDoorLockRule(id)` | `/api/v1/developer/doors/:id/lock_rule` | GET | `view:space` | → `lockRuleType`/`lockRuleEndsAt` |
| `listUsers()` | `/api/v1/developer/users?page_num&page_size=100` | GET | `view:user` | seitenweise, höchstens 50 Seiten; Fallback ohne Parameter |
| `unlockDoor(id, actor?)` | `/api/v1/developer/doors/:id/unlock` | PUT | `edit:space` | Body nur `actor_id`/`actor_name` (gemeinsam)/`extra` (kein `duration`) |
| `setDoorLockRule(id, payload)` | `/api/v1/developer/doors/:id/lock_rule` | PUT | `edit:space` | `type` und (bei `custom`) `interval` in Minuten |
| `getEmergencyStatus()` / `readEmergencyStatus()` | `/api/v1/developer/doors/settings/emergency` | GET | `view:space` | |
| `setEmergencyStatus(payload)` | `/api/v1/developer/doors/settings/emergency` | PUT | `edit:space` | |
| `getStaticResource(path)` | `/api/v1/developer/system/static/:path` | GET | `view:system_log` | Pfad aus `door_thumbnail` (validiert) |
| `fetchSystemLogsRaw(topic, since, until)` | `/api/v1/developer/system/logs` | POST | `view:system_log` | nur bei aktiver Protect-Integration (Kamera-Zuordnung) |
| `listWebhookEndpoints()` | `/api/v1/developer/webhooks/endpoints` | GET | `view:webhook` | enthält `secret` |
| `createWebhookEndpoint(payload)` | `/api/v1/developer/webhooks/endpoints` | POST | `edit:webhook` | Antwort enthält `id` und `secret` |
| `updateWebhookEndpoint(id, payload)` | `/api/v1/developer/webhooks/endpoints/:id` | PUT | `edit:webhook` | Name/URL/Events angleichen, ID und Secret bleiben |
| `deleteWebhookEndpoint(id)` | `/api/v1/developer/webhooks/endpoints/:id` | DELETE | `edit:webhook` | |

`requiredPermission()` ordnet jedem Request den Permission Key zu; bei 403 nennt das Log die fehlende Berechtigung.

WebSocket: `wss://host:port/api/v1/developer/devices/notifications` (Bearer-Auth-Header), Heartbeat 30 s, Back-off bis `wsReconnectDelay`, Reset erst nach 30 s stabiler Verbindung, Neuladen nach Reconnect höchstens einmal pro Minute.

TLS-Konfiguration (Controller, WebSocket, Protect): `httpsAgent` mit `rejectUnauthorized: verifyTLS === true` (Protect: `protectVerifyTLS === true`), `ca: trustedCertificates(caCert)` (System-CAs + eigenes CA, `src/lib/caCert.ts`). Kein stiller Rückfall auf ungeprüfte Verbindungen.

### Geräte-Feature-Matrix (`deviceModels.ts`)

```ts
type UnifiDeviceModel = 'UA-Ultra' | 'UA-G2-Pro' | 'UA-G3-Pro' | 'UA-Intercom' | 'UA-Lite' | 'UA-Hub' | 'unknown';
type DeviceCapability = 'event-thumbnail' | 'doorbell' | 'door-unlock' | 'live-events';
// UA Ultra / UA G3 Pro / UA G2 Pro / UA Intercom: event-thumbnail, doorbell, door-unlock, live-events
// UA Lite: door-unlock, live-events
// UA Hub (UAH, UGT, EAH…, Hub-Door-Mini, Hub-Gate): live-events
// unknown: live-events
```

Thumbnail-States (`lastThumbnailPath/Url/At`) entstehen bei Bedarf für jedes Gerät, das ein Thumbnail liefert.

### Realtime-Events

**WebSocket** (`/devices/notifications`) — die einzigen drei Event-Strings, die hier ankommen:
- `access.remote_view` — Doorbell klingelt (Felder `channel`/`token` sind WebRTC-Zugangsdaten, werden NICHT genutzt und aus `events.last` entfernt)
- `access.remote_view.change` — Doorbell-Status (`reason_code` 105 timeout, 106 admin reject, 107 admin unlock, 108 visitor cancel, 400 answered elsewhere)
- `access.data.device.remote_unlock` — Admin hat eine Tür remote entsperrt

**Webhook-Events** (über `_serverTab` aktivierbar, HMAC-signiert, Adapter ist Receiver):
- `access.doorbell.incoming` / `.completed` / `.incoming.REN`
- `access.device.dps_status` (Türsensor)
- `access.door.unlock` (Feld `granted` aus `data.object.result`)
- `access.device.emergency_status`
- `access.unlock_schedule.activate` / `.deactivate`
- `access.temporary_unlock.start` / `.end`
- `access.visitor.status.changed`

`events.last`: letzte 50, `NormalizedEvent` (`ts, source, type, subtype?, deviceId?, deviceName?, doorId?, doorName?, userName?, granted?, thumbnailPath?, protect*?, raw`). `authentication_value` wird in `events.last` und Forward-States als `***` maskiert, im Debug-Log zusätzlich `issuer`. Klingelrufe: spätestens nach 3 min ohne Ende-Event gelöscht; verspätete Webhooks eines beendeten Rufs werden ignoriert.

### HTTP-Server, Webhook-Receiver und Medien

`src/webserver/sharedHttpServer.ts` ist ein gemeinsamer Server auf `listenPort` (8095) / `listenIp`. Er startet nur, wenn mindestens ein Handler aktiv ist (Webhooks, Thumbnail-Server, Protect-Medien, Generic-Webhook). `enableTls`: Zertifikate aus dem ioBroker-Zertifikatsspeicher; lassen sie sich nicht laden, startet der Server **nicht** (fail closed, `tlsError` in `getServerInfo`). Basis-URL für alle nach außen gemeldeten URLs: `publicBaseUrl`, sonst `<scheme>://<listenIp oder erste IPv4>:<port>`; ohne laufenden Server keine URL (`lastThumbnailUrl` leer).

`src/webhooks/server.ts`: Pfad fest `/unifi-access-webhook`. Header `Signature: t=<unix>,v1=<hmac-hex>`; geprüft per HMAC-SHA256 über `<t>.<rawBody>` mit dem Secret. Antworten: 200 ok, 401 bei fehlender/ungültiger Signatur. Maximaler Zeitversatz (`t`): 5 Minuten.

`src/webhooks/registration.ts`: `ensureRegistration()` registriert `<Basis-URL>/unifi-access-webhook` per `POST /webhooks/endpoints` bzw. gleicht einen eigenen Endpunkt per `PUT` an (gleiche ID/Secret, kein Neustart). Das Secret liegt nur verschlüsselt in `native.webhookSecret` (der State `info.webhookSecret` ist entfallen und wird beim Start gelöscht). Endpunkt-Name `ioBroker.unifi-access (<namespace>@<host>#<8 Zeichen Installations-UUID>)`; nur Endpunkte mit diesem Namen oder der gespeicherten ID werden angefasst. Prüfung nach jedem erfolgreichen Bootstrap und alle 15 min (`WEBHOOK_CHECK_INTERVAL_MS`); nach einem Fehlschlag Retry ab 60 s, wachsend bis 5 min. `reregister()` löscht und legt neu an (frisches Secret); der User triggert das via sendTo `reregisterWebhook`.

`src/webhooks/genericWebhookServer.ts`: Pfad normalisiert (`/` ergänzt, Mehrfach-`/` zusammengefasst); reserviert sind `/unifi-access-webhook` und `/unifi-access/…` (Validator in jsonConfig und Prüfung im Adapter → Fehler im Log, kein Mount). `basic`/`bearer` ohne Zugangsdaten lehnt alles ab; Schema-Name case-insensitiv; Body ≤ 1 MB.

Medien: `/unifi-access/<i>/thumbnail/<deviceId>.jpg` (Proxy auf `/system/static`), `/unifi-access/<i>/protect-snapshot/<cameraId>/<eventTs>.jpg` (nur aus dem Cache, sonst 404 — nie ein Live-Bild), `/unifi-access/<i>/protect-video/<eventId>.mp4` (gestreamt). Medien-URLs sind bewusst ohne Authentifizierung (vis-Einbindung).

### UniFi Protect

`protectHttp.ts` meldet sich mit lokalem Account auf `controllerHost:protectPort` (443) an. Fehlerklassen: `tls`/`credentials` → einmalige Warnung, Integration aus bis zum Neustart; sonst Retry 30 s, 60 s, … bis 10 min. Ein Klartext-Passwort in `native` wird beim ersten Start verschlüsselt (`secretMigration.ts`, ein zusätzlicher Neustart). Kamera-Zuordnung über `POST /system/logs` (nicht dokumentierte Struktur `target.type === 'camera event'`, siehe Tests).

## Tests

| Kommando | Inhalt |
|---|---|
| `npm test` | `test:ts` (mocha: `src/**/*.test.ts`, `test/mock/**/*.test.js`, `test/contract/**/*.test.ts`) + `test:package` |
| `npm run test:package` | Paketdateien (`io-package.json`, `package.json`, README-Format) |
| `npm run test:admin` | vitest in `src-admin` |
| `npm run test:www` | vitest in `src-www` |
| `npm run test:integration` | `@iobroker/testing` mit echtem js-controller gegen den Mock (`test/functional/adapterTests.js`); testet `build/main.js`, deshalb baut `pretest:integration` vorher. Nutzt feste Ports 19000/19001 und ein festes Temp-Verzeichnis — nie zwei Läufe parallel |
| `npm run test:all` | alles oben zusammen |
| `npm run check` / `npm run lint` | `tsc --noEmit` / ESLint (Root); Frontends: `npm run check`/`lint` im jeweiligen Verzeichnis |

**Mock-Controller** (`test/mock/`, Doku `test/mock/README.md`): Nachbau der Developer-API (HTTPS + WebSocket, signierte Webhooks, selbstsigniertes Zertifikat zur Laufzeit), ausschließlich aus `.doc/api_reference.md` abgeleitet; Annahmen, wo die Doku schweigt, stehen in der Mock-README. Start: `npm run mock:controller -- --port <n> --token <token>`; Steuer-Routen `/__mock/…` (Daten, Static-Dateien, Optionen, Neustart, Verzögerung). Dazu `protectStub.js` (Protect) und `fakeAdapterCore.js` (Adapter ohne js-controller, inkl. `effectsAfterStop`/`logsAtStop` für Stopp-Tests).

Für manuelle Tests nur gegen den Mock arbeiten, nie gegen einen echten Controller (ein Unlock öffnet echte Türen, der Start räumt Webhook-Endpunkte um).

## CI (`.github/workflows/`)

- `test-and-release.yml`: `check-and-lint`; `adapter-tests` (Node 22/24/26 × Linux/Windows/macOS, Unit + Integration); `frontend-tests` (je `src-admin`/`src-www`: Root-`npm ci`, `npm ci`, check, lint, test, build, dann „Committed bundle is up to date“); `deploy` (Tag `v*`, npm Trusted Publishing).
- `automerge-dependabot.yml`: merged nur Dependabot-PRs, die Dependabot selbst zuletzt aktualisiert hat, und **nicht** die der Frontends.
- **Dependabot-Regel:** PRs für `/src-admin` und `/src-www` ändern meist die committeten Bundles → kein Auto-Merge. Vorgehen: PR-Branch auschecken, Root-`npm ci` und `npm ci` im Frontend, `npm run build:admin` bzw. `build:www`, Rebuild-Commit auf den PR-Branch pushen, von Hand mergen (siehe Kommentar in `.github/dependabot.yml`). TypeScript 7.x ist in Dependabot gesperrt.

## i18n

- `admin/i18n/{lang}.json` — von jsonConfig genutzt (`"i18n": true`).
- `src-admin/src/i18n/{lang}.json` — via `tasks.ts` nach `admin/custom/i18n/` kopiert.
- Alle 11 Sprachen (en, de, ru, pt, nl, fr, it, es, pl, uk, zh-cn) sind vollständig übersetzt; neue Keys in allen Sprachen anlegen (mind. `en` + `de` von Hand, sonst englischer Fallback bis zur Übersetzung). `src-admin/src/jsonConfig.test.ts` prüft, dass jeder in jsonConfig benutzte Key existiert.
- Das www-Panel hat keine Übersetzungen (nur Englisch).

## sendTo / Message-Handler

`"messagebox": true` in `io-package.json`. Custom-Components kommunizieren über `socket.sendTo('unifi-access.<instance>', '<command>', payload)` (in `src-admin` über `requestAdapter()`). Handler in `src/main.ts` (`onMessage` → `handleMessage`).

## Changelog & Releases

### Versionsnummern-Schema (Semantic Versioning)

| Typ | Kommando | Wann |
|---|---|---|
| Patch `0.0.X` | `npm run release patch` | Bugfixes, interne Bereinigungen, keine neuen Features |
| Minor `0.X.0` | `npm run release minor` | Neue, rückwärtskompatible Features |
| Major `X.0.0` | `npm run release major` | Breaking Changes: geänderte State-Pfade, entfernte Features, API-Brüche |

### Pre-Release-Checkliste (manuell, vor `npm run release`)

1. **README.md** — alle nutzersichtbaren Änderungen in `### **WORK IN PROGRESS**` eingetragen (Format: `- (ticaki) beschreibung`), Verhaltensänderungen für Bestandsinstallationen ausdrücklich genannt
2. **README_ENGLISH.md / README_GERMAN.md** — neue Einstellungen, States, sendTo-Formate in beiden Sprachen nachgetragen
3. **Build** — `npm run build:all` läuft sauber durch (0 Fehler); `admin/custom/` und `www/` committet
4. **Lint/Typen** — `npm run check` und `npm run lint` ohne Errors (Warnings sind tolerierbar)
5. **Tests** — `npm run test:all` grün (Unit, Package, Admin, www, Integration). `npm test` allein reicht nicht: einige Sicherheitsregeln (ack-Schleife, Secret nicht in der Antwort, `verifyTLS` der Token-Sonde) sichert nur der Integrationstest ab

### Changelog-Format in README.md

```markdown
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
- (ticaki) fixed: kurze, nutzersichtbare Beschreibung der Änderung

### 0.0.2 (2026-05-03)
- (ticaki) weitere Änderung
```

Regeln:
- Einträge nur nutzersichtbar — keine Implementierungsdetails, keine Dateinamen, keine Commit-Verweise. Englisch.
- Jeder Eintrag eine Zeile: `- (ticaki) ...` (Bindestrich, wie in der README).
- Verb-Konvention: `fixed:`, `new:`, `changed:` am Anfang der Beschreibung (Präfix klein, Doppelpunkt).
- Der Platzhalter-Kommentar bleibt stehen; `### **WORK IN PROGRESS**` darf außerhalb des Kommentars nur einmal vorkommen.

### news-Block in io-package.json

Der `news`-Block wird **vom Release-Script erzeugt** — vor dem Release nichts eintragen. Das Plugin `@alcalzone/release-script-plugin-iobroker` (Edit-Stage) macht beim Release:
1. Gibt es schon `news["<neue Version>"]`, bleibt er unverändert.
2. Sonst, gibt es einen Eintrag `news.NEXT`, wird er in die neue Version umbenannt.
3. Sonst nimmt es den Text unter `### **WORK IN PROGRESS**` (Autor `(ticaki)` und Aufzählungszeichen entfernt), übersetzt ihn in alle Sprachen (DeepL, wenn `DEEPL_API_KEY` gesetzt ist, sonst der ioBroker-Übersetzungsdienst) und stellt ihn als neue Version an den Anfang.
4. Es bleiben höchstens 7 Versionen (`--numNews`).

Wer den Text für `news` bewusst anders haben will als den Changelog (z. B. kürzer), legt vorher `news.NEXT` mit allen Sprachen an oder korrigiert im `manual-review`-Schritt. Aufbau eines Eintrags:

```jsonc
"news": {
  "0.0.3": {
    "en": "fixed: brief English description",
    "de": "behoben: kurze deutsche Beschreibung",
    "ru": "...", "pt": "...", "nl": "...", "fr": "...", "it": "...", "es": "...", "pl": "...", "uk": "...", "zh-cn": "..."
  }
}
```

Mehrere Einträge für eine Version werden zeilenweise verbunden: `"fixed: X\nnew: Y"`. Übersetzungen nicht deutlich kürzer als `en` (Repo-Checker W1145).

### Release-Kommando

```bash
npm run release patch   # oder minor / major
```

Das `@alcalzone/release-script` führt automatisch aus:
1. Bumpt Version in `package.json` **und** `io-package.json` synchron und erzeugt `news` (siehe oben).
2. Ersetzt `### **WORK IN PROGRESS**` → `### X.Y.Z (YYYY-MM-DD)` in `README.md` (mit `CHANGELOG_OLD.md` würden ältere Einträge dorthin verschoben; die Datei gibt es derzeit nicht).
3. Führt `npm run build:all` aus (via `.releaseconfig.json` `before_commit`-Hook).
4. Öffnet einen manuellen Review-Schritt (`manual-review`-Plugin) — letzter Ausstiegs-Checkpoint.
5. Erstellt Git-Commit + Tag `vX.Y.Z`.
6. Pusht nach GitHub (CI triggert daraufhin den `deploy`-Job, der NPM-Publish durchführt).

> **Wichtig**: `npm run release` **nie** auf einem Dirty-Working-Tree aufrufen. Vor dem Release alle Änderungen commiten.

## Bewusste Entscheidungen / was nicht enthalten ist

- **WebRTC-Live-Video / Doorbell Accept/Reject / Trigger Doorbell** — kein dokumentierter Endpoint, würde zweiten WebRTC-Stack im Adapter erfordern. Doorbell-Anrufe werden nur passiv angezeigt.
- **On-Demand-Snapshot per HTTP** — die Developer-API bietet keinen `/snapshot`-Endpoint; Bilder gibt es nur als `door_thumbnail`-Pfad in Events (passiv) bzw. über die optionale Protect-Integration zum Event-Zeitpunkt.
- **Two-Way-Audio / Microphone / Speaker** — keinerlei Audio-API in der Doku.
- **Cloud-Login (UI Identity / OAuth)** — nur API-Token lokal; Protect nur mit lokalem Account.
- **User/Visitor-Management (schreibend), Access-Method-Settings** — nicht enthalten; Benutzer werden nur für die Akteur-Auswahl gelesen.
- **Rate-Limit-/Quota-Tracking**
- Medien-/Thumbnail-URLs ohne Authentifizierung (vis-Einbindung); Emergency-States ohne zusätzliches Opt-in schreibbar.
- `protectVerifyTLS` Default `false`; ein gespeichertes `true` wird nicht zurückgesetzt, sondern führt zu einer klaren Warnung.
- Token-Felder sind Passwortfelder mit Sichtbar-Schalter.
- Verschwundene Türen/Geräte werden nicht automatisch gelöscht.

## Externe Referenzen

| Ressource | Pfad |
|---|---|
| UniFi Access API-Dokumentation (PDF, im Repo) | `.doc/api_reference.pdf` |
| **Durchsuchbare Markdown-Version (für `grep`)** | **`.doc/api_reference.md`** |
| Online-Quelle (zur Verifikation) | https://assets.identity.ui.com/unifi-access/api_reference.pdf |
| Mock-Controller | `test/mock/README.md` |

## Wichtige Dateien

| Datei | Zweck |
|---|---|
| `admin/jsonConfig.json` | Komplette Admin-UI-Definition |
| `src-admin/src/Components.tsx` | Re-Export aller customComponents |
| `src-admin/src/AuthSetup.tsx` | Verbindungstest (customComponent) |
| `src-admin/src/DeviceManagement.tsx` | Geräteverwaltungs-Panel (customComponent) |
| `src-admin/src/ActorSelect.tsx` | Auswahl des Unlock-Akteurs (customComponent) |
| `src-admin/src/GenericWebhookUrl.tsx` | URL-Anzeige des Alarm-Manager-Webhooks (customComponent) |
| `src-admin/vite.config.ts` | Module-Federation-Konfiguration (`ConfigCustomUnifiAccessSet`) |
| `tasks.ts` | Kopiert Admin-Build-Output nach `admin/custom/` |
| `src/main.ts` | Adapter-Einstiegspunkt, Message-Handler, Steuer-States, Webhook-/Protect-Logik |
| `src/lib/unifiHttp.ts` | HTTPS-Client gegen UniFi Controller |
| `src/lib/unifiWebSocket.ts` | WebSocket-Listener für Echtzeit-Events |
| `src/lib/deviceModels.ts` | Feature-Gating nach Geräte-Modell |
| `src/lib/stopSignal.ts` | Stopp-Signal (keine Wirkung nach `onUnload`) |
| `src/webhooks/server.ts` | HTTP-Receiver für Webhook-Events (HMAC-validiert) |
| `src/webhooks/registration.ts` | Self-Registration des Webhook-Endpunkts |
| `src/webhooks/genericWebhookServer.ts` | Alarm-Manager-Webhook |
| `src/webserver/sharedHttpServer.ts` | Gemeinsamer HTTP(S)-Server |
| `src/webserver/snapshotEndpoint.ts` | Thumbnail-Proxy (event-driven) |
| `src/webserver/protectSnapshotEndpoint.ts` | Protect-Snapshots und -Clips |
| `test/contract/frontendContract.test.ts` | Vertragstest Adapter ↔ Frontends |
| `test/mock/` | Mock-Controller, Protect-Stub, Fake-Adapter-Core |
| `io-package.json` | Adapter-Metadaten, `adminUI.config: "json"`, `localLinks` |
| `.github/dependabot.yml` | Dependabot-Zeitplan, Sperren, Frontend-Hinweis |
| `.doc/api_reference.pdf` | Quelle der Wahrheit für API-Endpoints und Events |
| `.doc/api_reference.md` | Durchsuchbare Markdown-Version der API-Doku (via `grep`) |
