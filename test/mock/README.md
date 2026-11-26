# Mock-UniFi-Access-Controller

Nachbau der **UniFi Access Developer API** (HTTPS + WebSocket) für Tests und für die lokale
Entwicklung ohne echten Controller. Grundlage ist ausschließlich `.doc/api_reference.md`.

- reines CommonJS, keine zusätzlichen Abhängigkeiten (nur `ws`, das der Adapter ohnehin mitbringt)
- selbstsigniertes Zertifikat wird **zur Laufzeit** erzeugt (ECDSA P-256), nichts Geheimes liegt im Repo
- jeder eingehende API-Request wird aufgezeichnet und kann in Tests geprüft werden
- WebSocket-Benachrichtigungen und signierte Webhooks lassen sich programmatisch oder per HTTP auslösen

> Der Mock spricht niemals mit einem echten Controller und öffnet nur die Ports, die man ihm gibt.

## Schnellstart (CLI)

```bash
npm run mock:controller -- --port 12445 --token test-token
# oder direkt
node test/mock/cli.js --port 12445 --token test-token
```

| Option | Default | Bedeutung |
|---|---|---|
| `--port <n>` | `12445` | Port; `0` = das Betriebssystem vergibt einen freien Port (wird ausgegeben) |
| `--host <addr>` | `127.0.0.1` | Bind-Adresse; `0.0.0.0` für alle Interfaces |
| `--token <token>` | `test-token` | akzeptierter API-Token (`Authorization: Bearer <token>`) |
| `--auto-events` | aus | nach jedem `PUT /doors/:id/unlock` automatisch einen `access.door.unlock`-Webhook zustellen |
| `--any-static` | aus | für jeden Pfad unter `/system/static/` ein Mini-JPEG liefern |
| `--duplicate-status <n>` | `200` | HTTP-Status für `CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED` |
| `--cert-out <datei>` | – | erzeugtes Zertifikat (PEM) schreiben, z. B. als „CA-Zertifikat“ für `verifyTLS` |
| `--san <name>` | – | zusätzlicher subjectAltName (DNS-Name oder IP), mehrfach möglich |
| `--quiet` | aus | Requests nicht protokollieren |

Adapter-Konfiguration dazu: `controllerHost = 127.0.0.1`, `controllerPort = 12445`,
`apiToken = test-token`, `verifyTLS = false` (oder `verifyTLS = true` + Inhalt von `--cert-out` als CA).
Damit der Mock Webhooks an den Adapter zustellen kann, muss `listenIp` des Adapters eine Adresse sein,
die vom Mock aus erreichbar ist (lokal: `127.0.0.1`).

## Nachgebildete API

Alle Routen unter `https://<host>:<port>/api/v1/developer`, Antwort-Hülle `{"code":"SUCCESS","msg":"success","data":…}`.

| Methode | Pfad | Doku | Hinweis |
|---|---|---|---|
| GET | `/devices` | 8.1 | `data` ist `Device[][]` (Gruppen); `?refresh=true` wird akzeptiert |
| GET | `/doors`, `/doors/:id` | 7.8 / 7.7 | |
| PUT | `/doors/:id/unlock` | 7.9 | Body `actor_id` + `actor_name` nur gemeinsam, optional `extra` |
| PUT / GET | `/doors/:id/lock_rule` | 7.10 / 7.11 | `type` ∈ `keep_lock, keep_unlock, custom, reset, lock_early, lock_now`; `custom` verlangt ganzzahliges `interval` (Minuten). PUT setzt `door_lock_relay_status` der Tür (`custom`/`keep_unlock` → `unlock`, sonst `lock`); eine `custom`-Regel läuft im Mock **nicht** von selbst ab (im Test `mock.findDoor(id).door_lock_relay_status = 'lock'` setzen). GET liefert `mock.lockRules.get(id)`, ohne Regel `{type:"schedule", ended_time:0}` (Annahme – die Doku beschreibt den Fall nicht) |
| GET / PUT | `/doors/settings/emergency` | 7.13 / 7.12 | |
| GET | `/users` | 3.5 | mit `page_num` / `page_size` und `pagination`-Block |
| POST | `/system/logs` | 9.2 | liefert `mock.systemLogHits`; Topics laut Doku **plus** `all` (siehe Annahmen) |
| GET | `/system/static/<pfad>` | 9.5 | Inhalte per `mock.addStaticResource(pfad, buffer)` |
| GET / POST | `/webhooks/endpoints` | 11.3 / 11.4 | POST liefert `id` und `secret`; gleiche URL → `CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED` |
| PUT / DELETE | `/webhooks/endpoints/:id` | 11.5 / 11.6 | PUT ersetzt `name`, `endpoint`, `events` (und `headers`); `id` und `secret` bleiben wie im Doku-Beispiel unverändert |
| WebSocket | `/devices/notifications` | 11.1 | Bearer-Token im Upgrade-Request, sonst `401` |

