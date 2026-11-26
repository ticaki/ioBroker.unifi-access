# ioBroker.unifi-access

## UniFi-Access-Adapter für ioBroker

Dieser Adapter verbindet ioBroker mit deinem **Ubiquiti UniFi Access**-Controller und nutzt die offizielle [UniFi Access Developer API](https://assets.identity.ui.com/unifi-access/api_reference.pdf) (auch im Repo unter `.doc/api_reference.pdf`). Schwerpunkt ist das Standalone-Gerät **UA Ultra**; die gleichen Code-Pfade decken weitere UniFi-Access-Modelle ab. Zwei optionale Integrationen erweitern den Funktionsumfang: ein UniFi-Protect-Controller liefert pro Access-Event Kamera-Snapshots und Clip-Links, und ein zweiter Webhook-Endpunkt nimmt Events externer Alarmsysteme entgegen.

## Voraussetzungen

| Komponente | Version |
|---|---|
| Node.js | 22 oder neuer |
| js-controller | 6.0.11 oder neuer |
| Admin-Adapter | **8.0.12 oder neuer** (die Einstellungsseite nutzt Custom-Components für Admin 8) |
| Web-Adapter | nur für die Statusseite (`/unifi-access/`) |
| UniFi Access | 2.2.10 oder neuer für den Webhook-Empfänger (die Events `access.unlock_schedule.*`, `access.temporary_unlock.*` und `access.visitor.status.changed` brauchen 3.3.10), 1.24.6 oder neuer für Sperrregeln und die Notfall-Schalter |

## Unterstützte Geräte

| Modell | Türöffner | Live-Events (WebSocket) | Event-Thumbnail | Türklingel (passiv) |
|---|:---:|:---:|:---:|:---:|
| **UA Ultra** | ✅ | ✅ | ✅ | ✅ |
| UA G3 Pro Doorbell | ✅ | ✅ | ✅ | ✅ |
| UA G2 Pro Reader | ✅ | ✅ | ✅ | ✅ |
| UA Intercom | ✅ | ✅ | ✅ | ✅ |
| UA Lite | ✅ | ✅ | – | – |
| UA Hub (inkl. Hub-/Gate-Varianten) | – | ✅ | – | – |
| Andere Modelle | – | ✅ | – | – |

Die Tabelle zeigt die Capability-Chips im Tab **Geräte & Türen** (State `devices.<id>.model`). Türen werden pro Tür gesteuert (`doors.<doorId>.*`), unabhängig davon, welches Gerät an sie gebunden ist. Thumbnail-States entstehen für jedes Gerät, das tatsächlich ein Thumbnail liefert, auch für Modelle ohne den Chip.

Falls dein Gerät zu den Basic-Modellen gehört und eine Funktion fehlt, bitte ein Issue eröffnen.

## Voraussetzung — API-Token in UniFi Access erzeugen

1. UniFi Access auf der Konsole öffnen (über das UniFi-Portal oder lokal).
2. Zu **Access → Einstellungen → Allgemein → Erweitert → API-Token** gehen.
3. **Create New** klicken, einen sprechenden Namen (z. B. `ioBroker`) und die Gültigkeitsdauer eingeben, die Berechtigungen (siehe unten) auswählen und **Create** klicken.
4. Den Token kopieren — er wird **nur einmal** angezeigt. Sicher abspeichern.

Der Adapter nutzt diesen Token sowohl für HTTPS-API-Aufrufe (`Authorization: Bearer <token>`) als auch für den WebSocket-Event-Stream.

Berechtigungen, die der Adapter nutzt (antwortet der Controller mit „forbidden“, nennt das Log die fehlende Berechtigung):

| Berechtigung | Gebraucht für |
|---|---|
| `view:device` | Geräteliste, WebSocket-Event-Stream, „Verbindung testen“ |
| `view:space` | Türen, Türstatus, Sperrregeln und Notfallstatus (lesen) |
| `edit:space` | Unlock, `unlock_duration`, `lock_rule`, Notfall-Schalter |
| `view:user` | Auswahl des Unlock-Akteurs in den Einstellungen |
| `view:webhook`, `edit:webhook` | Webhook-Empfänger (Registrierung des Endpunkts) |
| `view:system_log` | Event-Thumbnails (`/system/static`) und die Zuordnung von UniFi-Protect-Snapshots (System-Logs) |

## Konfiguration

Adapter-Instanz-Einstellungen im ioBroker-Admin öffnen. Die Konfiguration ist in sechs Tabs aufgeteilt.

### Verbindung

| Einstellung | Default | Hinweis |
|---|---|---|
| Controller-Host / IP (`controllerHost`) | – | Hostname oder IP der Konsole |
| Controller-Port (`controllerPort`) | `12445` | |
| API-Token (`apiToken`) | – | Passwortfeld mit Sichtbar-Schalter, verschlüsselt gespeichert |
| **Verbindung testen** | | Prüft den Controller mit den Werten des Formulars (noch ungespeichert): meldet die Anzahl gefundener Geräte oder den Grund (`unauthorized`, `network`, Zertifikatsproblem) |
| TLS-Zertifikat prüfen (`verifyTLS`) | aus | UniFi-Konsolen nutzen ein selbstsigniertes Zertifikat |
| CA-Zertifikat (PEM) (`caCert`) | – | Mehrzeilig; mehrere Zertifikate möglich. Ein eingefügtes Zertifikat, das seine Zeilenumbrüche verloren hat, wird repariert, ein unbrauchbares im Log gemeldet. Wird **zusätzlich** zu den System-CAs vertraut, genutzt, wenn **TLS-Zertifikat prüfen** hier oder im Protect-Tab aktiv ist |
| WebSocket-Reconnect-Delay (`wsReconnectDelay`) | `5` s | Maximaler Back-off zwischen Wiederverbindungsversuchen (1–300 s) |

### Geräte & Türen

| Einstellung | Default | Hinweis |
|---|---|---|
| Geräteliste | | Gefundene Geräte mit Modell und Capability-Chips |
| Standard-Öffnungsdauer (`defaultUnlockDuration`) | `0` | Minuten, `0`–`600`; `0` = Puls (siehe [Türsteuerung](#türsteuerung)) |
| Unlock-Akteur (`unlockActorId`) | – | UniFi-Access-Benutzer, dessen Name in Controller-Logs und Webhooks erscheint, wenn ioBroker eine Tür öffnet. Gilt nur für den Puls-Unlock — zeitlich begrenzte Öffnungen und Sperrregeln protokolliert UniFi unter dem Namen des API-Tokens |

### HTTP-Server

Ein gemeinsamer HTTP(S)-Listener bedient Webhook-Empfänger, Thumbnail-Proxy, UniFi-Protect-Medien und den Alarm-Manager-Webhook. Er startet nur, wenn mindestens einer davon aktiviert ist.

| Einstellung | Default | Hinweis |
|---|---|---|
| Listen-Port (`listenPort`) | `8095` | |
| Listen-IP (`listenIp`) | `0.0.0.0` | `0.0.0.0` = alle Interfaces |
| Öffentliche Basis-URL (`publicBaseUrl`) | leer | Optional: die Adresse, unter der Controller und Browser diesen Server erreichen, z. B. `https://iobroker.example.com` oder `https://proxy.example.com/iob` hinter einem Reverse-Proxy oder einer Portweiterleitung. Form `http(s)://host[:port][/pfad]`, ohne Query, Fragment oder Benutzer/Passwort; abschließende Schrägstriche werden entfernt. Genutzt für die registrierte Webhook-URL, `lastThumbnailUrl` und die Protect-Snapshot-/Clip-URLs. Leer = aus Listen-IP (bzw. erster nicht-interner IPv4-Adresse) und Listen-Port gebildet. Ein unbrauchbarer gespeicherter Wert wird beim Start gemeldet und ignoriert |
| TLS aktivieren (`enableTls`) | aus | HTTPS mit den im ioBroker-Zertifikatsspeicher gewählten Zertifikaten (öffentlich, privat, optional Kette) |
| Webhook-Empfänger aktivieren (`enableWebhooks`) | aus | Siehe [Webhook-Empfänger](#webhook-empfänger) |
| **Webhook neu registrieren** | | Button, sichtbar bei aktivem Empfänger |
| Thumbnail-Server aktivieren (`enableThumbnailServer`) | aus | Siehe [Event-Thumbnails](#event-thumbnails) |

> **TLS-Hinweis:** Mit **TLS aktivieren** nutzt der eingebaute Server die im ioBroker-Zertifikatsspeicher gewählten Zertifikate (Systemeinstellungen → Zertifikate). Lassen sie sich nicht laden, startet der Server **nicht** — es gibt keinen Rückfall auf unverschlüsseltes http. Webhook-Empfänger, Thumbnail-Server, Protect-Medien und Alarm-Manager-Webhook sind dann nicht verfügbar, es wird keine Webhook-URL registriert, und der Grund steht im Log. TLS nur aktivieren, wenn kein TLS-terminierender Reverse-Proxy davorgeschaltet ist.

### Alarm Manager

Zweiter Webhook-Endpunkt für externe Systeme, siehe [Alarm Manager](#alarm-manager-generic-webhook).

### UniFi Protect

Optionale Integration, siehe [UniFi-Protect-Integration](#unifi-protect-integration-optional).

### Event-Weiterleitung

Tabelle von Regeln: Event-Typ, optionale Geräte-ID, Ziel-State. Siehe [Events](#events).

## Türsteuerung

Für jede Tür legt der Adapter unter `unifi-access.<i>.doors.<doorId>` einen Channel an:

| State | Typ | Richtung | Hinweis |
|---|---|---|---|
| `name` | string | read | Sprechender Türname |
| `fullName` | string | read | Vollständiger Pfad (Etage/Controller) |
| `locked` | boolean | read | `true` = verriegelt, `false` = entriegelt, `null` = unbekannt. Wird nach Befehlen und Events vom Controller zurückgelesen |
| `position` | string | read | `open` / `close` vom Türsensor, `unknown` ohne Sensor |
| `isBindHub` | boolean | read | Tür ist an einen Hub gebunden (Voraussetzung für Remote-Unlock) |
| `lockRuleType` | string | read | Aktive temporäre Regel (`schedule`, `keep_lock`, `keep_unlock`, `custom`, `lock_early`; leer = keine) |
| `lockRuleEndsAt` | number | read | Ende der Regel (Epoch ms), `null` wenn keine |
| `unlock` | boolean | write | `true` = Puls-Unlock oder zeitlich begrenzter Unlock (abhängig von `defaultUnlockDuration`) |
| `unlock_duration` | number | write | Unlock für genau N **Minuten**, `0`–`600`; `0` = Puls. Überschreibt die globale Einstellung für diese eine Aktion |
| `lock_rule` | number | write | Sperr-Regel setzen (0 = default, 1 = keep_unlock, 2 = keep_lock, 3 = lock_now, 4 = lock_early) |

#### `lock_rule`-Werte

| Wert | Anzeige | Was passiert |
|:---:|---|---|
| `0` | `default` | Zurück zum normalen Zeitplan / Zustand (API: `reset`) |
| `1` | `keep_unlock` | Tür dauerhaft geöffnet halten (bis manuell zurückgesetzt) |
| `2` | `keep_lock` | Tür dauerhaft verriegelt (überschreibt alle Zeitpläne) |
| `3` | `lock_now` | Sofort verriegeln |
| `4` | `lock_early` | Aktiven Entsperr-Zeitplan vorzeitig beenden |

### Öffnungsdauer einstellen

Die Einstellung **Standard-Öffnungsdauer** (Tab *Geräte & Türen*, Feld `defaultUnlockDuration`) steuert das Verhalten des `unlock`-States für alle Türen:

| Wert | Verhalten |
|---|---|
| **`0`** (Standard) | Puls — Controller öffnet kurz und verriegelt danach selbst (`PUT /doors/:id/unlock`, mit Unlock-Akteur, falls gesetzt) |
| **`1`–`600`** | Tür bleibt genau **N Minuten** offen (`PUT /doors/:id/lock_rule`, Typ `custom`) |

Für eine individuelle Dauer pro Aktion den State `unlock_duration` direkt beschreiben — dieser überschreibt den Konfigurationswert für genau diesen einen Aufruf.

**Hinweis:** Die API akzeptiert nur ganze Minuten. Die Tür verriegelt nach Ablauf der Zeit automatisch wieder; vorzeitiges Verriegeln geht über `lock_rule = 3` (`lock_now`). Der Adapter prüft den Türstatus am Ende einer Regel, auch nach einem Neustart und für Regeln aus der UniFi-App.

### Regeln für die Steuer-States

- Ohne `ack` schreiben (wie bei Befehlen üblich). Der Adapter bestätigt den State, sobald der Befehl ausgeführt ist.
- **Ungültige Werte werden abgewiesen**: `unlock` reagiert nur auf boolesches `true`; `unlock_duration` nimmt Zahlen `0`–`600` (Nachkommastellen werden abgeschnitten); `lock_rule` nimmt die ganzen Zahlen `0`–`4`; die Notfall-Schalter nehmen nur Booleans. Ein abgewiesener Wert wird als Warnung geloggt und der State (mit `ack`) auf den letzten bestätigten Wert zurückgesetzt.
- **Ohne Verbindung kein Befehl**: Solange der Controller seit dem Adapterstart nicht erreichbar war (Türen noch nicht geladen) oder die Verbindung verloren ist, werden Befehle weder ausgeführt noch vorgemerkt — der State wird zurückgesetzt, eine Warnung nennt den Grund. Nach dem Verbinden erneut schreiben.
- Türen, die am Controller verschwinden, werden nicht automatisch gelöscht; ein Befehl an eine solche Tür wird mit Warnung abgewiesen.

### Notfall-States

Zusätzlich zur Einzeltür-Steuerung stellt der Adapter die controllerweiten Notfall-Schalter unter `doors.emergency.*` bereit (UniFi Access ≥ 1.24.6, geschrieben über `PUT /doors/settings/emergency`):

| State | Typ | Richtung | Hinweis |
|---|---|---|---|
| `doors.emergency.lockdown` | boolean | read/write | Alle Türen verriegeln (Lockdown) |
| `doors.emergency.evacuation` | boolean | read/write | Alle Türen entriegeln (Evakuierung) |

Das jeweils andere Flag wird vor jeder Änderung frisch vom Controller gelesen. Beide States können `null` sein, solange der Controller nie einen Wert gemeldet hat. Ein fehlgeschlagener Befehl lässt den angeforderten Wert nicht stehen.

## Türklingel-Anrufe

Beim Klingeln (UA Ultra, UA G3 Pro, UA G2 Pro, UA Intercom) zeigt der Adapter den aktiven Anruf passiv an:

| State | Typ | Hinweis |
|---|---|---|
| `doorbell.activeCallId` | string | ID des klingelnden Anrufs, `null` wenn keiner aktiv |
| `doorbell.activeFromDevice` | string | Auslösende Tür / Gerät |
| `doorbell.activeStartedAt` | number | Epoch-Millisekunden |

Der Anruf wird gelöscht, wenn er angenommen, abgelehnt oder abgebrochen wurde oder ein Admin die Tür geöffnet hat (gemeldet per WebSocket oder Webhook), beim Adapterstart und spätestens 3 Minuten nach Beginn ohne Ende-Event.

Es gibt **kein Annehmen/Ablehnen** im Adapter — die Developer-API hat dafür keinen Endpunkt. Zum tatsächlichen Beantworten die offizielle UniFi-Access-App nutzen.

## Event-Thumbnails

Die Developer-API bietet keinen On-Demand-Snapshot, Event-Payloads (WebSocket oder Webhook) tragen aber einen `door_thumbnail`-Pfad. Der Adapter merkt sich pro Gerät den letzten gültigen Pfad:

| State | Typ | Hinweis |
|---|---|---|
| `devices.<id>.lastThumbnailPath` | string | vom Controller gelieferter (relativer) Pfad |
| `devices.<id>.lastThumbnailAt` | number | Epoch-Millisekunden des Events |
| `devices.<id>.lastThumbnailUrl` | string | URL des adapterinternen Thumbnail-Proxys. **Leer**, solange der Thumbnail-Server ausgeschaltet ist oder der HTTP-Server nicht läuft; wird beim Start neu gebildet, wenn Port, Listen-IP, öffentliche Basis-URL oder TLS geändert wurden |

Weitere Geräte-States, die beim Bootstrap und durch Live-Events befüllt werden: `name`, `alias`, `type`, `model`, `firmware`, `online` (nur aus der Geräteliste), `lastSeenAt` (ISO-Zeitstempel des letzten Events).

Bei aktivem **Thumbnail-Server** stellt der Adapter das aktuellste Bild als JPEG bereit unter `<Basis-URL>/unifi-access/<i>/thumbnail/<deviceId>.jpg`; Basis-URL ist die öffentliche Basis-URL oder `<scheme>://<Listen-IP oder erste IPv4>:<listenPort>`. Intern holt er das Bild über `/api/v1/developer/system/static/<path>` (Bearer-Auth bleibt im Adapter), sodass der Browser keinen Token braucht. Ausgeliefert werden nur geprüfte Bildpfade. Die Medien-URLs selbst sind nicht passwortgeschützt (damit sie sich in vis einbinden lassen).

## Webhook-Empfänger

Über den WebSocket kommen nur Klingelvorgänge und Admin-Remote-Unlock-Events. Für `access.door.unlock`, `access.device.dps_status`, `access.device.emergency_status`, `access.unlock_schedule.*`, `access.temporary_unlock.*`, `access.visitor.status.changed` und die Doorbell-Webhook-Varianten wird der Webhook-Empfänger gebraucht:

1. **HTTP-Server → Webhook-Empfänger aktivieren** anhaken.
2. **Listen-Port** (Default `8095`) und **Listen-IP** (Default `0.0.0.0`) prüfen oder eine **Öffentliche Basis-URL** setzen, wenn der Controller ioBroker unter einer anderen Adresse erreicht (Reverse-Proxy, Portweiterleitung, Docker, mehrere Netzwerkkarten).
3. Speichern. Sobald der Controller erreichbar ist, registriert der Adapter `<Basis-URL>/unifi-access-webhook` über `POST /api/v1/developer/webhooks/endpoints`, speichert das zurückgegebene Secret verschlüsselt in der Instanzkonfiguration und prüft jede eingehende Anfrage per HMAC-SHA256 über `<unix>.<rawBody>` (Header `Signature: t=…,v1=…`, höchstens 5 Minuten Uhrzeitabweichung).

Der Webhook-Pfad ist fest auf `/unifi-access-webhook`. Registrierte Events: `access.doorbell.incoming`, `access.doorbell.completed`, `access.doorbell.incoming.REN`, `access.device.dps_status`, `access.door.unlock`, `access.device.emergency_status`, `access.unlock_schedule.activate`, `access.unlock_schedule.deactivate`, `access.temporary_unlock.start`, `access.temporary_unlock.end`, `access.visitor.status.changed`.

- Der Endpunkt am Controller heißt `ioBroker.unifi-access (<Instanz>@<ioBroker-Host>#<Installationskennung>)`. Geändert oder gelöscht werden nur Endpunkte dieser Installation; mehrere ioBroker-Installationen können also denselben Controller nutzen. Ein Endpunkt einer früheren Adapterversion wird beim ersten Start umbenannt (ID und Secret bleiben).
- Ändern sich Event-Liste oder URL (z. B. neue IP, neue Basis-URL), wird der bestehende Endpunkt aktualisiert — gleiche ID, gleiches Secret, kein Adapter-Neustart.
- Die Registrierung wird nach jedem Reconnect und alle 15 Minuten geprüft; ein Endpunkt, den der Controller verloren hat, wird neu registriert.
- Falls ein frisches Secret nötig ist (verlorenes Backup, geleakter Wert, anhaltende „signature verification failed“-Warnungen), **Webhook neu registrieren** drücken. Das löscht den Endpunkt dieser Installation und legt einen neuen an; das Speichern des neuen Secrets startet die Instanz neu.

## Alarm Manager (Generic Webhook)

Der **Alarm Manager**-Tab öffnet einen zweiten HTTP-Endpunkt am gemeinsamen Listener — gedacht für externe Systeme wie den UniFi Alarm Manager, Alarmanlagen, Smart-Home-Hubs oder eigene Skripte. Er nimmt JSON-POSTs entgegen und schreibt das geparste Payload in die `notifications.*`-States.

| Einstellung | Default | Hinweis |
|---|---|---|
| Alarm Manager-Webhook aktivieren (`enableGenericWebhook`) | aus | |
| Listen-Pfad (`genericWebhookPath`) | `/webhook` | Ein fehlender führender Schrägstrich wird ergänzt, doppelte Schrägstriche werden zusammengefasst. Die Pfade des Adapters selbst (`/unifi-access-webhook` und alles unter `/unifi-access/`) sind **reserviert**: die Einstellungen lehnen sie ab, und ein gespeicherter reservierter Pfad lässt den Generic Webhook ausgeschaltet (Fehler im Log) |
| Authentifizierungsmodus (`genericWebhookAuth`) | `none` | `none`, `basic` (`genericWebhookUsername` / `genericWebhookPassword`) oder `bearer` (`genericWebhookToken`). Der Schema-Name im `Authorization`-Header wird in beliebiger Groß-/Kleinschreibung akzeptiert. Bei `basic` oder `bearer` ohne hinterlegte Zugangsdaten wird **jede** Anfrage abgelehnt |

Die URL-Anzeige unter den Einstellungen zeigt die URL, auf der der laufende Server tatsächlich antwortet — öffentliche Basis-URL plus Pfad oder eine URL pro Netzwerk-Interface — mit Kopier-Button. Sie meldet, wenn der Server nicht läuft oder TLS nicht aktiviert werden konnte, und wenn geänderte Einstellungen noch nicht gespeichert sind.

Antworten: `200 OK` (angenommen), `401` (Authentifizierung fehlgeschlagen), `400` (Body nicht lesbar oder größer als 1 MB).

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

Wenn ein UniFi-Protect-Controller dieselben Türen filmt, kann der Adapter Tür-Events ein Snapshot-Bild (und einen Clip-Link) anhängen:

| Einstellung | Default | Hinweis |
|---|---|---|
| Protect-Integration aktivieren (`enableProtect`) | aus | |
| Benutzername / Passwort (`protectUsername` / `protectPassword`) | – | Lokaler Protect-Account (Cloud- bzw. UI-Accounts werden **nicht** unterstützt). Das Passwort wird verschlüsselt gespeichert |
| TLS-Zertifikat prüfen (`protectVerifyTLS`) | **aus** | Nur aktivieren, wenn die Konsole ein gültiges Zertifikat hat oder ihr CA-Zertifikat im Tab Verbindung hinterlegt ist. Ist die Option an und das Zertifikat selbstsigniert, wird der Login abgelehnt und eine Warnung erklärt, was zu tun ist |

Die Protect-API wird auf demselben Host wie UniFi Access angesprochen, Port 443 (`native.protectPort`, kein Feld in den Einstellungen). Ein abgelehnter Login (Zugangsdaten, Zertifikat) lässt die Integration bis zum Neustart der Instanz aus; eine Konsole mit Rate-Limit oder noch nicht erreichbare Konsole wird mit wachsendem Abstand erneut versucht (30 s, 60 s, … bis 10 Minuten).

State:

| State | Typ | Hinweis |
|---|---|---|
| `info.protectConnected` | boolean | `true`, sobald der Protect-Login erfolgreich war |

Im verbundenen Zustand cached der Adapter Snapshots im Speicher (höchstens 50 Einträge / 32 MiB, die ältesten fallen zuerst heraus) und referenziert sie aus dem passenden Event in `events.last` (`protectSnapshotUrl`, `protectVideoUrl`). Clips werden durch den Adapter gestreamt. URLs werden nur geschrieben, solange der eingebaute HTTP-Server läuft. Der Cache übersteht keinen Neustart: die Snapshot-URL eines älteren Events antwortet dann mit `404`, und die Statusseite zeigt „Not available“ — nie ein aktuelles Bild der Kamera. Die www-Statusseite zeigt den Snapshot direkt im Event-Log und bietet den Clip über ein Modal an.

## Events

Die letzten 50 Events liegen in `events.last` (JSON-Array, neuestes zuerst). Jeder Eintrag hat `ts`, `source` (`'ws'` oder `'webhook'`), `type`, optional `subtype` (Ende-Grund eines Klingelrufs, Ergebnis eines Unlocks, `open`/`close` des Türsensors), `deviceId`, `deviceName`, `doorId`, `doorName`, `userName`, `granted` (nur `access.door.unlock`: ob der Zutritt gewährt wurde), `thumbnailPath`, `protectSnapshotUrl`, `protectVideoUrl`, `raw`.

In `raw` sind die WebRTC-Zugangsdaten eines Klingelrufs (`channel`, `token`) entfernt und PIN- bzw. Kartenwerte (`authentication_value`) durch `"***"` ersetzt.

**Event-Weiterleitung** (Tab *Event-Weiterleitung*): Jede Regel hat einen Event-Typ, eine optionale Geräte-ID und eine Ziel-State-ID. Jedes passende Event wird als JSON (gleiches Format wie ein Eintrag in `events.last`) mit `ack: true` in den Ziel-State geschrieben. Eine Regel mit Geräte-ID passt nur auf Events genau dieses Geräts. Reine Webhook-Events erfordern den Webhook-Empfänger.

## sendTo()-API

`sendTo('unifi-access.<i>', '<Kommando>', payload, callback)`. Jede Nachricht mit Callback bekommt genau eine Antwort; Fehler stehen im String-Feld `error`. Anfragen, die eintreffen, während die Instanz noch startet, warten bis zu 8 s auf den ersten Ladeversuch des Controller-Zustands (`getConnectionStatus`, `listDevices`, `listUsers`, `reregisterWebhook`, `getServerInfo`).

| Kommando | Payload | Antwort |
|---|---|---|
| `getConnectionStatus` | `{}` | `{connected, hasToken, lastError, controllerName, webhookRegistered}` |
| `verifyToken` | `{host, port, token, verifyTLS?, caCert?}` | `{ok:true, deviceCount}` / `{ok:false, error:'missing-fields'\|'unauthorized'\|'network'}` / `{ok:false, error:'tls', detail:'<Zertifikatsfehler-Code>'}` |
| `listDevices` | `{}` | `{devices: [{id, name, alias, type, model, firmware, online, capabilities, lastSeenAt}]}` |
| `listUsers` | `{}` | `{users: [{id, name}]}`, bei Fehler `{users: [], error:'not-configured'\|'unauthorized'\|'network'}` |
| `reregisterWebhook` | `{}` | `{ok:true, id}` / `{ok:false, error}` mit `not-configured`, `webhooks-disabled`, `receiver-not-running`, `unloading` (Instanz stoppt gerade) oder einem Fehlertext |
| `getServerInfo` | `{}` | `{running, scheme, port, baseUrl, tlsEnabled, tlsActive, tlsError, publicBaseUrl}` — tatsächlicher Zustand des eingebauten HTTP-Servers (`scheme`/`baseUrl` sind `null`, solange er nicht läuft) |
| `getNetworkInterfaces` | `{}` | `{addresses: string[]}` (nicht-interne IPv4-Adressen) |

`verifyToken` nutzt die Werte aus dem Payload; fehlen `verifyTLS` / `caCert`, gilt die gespeicherte Konfiguration. Der Token wird nie geloggt. Unbekannte Kommandos: `{ok:false, error:'unknown-command'}`.

Weitere lesbare Adapter-States unter `info.*`: `info.connection` (Controller erreichbar, folgt dem WebSocket), `info.webhookEndpointId`, `info.webhookRegistered` (tatsächlicher Stand dieser Laufzeit), `info.protectConnected`. Das Webhook-Secret liegt ausschließlich verschlüsselt in der Instanzkonfiguration.

## Web-Oberfläche (Status & Steuerung)

Erreichbar über den ioBroker-Web-Adapter unter `/unifi-access/` (automatisch aus der Admin-Instanzliste verlinkt). `index.html?instance=1` zeigt eine andere Instanz (Default `0`). Die Seite ist englischsprachig.

Funktionen:

- Controller-Status-Badge (live)
- Tür-Liste mit Unlock-Buttons, Schließzustand, aktiver temporärer Sperrregel und Hinweis bei Lockdown/Evakuierung
- Karte mit dem letzten Event-Thumbnail (Geräte mit Thumbnails)
- Karte für aktive Türklingel (passiv — verweist auf die offizielle App zum Annehmen)
- Aktuelles Event-Log (`events.last`) mit „Access denied“ für abgewiesene Versuche und, mit UniFi Protect, dem Snapshot (kurzer Countdown während des Abrufs, „Not available“, wenn keiner kam) plus Clip-Modal
- Settings-Drawer für Layout-Anpassungen (Card-Sichtbarkeit, Thumbnail-/Snapshot-Größe — gespeichert im State `admin.uiSettings`, also für alle Browser gleich; nur Hell/Dunkel bleibt im Browser)

**Reverse-Proxy:** Die Seite funktioniert auch hinter einem Reverse-Proxy mit Pfad-Präfix (z. B. `https://proxy.example.com/iob/unifi-access/`). Der Proxy muss den ganzen Web-Adapter einschließlich seines `lib/`-Ordners (`…/iob/lib/js/socket.io.js`) und die WebSocket-Verbindung weiterleiten. Lässt sich die Verbindungsbibliothek nicht laden, meldet die Seite das. Für Thumbnails und Kamerabilder hinter demselben Proxy die **Öffentliche Basis-URL** des HTTP-Servers setzen und den eingebauten Server ebenfalls weiterleiten.

## Nicht unterstützt

Bewusst **nicht** enthalten:

- WebRTC-Live-Video, Doorbell Annehmen/Ablehnen, Gegensprechen — die UniFi-Access-Developer-API bietet dafür keine dokumentierten Endpunkte (Klingelrufe werden passiv angezeigt)
- On-Demand-Kamerabilder — die API liefert Thumbnails nur als Teil von Events
- Klingel auslösen, Einstellungen der Zutrittsmethoden, schreibende Benutzer-/Besucherverwaltung
- Cloud-Login (UI-Account / OAuth) — nur der lokale API-Token
- Automatisches Löschen von Türen und Geräten, die am Controller verschwunden sind (bei Bedarf manuell löschen)
- Passwortschutz der Medien-URLs (Thumbnails, Protect-Snapshots/-Clips)

## Troubleshooting

- **`unauthorized` nach Token-Eingabe** — den ganzen Wert kopiert? Tokens lassen sich in der UI nicht erneut anzeigen — im Zweifel neu erzeugen und einfügen. Auch die Berechtigungen des Tokens prüfen (siehe oben); eine fehlende Berechtigung nennt das Log.
- **`network`-Fehler / `404` beim Bootstrap** — Host/Port/Firewall prüfen. UniFi Access lauscht auf UA Ultra und UniFi-OS-Konsolen standardmäßig auf Port `12445`. Ein Host/Port, der nicht wie die UniFi-Access-API antwortet, wird als `network` gemeldet.
- **TLS-Validierungsfehler** — der Controller nutzt ein selbstsigniertes Zertifikat; die TLS-Prüfung ist per Default aus. **TLS-Zertifikat prüfen** nur aktivieren, wenn das Controller-CA in **CA-Zertifikat** eingetragen ist. „Verbindung testen“ nennt das Zertifikatsproblem (z. B. selbstsigniert, Hostname passt nicht).
- **Befehle werden sofort zurückgesetzt** — der Controller ist nicht verbunden (siehe Warnung im Log) oder der Wert ist ungültig.
- **WebSocket reconnectet ständig** — der Controller bricht ggf. inaktive Verbindungen ab. **WebSocket-Reconnect-Delay** erhöhen, um den Back-off zu begrenzen.
- **"Webhook endpoint created but response did not include id/secret"** — der UniFi-Access-Controller gibt keinen gültigen Endpunkt zurück. Häufigste Ursache: UniFi Access älter als **2.2.10** (Mindestversion der Webhook-API).
- **Webhooks kommen nicht an** — prüfen, ob die Webhook-URL vom Controller aus erreichbar ist und ein vorgelagerter Reverse-Proxy sowohl den Body als auch den `Signature`-Header unverändert weiterreicht. **Listen-IP** oder **Öffentliche Basis-URL** explizit eintragen, statt sich auf die automatisch erkannte erste IPv4 zu verlassen. Die Uhren von Konsole und ioBroker-Host dürfen höchstens 5 Minuten voneinander abweichen.
- **HTTP-Server startet nicht** — bei **TLS aktivieren** die gewählten Zertifikate prüfen (das Log nennt den Grund); sonst prüfen, ob der Listen-Port frei ist.
- **UniFi-Protect-Login fehlgeschlagen** — nur lokale Protect-Accounts funktionieren, keine Cloud-/UI-Accounts. Zugangsdaten prüfen und sicherstellen, dass der Protect-Controller vom ioBroker-Host aus erreichbar ist. Nach dem Korrigieren der Einstellungen startet die Instanz neu und versucht es erneut.

## Disclaimer & Danksagungen

Siehe die Haupt-[README.md](README.md) für Credits und Disclaimer.

## Lizenz

MIT — siehe [README.md](README.md).
