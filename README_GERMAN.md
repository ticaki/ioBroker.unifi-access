# ioBroker.unifi-access

## UniFi-Access-Adapter für ioBroker

Dieser Adapter verbindet ioBroker mit deinem **Ubiquiti UniFi Access**-Controller und nutzt die offizielle [UniFi Access Developer API](https://assets.identity.ui.com/unifi-access/api_reference.pdf) (auch im Repo unter `.doc/api_reference.pdf`). Schwerpunkt ist das Standalone-Gerät **UA Ultra**; die gleichen Code-Pfade decken weitere UniFi-Access-Modelle ab. Zwei optionale Integrationen erweitern den Funktionsumfang: ein UniFi-Protect-Controller liefert pro Access-Event Kamera-Snapshots und Clip-Links, und ein zweiter Webhook-Endpunkt nimmt Events externer Alarmsysteme entgegen.

## Unterstützte Geräte

| Modell | Türöffner | Live-Events (WebSocket) | Event-Thumbnail | Türklingel (passiv) |
|---|:---:|:---:|:---:|:---:|
| **UA Ultra** | ✅ | ✅ | ✅ | ✅ |
| UA G3 Pro Doorbell | ✅ | ✅ | ✅ | ✅ |
| UA G2 Pro Reader | ✅ | ✅ | ✅ | – |
| UA Hub | – | ✅ | – | – |
| Andere Modelle | basic | basic | – | – |

Falls dein Gerät zu den Basic-Modellen gehört und eine Funktion fehlt, bitte ein Issue eröffnen.

## Voraussetzung — API-Token in UniFi Access erzeugen

1. Öffne die UniFi-Access-Oberfläche deines Controllers (üblicherweise `https://<controller>:12445/`).
2. Gehe zu **Einstellungen → Sicherheit → Erweitert → API-Token**.
3. Klicke auf **Token erstellen**, vergib einen sprechenden Namen (z. B. `ioBroker`) und kopiere den Wert.
4. Der Token wird **nur einmal** angezeigt — sicher abspeichern.

Der Adapter nutzt diesen Token sowohl für HTTPS-API-Aufrufe (`Authorization: Bearer <token>`) als auch für den WebSocket-Event-Stream.

## Konfiguration

Adapter-Instanz-Einstellungen im ioBroker-Admin öffnen. Die Konfiguration ist in sechs Tabs aufgeteilt:

| Tab | Zweck |
|---|---|
| **Verbindung** | Controller-Host/IP, Port (Default `12445`), API-Token, optionale TLS-Verifikation + CA, WebSocket-Reconnect-Delay. Die eingebettete `AuthSetup`-Custom-Component prüft den Controller laufend (Status-Badge + `Verbindung testen`-Button), sodass du den Token vor dem Speichern verifizieren kannst. |
| **Geräte & Türen** | Automatisch erkannte UniFi-Access-Geräte mit Capability-Chips, sowie die Standard-Öffnungsdauer. |
| **HTTP-Server** | Gemeinsamer HTTP(S)-Listener für UniFi-Webhook-Empfänger, Thumbnail-Proxy und Generic-Webhook (Default-Port `8095`, Listen-IP, optionales TLS, plus separate Schalter pro Handler). |
| **Alarm Manager** | Zweiter Webhook-Endpunkt für externe Systeme (Alarmanlagen, Hubs). Konfigurierbarer Pfad und `none`/`basic`/`bearer`-Authentifizierung; die `GenericWebhookUrl`-Component zeigt fertige URLs mit Copy-Button. |
| **UniFi Protect** | Optionale Integration: Username/Passwort/TLS-Verifikation für einen UniFi-Protect-Controller. |
| **Event-Weiterleitung** | UniFi-Event-Typen auf beliebige ioBroker-Ziel-States mappen (optional). |

> **TLS-Hinweis:** Der `TLS aktivieren`-Schalter im **HTTP-Server**-Tab lädt aktuell **noch keine** Zertifikate aus dem ioBroker-Cert-Store. Bis das nachgerüstet ist, den Toggle besser ausgeschaltet lassen und einen Reverse-Proxy für HTTPS davorstellen.

## Türsteuerung

Für jede Tür aus dem Bootstrap legt der Adapter unter `unifi-access.<i>.doors.<doorId>` einen Channel an:

| State | Typ | Richtung | Hinweis |
|---|---|---|---|
| `name` | string | read | Sprechender Türname |
| `fullName` | string | read | Vollständiger Pfad (Etage/Controller) |
| `locked` | boolean | read | `true` = verriegelt, `false` = entriegelt, `null` = unbekannt |
| `position` | string | read | `open` / `close` / `unknown` (sensorabhängig) |
| `isBindHub` | boolean | read | Tür ist an einen Hub gebunden (Voraussetzung für Remote-Unlock) |
| `unlock` | boolean | write | Setzen auf `true` öffnet die Tür |

`defaultUnlockDuration = 0` löst einen kurzen Entriegelungspuls über `PUT /doors/:id/unlock` aus. Werte > 0 werden auf volle Minuten aufgerundet und über `PUT /doors/:id/lock_rule {type:"custom", interval}` angewendet.

### Notfall-States

Zusätzlich zur Einzeltür-Steuerung stellt der Adapter die controllerweiten Notfall-Schalter unter `doors.emergency.*` bereit (UniFi Access ≥ 1.24.6, geschrieben über `PUT /doors/settings/emergency`):

| State | Typ | Richtung | Hinweis |
|---|---|---|---|
| `doors.emergency.lockdown` | boolean | read/write | Alle Türen verriegeln (Lockdown) |
| `doors.emergency.evacuation` | boolean | read/write | Alle Türen entriegeln (Evakuierung) |

## Türklingel-Anrufe (UA Ultra / UA G3 Pro)

Beim Klingeln zeigt der Adapter den aktiven Anruf passiv an:

| State | Typ | Hinweis |
|---|---|---|
| `doorbell.activeCallId` | string | Object-ID des Klingel-Events, `null` wenn keiner aktiv |
| `doorbell.activeFromDevice` | string | Auslösende Tür / Gerät |
| `doorbell.activeStartedAt` | number | Epoch-Millisekunden |

Es gibt **kein Annehmen/Ablehnen** im Adapter — die Developer-API hat dafür keinen Endpunkt. Zum tatsächlichen Beantworten die offizielle UniFi-Access-App nutzen.

## Event-Thumbnails (UA Ultra / UA G3 Pro / UA G2 Pro)

Die Developer-API bietet keinen On-Demand-Snapshot, jedes Event-Payload (WebSocket oder Webhook) trägt aber einen `door_thumbnail`-Pfad. Der Adapter merkt sich pro Gerät den letzten Pfad:

| State | Typ | Hinweis |
|---|---|---|
| `devices.<id>.lastThumbnailPath` | string | vom Controller gelieferter (relativer) Pfad |
| `devices.<id>.lastThumbnailAt` | number | Epoch-Millisekunden des Events |
| `devices.<id>.lastThumbnailUrl` | string | URL des adapterinternen Thumbnail-Proxys (nur gesetzt, wenn **Thumbnail-Server aktivieren** an ist) |

Weitere Geräte-States, die beim Bootstrap und durch Live-Events befüllt werden: `name`, `alias`, `type`, `model`, `firmware`, `online`, `lastSeenAt`.

Bei aktivem Thumbnail-Server stellt der Adapter das aktuellste Bild als JPEG bereit unter `<scheme>://<adapter-host>:<listenPort>/unifi-access/<i>/thumbnail/<deviceId>.jpg`. Intern holt er das Bild über `/api/v1/developer/system/static/<path>` (Bearer-Auth bleibt im Adapter), sodass der Browser keinen Token braucht.

## Webhook-Receiver

Über den WebSocket kommen nur Klingelvorgänge und Admin-Remote-Unlock-Events. Für `access.door.unlock`, `access.device.dps_status`, `access.device.emergency_status`, `access.unlock_schedule.*`, `access.temporary_unlock.*`, `access.visitor.status.changed` und die Doorbell-Webhook-Varianten wird der Webhook-Empfänger gebraucht:

1. **HTTP-Server → Webhook-Empfänger aktivieren** anhaken.
2. **Listen-Port** (Default `8095`) und **Listen-IP** (Default `0.0.0.0`) prüfen.
3. Speichern. Der Adapter ermittelt die öffentliche URL automatisch aus den HTTP-Server-Einstellungen (`<scheme>://<listenIp-oder-erste-nicht-interne-IPv4>:<listenPort>/unifi-access-webhook`), ruft `POST /api/v1/developer/webhooks/endpoints` auf, speichert das zurückgegebene Secret und prüft danach jede eingehende Anfrage per HMAC-SHA256 über `<unix>.<rawBody>`.
4. Wenn der Controller die ermittelte URL nicht erreichen kann (NAT, Multi-Homed-Host, Reverse-Proxy), unter **Listen-IP** explizit die für den Controller erreichbare Adresse eintragen.

Der Webhook-Pfad ist fest auf `/unifi-access-webhook`. Registrierte Events: `access.doorbell.incoming`, `access.doorbell.completed`, `access.doorbell.incoming.REN`, `access.device.dps_status`, `access.door.unlock`, `access.device.emergency_status`, `access.unlock_schedule.activate`, `access.unlock_schedule.deactivate`, `access.temporary_unlock.start`, `access.temporary_unlock.end`, `access.visitor.status.changed`.

Falls jemals ein frisches Secret nötig ist (verlorenes Backup, geleakter Wert), per `reregisterWebhook`-sendTo aus der Admin-UI eine Neuregistrierung anstoßen.

## Alarm Manager (Generic Webhook)

Der **Alarm Manager**-Tab öffnet einen zweiten HTTP-Endpunkt am gemeinsamen Listener — gedacht für externe Alarmanlagen, Smart-Home-Hubs oder eigene Skripte. Er nimmt beliebige JSON-POSTs entgegen und schreibt das geparste Payload in einen eigenen State-Zweig.

Konfiguration:

- `enableGenericWebhook` — Master-Schalter.
- `genericWebhookPath` — URL-Pfad (Default `/webhook`).
- `genericWebhookAuth` — `none`, `basic` oder `bearer`. Basic nutzt `genericWebhookUsername`/`genericWebhookPassword`; Bearer nutzt `genericWebhookToken`.

Die eingebettete `GenericWebhookUrl`-Component listet pro Netzwerk-Interface eine fertige URL zum Kopieren.

States, die pro akzeptiertem POST gesetzt werden:

| State | Typ | Hinweis |
|---|---|---|
| `notifications.lastRaw` | string | Roh-JSON-Body |
| `notifications.lastAlarmId` | string | Alarm-Identifier aus dem Payload |
| `notifications.lastEventType` | string | Event-Typ wie vom Sender geliefert |
| `notifications.lastLocationId` | string | Location-ID (optional) |
| `notifications.lastLocationName` | string | Location-Name (optional) |
| `notifications.lastUserId` | string | User-ID (optional) |
| `notifications.lastUserName` | string | User-Name (optional) |
| `notifications.lastDirection` | string | Richtung, z. B. enter/exit |
| `notifications.lastUnlockMethod` | string | Entriegelungsmethode, z. B. card/pin |
| `notifications.lastTimestamp` | number | Epoch ms |

## UniFi-Protect-Integration (optional)

Wenn ein UniFi-Protect-Controller dieselben Türen filmt, kann der Adapter zu jedem relevanten Access-Event ein Snapshot-Bild und einen Clip-Link anhängen:

- `enableProtect` — Master-Schalter.
- `protectUsername` / `protectPassword` — lokaler Protect-Account (Cloud- bzw. UI-Accounts werden **nicht** unterstützt).
- `protectVerifyTLS` — TLS-Zertifikat des Protect-Controllers prüfen.

State:

| State | Typ | Hinweis |
|---|---|---|
| `info.protectConnected` | boolean | `true`, sobald der Protect-Login erfolgreich war |

Im verbundenen Zustand cached der Adapter Snapshots im Speicher (FIFO, max 50 Einträge) und referenziert sie aus den Einträgen in `events.last`. Die www-Statusseite zeigt den Snapshot direkt im Event-Log und bietet den Clip-Link über ein Modal an.

## Events & sendTo()-API

Die letzten 50 Events liegen in `events.last` (JSON-Array). Jeder Eintrag hat `ts`, `source` (`'ws'` oder `'webhook'`), `type`, optional `deviceId`, `deviceName`, `doorId`, `doorName`, `userName`, `thumbnailPath`, `protectSnapshotUrl`, `protectVideoUrl`, `raw`.

Akzeptierte `sendTo`-Kommandos:

| Kommando | Payload | Antwort |
|---|---|---|
| `getConnectionStatus` | `{}` | `{connected, hasToken, lastError, controllerName, webhookRegistered}` |
| `verifyToken` | `{host, port, token, verifyTLS?}` | `{ok, error?, controllerName?}` |
| `listDevices` | `{}` | `{devices: [...]}` |
| `reregisterWebhook` | `{}` | `{ok, id?}` / `{ok:false, error}` |
| `getNetworkInterfaces` | `{}` | `{interfaces: [{name, addresses[]}]}` (vom Alarm-Manager-Tab für die URL-Anzeige genutzt) |

Weitere lesbare Adapter-States unter `info.*`: `info.connection` (Controller online), `info.webhookEndpointId`, `info.webhookSecret`, `info.webhookRegistered`, `info.protectConnected`.

## Web-Oberfläche (Status & Steuerung)

Erreichbar über den ioBroker-Web-Adapter unter `/unifi-access/` (automatisch aus der Admin-Instanzliste verlinkt).

Funktionen in v1:

- Controller-Status-Badge (live)
- Tür-Liste mit Unlock-Buttons
- Karte mit dem letzten Event-Thumbnail (UA Ultra / UA G3 Pro / UA G2 Pro)
- Karte für aktive Türklingel (passiv — verweist auf die offizielle App zum Annehmen)
- Aktuelles Event-Log (`events.last`) mit optionalem UniFi-Protect-Snapshot + Clip-Modal
- Settings-Drawer für lokale Layout-Anpassungen (Card-Sichtbarkeit, Thumbnail-/Snapshot-Größe — gespeichert im Browser-`localStorage`, nicht in ioBroker)

WebRTC-Live-Video, Doorbell Annehmen/Ablehnen und On-Demand-Kamerabilder sind **bewusst nicht** enthalten — die UniFi-Access-Developer-API bietet dafür keine dokumentierten Endpunkte.

## Troubleshooting

- **`unauthorized` nach Token-Eingabe** — den ganzen Wert kopiert? Tokens lassen sich in der UI nicht erneut anzeigen — im Zweifel neu erzeugen und einfügen.
- **`network`-Fehler / `404` beim Bootstrap** — Host/Port/Firewall prüfen. UniFi Access lauscht auf UA Ultra und UniFi-OS-Konsolen standardmäßig auf Port `12445`. Der Controller antwortet auf `GET /api/v1/developer/devices`; alles andere ist kein UniFi-Access-Endpunkt.
- **TLS-Validierungsfehler** — der Controller nutzt ein selbstsigniertes Zertifikat. Der Adapter deaktiviert die TLS-Verifikation per Default. **TLS-Zertifikat prüfen** nur aktivieren, wenn das Controller-CA in **CA-Zertifikat** eingetragen ist.
- **WebSocket reconnectet ständig** — der Controller bricht ggf. inaktive Verbindungen ab. **WebSocket-Reconnect-Delay** erhöhen, um den Back-off zu begrenzen.
- **"Webhook endpoint created but response did not include id/secret"** — der UniFi-Access-Controller gibt keinen gültigen Endpunkt zurück. Häufigste Ursache: die Firmware-Version ist älter als **2.2.10** (Webhook-API-Mindestvoraussetzung). Firmware-Version im UniFi-Access-UI prüfen und ggf. updaten.
- **Webhooks kommen nicht an** — vom Controller aus prüfen, ob die öffentliche URL erreichbar ist (`curl -X POST <public-url>`), und sicherstellen, dass ein vorgelagerter Reverse-Proxy sowohl den Body als auch den `Signature`-Header unverändert weiterreicht. Loggt der Controller "endpoint unreachable", **Listen-IP** explizit eintragen statt sich auf die automatisch erkannte IPv4 zu verlassen.
- **UniFi-Protect-Login fehlgeschlagen** — nur lokale Protect-Accounts funktionieren, keine Cloud-/UI-Accounts. Credentials prüfen und sicherstellen, dass der Protect-Controller vom ioBroker-Host aus erreichbar ist.

## Disclaimer & Danksagungen

Siehe die Haupt-[README.md](README.md) für Credits und Disclaimer.

## Lizenz

MIT — siehe [README.md](README.md).