Fehler: fehlender/kaputter `Authorization`-Header → `401 CODE_AUTH_FAILED`, falscher Token →
`401 CODE_ACCESS_TOKEN_INVALID`, ungültige Parameter → `400 CODE_PARAMS_INVALID`, unbekannte ID →
`400 CODE_NOT_EXISTS`, unbekannte Route → `404 CODE_RESOURCE_NOT_FOUND`.

## Steuer-Routen `/__mock/...`

Ohne Token erreichbar, werden **nicht** aufgezeichnet. Wegen des selbstsignierten Zertifikats `curl -k` verwenden.

```bash
M=https://127.0.0.1:12445/__mock

curl -k $M/help                      # Liste aller Steuer-Routen
curl -k $M/state                     # Geräte, Türen, registrierte Webhook-Endpoints (inkl. Secret), Zähler
curl -k $M/requests                  # alle aufgezeichneten API-Requests
curl -k -X DELETE $M/requests        # Aufzeichnung leeren
curl -k -X POST $M/reset             # Fixtures wiederherstellen, Endpoints/Requests/Fehler vergessen

# WebSocket-Events (11.1)
curl -k -X POST $M/ws/event -d '{"type":"remote_view"}'                         # es klingelt
curl -k -X POST $M/ws/event -d '{"type":"remote_view_change","reasonCode":108}' # 105/106/107/108/400
curl -k -X POST $M/ws/event -d '{"type":"remote_unlock","doorId":"<door-id>"}'  # Admin öffnet remote
curl -k -X POST $M/ws/event -d '{"event":"access.remote_view","event_object_id":"x","data":{}}' # eigene Hülle
curl -k -X POST $M/ws/raw   -d '{"text":"Hello"}'                               # beliebiger Text-Frame
curl -k -X POST $M/ws/drop                                                      # alle WS-Verbindungen kappen

# Signierte Webhooks (11.7) an alle registrierten Endpoints, die das Event abonniert haben
curl -k -X POST $M/webhook -d '{"type":"door_unlock","doorId":"<door-id>","readerId":"0418d6a2bb7a"}'
curl -k -X POST $M/webhook -d '{"type":"dps_status","status":"open"}'
curl -k -X POST $M/webhook -d '{"type":"doorbell_incoming"}'
curl -k -X POST $M/webhook -d '{"type":"doorbell_completed","reasonCode":107}'
curl -k -X POST $M/webhook -d '{"type":"doorbell_incoming_ren"}'
curl -k -X POST $M/webhook -d '{"type":"emergency_status","mode":"lockdown","value":true}'
curl -k -X POST $M/webhook -d '{"event":"access.temporary_unlock.start"}'       # Events ohne Doku-Beispiel
curl -k -X POST $M/webhook -d '{"type":"door_unlock","signature":"invalid"}'    # absichtlich kaputt

# Fehler injizieren: der nächste passende API-Request schlägt fehl
curl -k -X POST $M/fail -d '{"method":"PUT","path":"/doors/<door-id>/unlock","status":500}'
curl -k -X POST $M/fail -d '{"path":"/devices","hangUp":true,"times":3}'        # Verbindung abreißen lassen
curl -k -X POST $M/fail -d '{"path":"/doors","delayMs":20000}'                  # Controller „hängt“ (Antwort kommt spät)

# Daten zur Laufzeit austauschen / Controller-Neustart (Zustand bleibt erhalten)
curl -k -X POST $M/data -d '{"devices":[],"users":[{"id":"u1","first_name":"A","last_name":"B"}]}'
curl -k -X POST $M/data -d '{"door":{"id":"<door-id>","door_lock_relay_status":"lock"}}'   # einzelne Tür ändern
curl -k -X POST $M/static -d '{"path":"/preview/reader_x.jpg","base64":"<jpeg>"}'
curl -k -X POST $M/options -d '{"wsAccepting":false}'                           # WebSocket-Upgrade mit 503 ablehnen
curl -k -X POST $M/options -d '{"autoPong":false}'                              # Pings offener Verbindungen nicht mehr beantworten (Heartbeat)
curl -k -X POST $M/restart -d '{"downMs":5000}'                                 # 5 s weg, dann wieder auf demselben Port
```

`signature` kennt `valid` (Default), `invalid` (falsches Secret), `tampered` (Body nach dem Signieren
verändert), `expired` / `future` (korrekt signiert, aber ±1 h), `missing` (kein Header) und `malformed`.
`"force": true` stellt auch an Endpoints zu, die das Event nicht abonniert haben.

## In Tests einbetten

```js
const { startMockController, sendWebhook, fixtures } = require('../test/mock'); // TS: import … from '../../test/mock'

const mock = await startMockController({ token: 't' });   // Port 0 → mock.port, mock.url, mock.wsUrl, mock.cert
// … Adapter/Modul gegen 127.0.0.1:mock.port laufen lassen …

mock.requests;                                             // alle Requests: method, url, path, query, headers, body, status
mock.findRequests({ method: 'PUT', path: /\/unlock$/ });
await mock.waitForRequest({ method: 'POST', path: '/webhooks/endpoints' });
mock.failNext({ path: '/devices', status: 500 });          // oder { hangUp: true }, { status: 200, body: {...} }

mock.emitRemoteView();                                     // WebSocket: access.remote_view
mock.emitRemoteViewChange(108);                            // access.remote_view.change
mock.emitRemoteUnlock(fixtures.IDS.DOOR_3855);             // access.data.device.remote_unlock
mock.dropWsConnections();                                  // Verbindungsabbruch (graceful: true für Close-Frame)
mock.wsAccepting = false;                                  // Upgrade mit 503 ablehnen (Reconnect-Tests)
mock.autoPong = false;                                     // Pings nicht beantworten (Heartbeat-Tests), auch zur Laufzeit
await mock.restart();                                      // Controller-Neustart auf demselben Port

// signierter Webhook an alle registrierten Endpoints (Secret aus der Registrierung)
await mock.deliverWebhook(fixtures.webhookEvents.doorUnlock({ door: mock.doors[0], device: mock.flatDevices[0] }));
await mock.deliverWebhook(event, { signature: 'expired' });
// oder ganz ohne Mock direkt an einen Receiver:
await sendWebhook({ url, secret, body: event, signature: 'tampered' });

await mock.stop();
```

Weitere Helfer aus `test/mock`: `getFreePort()`, `isPortFree()`, `httpRequest()` (sendet `rawPath`
unverändert – für Pfad-Traversal-Tests), `createSelfSignedCert()`, `computeSignature()` /
`signatureHeader()`, `createTestLogger()`, `waitFor()`, `delay()`, `rejection()` sowie
`FakeAdapter` / `createAdapterWithFakeCore()` (In-Prozess-Ersatz für `@iobroker/adapter-core`,
genutzt von `src/main.test.ts` und `src/lib/library.test.ts`). Typen: `test/mock/index.d.ts`.

### FakeAdapter (In-Prozess-Adapter-Core)

Bildet nur die Adapter-API nach, die der Adapter tatsächlich nutzt: Objekte/States in Maps
(`objects`, `states`, `stateWrites`), `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`delay`
über die (fake-baren) globalen Timer (`timers`, `intervals` zeigen, was noch läuft; `fireUnload()` räumt
sie wie js-controller ab), `host` (`test-host`), `encrypt`/`decrypt` (austauschbar, um AES- bzw.
Alt-Verschlüsselung nachzustellen), `getCertificatesAsync()` aus dem Zertifikatsspeicher `certificates`
(Name → PEM; unbekannter Name → Fehler), `getForeignObjectAsync`, `delObjectAsync`, `delStateAsync`.
`info.connection` ist ein `instanceObject` aus `io-package.json` und existiert im Fake nicht als Objekt.

### ProtectStub (UniFi-OS-/Protect-Stand-in)

`new ProtectStub({ username, password })` → `start()` / `stop()`, `port`, `cert` (als `caCert`
nutzbar), `logins` (jeder Login-Versuch mit Zugangsdaten und Status), `requests`, `failLogins(status, n)`,
`snapshot`, `clip`, `events` (Event-ID → Metadaten mit `clipUrl`). Er bildet **keine** dokumentierte API
nach, sondern genau das, was `src/lib/protectHttp.ts` von der privaten UniFi-OS-/Protect-API verwendet
(Cookie-Login mit CSRF-Token, Snapshot, Event-Metadaten, Clip). Tests damit belegen die Verdrahtung im
Adapter, nicht das Verhalten einer echten Konsole. Der Adapter erreicht den Stub über den versteckten
native-Key `protectPort`.

## Annahmen, wo die Doku schweigt

Die Doku nennt Fehler-Codes und HTTP-Statuscodes getrennt, ordnet sie einander aber nicht zu.
Der Mock legt deshalb fest (und ist an den genannten Stellen umstellbar):

| Thema | Verhalten des Mocks |
|---|---|
| Status zu Fehler-Codes | `CODE_PARAMS_INVALID`/`CODE_NOT_EXISTS` → 400, Auth-Fehler → 401, `CODE_RESOURCE_NOT_FOUND` → 404 |
| `CODE_DEVICE_WEBHOOK_ENDPOINT_DUPLICATED` | HTTP **200** mit Fehler-Code; umstellbar über `duplicateEndpointHttpStatus` / `--duplicate-status` (der Adapter verarbeitet beide Varianten) |
| Fehler-Code bei HTTP 200 | per `failNext({ status: 200, code: 'CODE_…' })` – der Adapter wertet `code` unabhängig vom HTTP-Status aus |
| System-Log-Topic `all` | wird akzeptiert, obwohl es nicht im dokumentierten Enum steht – der Adapter fragt es nur noch als Rückfall nach `door_openings` ab |
| Lock-Rule ohne aktive Regel (7.11) | `GET …/lock_rule` liefert `{type:"schedule", ended_time:0}` |
| Relay-Status nach `PUT …/unlock` | bleibt unverändert (`lock`); nach `PUT …/lock_rule` siehe Tabelle oben |
| Pagination von `GET /users` | `page_num`/`page_size` werden ausgewertet, Antwort enthält `pagination.total`; ohne Parameter kommt alles auf einer Seite |
| `online` in Webhook-Geräteblöcken | Default `true` (die Doku-Beispiele zeigen durchgehend `false`); pro Event überschreibbar |
| Webhook-Events ohne Payload-Beispiel | `unlock_schedule.*`, `temporary_unlock.*`, `visitor.status.changed` nutzen das Layout der dokumentierten Beispiele |
| Nicht-JSON-Frames auf dem WebSocket | sendet der Mock nur auf Anforderung (`sendRaw` / `/__mock/ws/raw`) |
| Protect-Verknüpfung im System-Log | **nicht dokumentiert:** Treffer mit Ziel `{type: "camera event", id: "protect_<cameraId>_<eventId>"}` (in 9.1.1 stehen nur `UAH`, `device_config`, `door`, `floor`, `building`). Der Adapter ordnet ein solches Ziel nur zu, wenn derselbe Treffer auch `{type: "door", id: <Tür des Ereignisses>}` enthält. Die Tests (`systemLogHits` in `src/main.test.ts`) belegen die Verdrahtung, nicht das Verhalten einer echten Konsole |
| Gerätetyp der UA Ultra | **nicht dokumentiert:** die Fixture nutzt `type: "UA-ULTRA"` (dokumentiert sind nur `UAH`, `UDA-LITE`, `UA-G2-PRO`, `UGT`); die Erkennung in `deviceModels.ts` beruht auf `includes('ultra')` |

Nicht nachgebildet: alle Endpoints, die der Adapter nicht nutzt (Benutzer-/Besucher-Verwaltung,
Zutrittsrichtlinien, NFC/PIN, Identity, Zertifikats-Upload), Rate-Limiting (429) und Berechtigungs-Scopes
des Tokens (403 lässt sich über `failNext({ code: 'CODE_UNAUTHORIZED' })` simulieren).
