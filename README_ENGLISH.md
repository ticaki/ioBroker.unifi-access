# ioBroker.unifi-access

## UniFi Access adapter for ioBroker

This adapter connects ioBroker to your **Ubiquiti UniFi Access** controller using the documented [UniFi Access Developer API](https://assets.identity.ui.com/unifi-access/api_reference.pdf) (also bundled in this repo at `.doc/api_reference.pdf`). Designed around the **UA Ultra** standalone device; the same code paths cover other UniFi Access models. Optional integrations let you pair a UniFi Protect controller (camera snapshots + clip URLs on access events) and expose a second webhook endpoint for external alarm systems.

## Requirements

| Component | Version |
|---|---|
| Node.js | 22 or newer |
| js-controller | 6.0.11 or newer |
| Admin adapter | **8.0.12 or newer** (the settings page uses Admin 8 custom components) |
| Web adapter | only for the status page (`/unifi-access/`) |
| UniFi Access | 2.2.10 or newer for the webhook receiver (the events `access.unlock_schedule.*`, `access.temporary_unlock.*` and `access.visitor.status.changed` need 3.3.10), 1.24.6 or newer for lock rules and the emergency switches |

## Supported devices

| Model | Door unlock | Live events (WebSocket) | Event thumbnails | Doorbell ring (passive) |
|---|:---:|:---:|:---:|:---:|
| **UA Ultra** | ✅ | ✅ | ✅ | ✅ |
| UA G3 Pro Doorbell | ✅ | ✅ | ✅ | ✅ |
| UA G2 Pro reader | ✅ | ✅ | ✅ | ✅ |
| UA Intercom | ✅ | ✅ | ✅ | ✅ |
| UA Lite | ✅ | ✅ | – | – |
| UA Hub (incl. hub/gate variants) | – | ✅ | – | – |
| Other models | – | ✅ | – | – |

The table shows the capability chips of the **Devices & Doors** tab (state `devices.<id>.model`). Doors are controlled per door (`doors.<doorId>.*`), independent of the device that is bound to them. Thumbnail states are created for every device that actually delivers a thumbnail, also for models without the chip.

If you have one of the basic-support models and find a missing function, please open an issue.

## Prerequisites — generating the API token in UniFi Access

1. Open UniFi Access on your console (via the UniFi Portal or locally).
2. Go to **Access → Settings → General → Advanced → API Token**.
3. Click **Create New**, enter a descriptive name (e.g. `ioBroker`) and the validity period, select the permission scopes (see below) and click **Create**.
4. Copy the token — it is shown **only once**. Store it safely.

The adapter uses this token both for HTTPS API calls (`Authorization: Bearer <token>`) and for the WebSocket event stream.

Permission scopes the adapter uses (a missing permission is named in the log when the controller answers with "forbidden"):

| Permission | Needed for |
|---|---|
| `view:device` | device list, WebSocket event stream, "Test connection" |
| `view:space` | doors, door status, lock rules and emergency status (read) |
| `edit:space` | unlock, `unlock_duration`, `lock_rule`, emergency switches |
| `view:user` | unlock actor selection in the settings |
| `view:webhook`, `edit:webhook` | webhook receiver (registration of the endpoint) |
| `view:system_log` | event thumbnails (`/system/static`) and the UniFi Protect snapshot assignment (system logs) |

## Configuration

Open the adapter instance configuration in the ioBroker admin UI. The settings are split into six tabs.

### Connection

| Setting | Default | Notes |
|---|---|---|
| Controller host / IP (`controllerHost`) | – | Host name or IP of the console |
| Controller port (`controllerPort`) | `12445` | |
| API token (`apiToken`) | – | Password field with a show/hide switch, stored encrypted |
| **Test connection** | | Probes the controller with the values of the form (not saved yet): reports the number of devices found or the reason (`unauthorized`, `network`, certificate problem) |
| Verify TLS certificate (`verifyTLS`) | off | UniFi consoles use a self-signed certificate |
| CA certificate (PEM) (`caCert`) | – | Multi-line; several certificates allowed. A pasted certificate that lost its line breaks is repaired, an unusable one is reported in the log. Trusted **in addition** to the system CAs, used when **Verify TLS certificate** is on here or on the Protect tab |
| WebSocket reconnect delay (`wsReconnectDelay`) | `5` s | Maximum back-off between reconnect attempts (1–300 s) |

### Devices & Doors

| Setting | Default | Notes |
|---|---|---|
| Device list | | Devices found, with model and capability chips |
| Default unlock duration (`defaultUnlockDuration`) | `0` | Minutes, `0`–`600`; `0` = pulse (see [Door control](#door-control)) |
| Unlock actor (`unlockActorId`) | – | UniFi Access user whose name appears in the controller logs and webhooks when ioBroker opens a door. Applies only to the pulse unlock — timed unlocks and lock rules are logged under the name of the API token |

### HTTP server

One shared HTTP(S) listener serves the webhook receiver, the thumbnail proxy, the UniFi Protect media and the Alarm Manager webhook. It is started only when at least one of them is enabled.

| Setting | Default | Notes |
|---|---|---|
| Listen port (`listenPort`) | `8095` | |
| Listen IP (`listenIp`) | `0.0.0.0` | `0.0.0.0` = all interfaces |
| Public base URL (`publicBaseUrl`) | empty | Optional: the address under which the controller and browsers reach this server, e.g. `https://iobroker.example.com` or `https://proxy.example.com/iob` behind a reverse proxy or port forwarding. Form `http(s)://host[:port][/path]`, without query, fragment or user/password; trailing slashes are removed. Used for the registered webhook URL, `lastThumbnailUrl` and the Protect snapshot/clip URLs. Empty = built from the listen IP (or the first non-internal IPv4 address) and the listen port. An unusable stored value is reported at start and ignored |
| Enable TLS (`enableTls`) | off | Serve HTTPS with the certificates selected from the ioBroker certificate store (public, private, optional chain) |
| Enable webhook receiver (`enableWebhooks`) | off | See [Webhook receiver](#webhook-receiver) |
| **Re-register webhook** | | Button, shown while the receiver is enabled |
| Enable thumbnail server (`enableThumbnailServer`) | off | See [Event thumbnails](#event-thumbnails) |

> **TLS note:** with **Enable TLS** the built-in server uses the certificates selected from the ioBroker certificate store (System settings → Certificates). If they cannot be loaded, the server is **not started** — there is no fall-back to plain http. Webhook receiver, thumbnail server, Protect media and Alarm Manager webhook are then unavailable, no webhook URL is registered, and the reason is logged. Enable TLS only if no TLS-terminating reverse proxy sits in front.

### Alarm Manager

Second webhook endpoint for external systems, see [Alarm Manager](#alarm-manager-generic-webhook).

### UniFi Protect

Optional integration, see [UniFi Protect integration](#unifi-protect-integration-optional).

### Event forwarding

Table of rules: event type, optional device id, target state. See [Events](#events).

## Door control

For every door discovered, the adapter creates a channel under `unifi-access.<i>.doors.<doorId>` with these states:

| State | Type | Direction | Notes |
|---|---|---|---|
| `name` | string | read | Human-readable door name |
| `fullName` | string | read | Full path including floor/controller |
| `locked` | boolean | read | `true` = locked, `false` = unlocked, `null` = unknown. Read back from the controller after commands and events |
| `position` | string | read | `open` / `close` from the door sensor, `unknown` without sensor |
| `isBindHub` | boolean | read | Door is bound to a hub (required for remote unlock) |
| `lockRuleType` | string | read | Active temporary rule (`schedule`, `keep_lock`, `keep_unlock`, `custom`, `lock_early`; empty = none) |
| `lockRuleEndsAt` | number | read | End of the rule (epoch ms), `null` if none |
| `unlock` | boolean | write | `true` = pulse or timed unlock (depends on `defaultUnlockDuration`) |
| `unlock_duration` | number | write | Unlock for exactly N **minutes**, `0`–`600`; `0` = pulse. Overrides the global setting for this one action |
| `lock_rule` | number | write | Set a lock rule (0 = default, 1 = keep_unlock, 2 = keep_lock, 3 = lock_now, 4 = lock_early) |

#### `lock_rule` values

| Value | Label | What it does |
|:---:|---|---|
| `0` | `default` | Return to normal schedule / state (API: `reset`) |
| `1` | `keep_unlock` | Keep door open indefinitely (until manually reset) |
| `2` | `keep_lock` | Keep door locked (overrides all schedules) |
| `3` | `lock_now` | Lock immediately |
| `4` | `lock_early` | End an active unlock schedule early |

### Setting the unlock duration

The **Default unlock duration** setting (tab *Devices & Doors*, field `defaultUnlockDuration`) controls the behaviour of the `unlock` state for all doors:

| Value | Behaviour |
|---|---|
| **`0`** (default) | Pulse — the controller opens briefly and re-locks itself (`PUT /doors/:id/unlock`, with the unlock actor if one is set) |
| **`1`–`600`** | Door stays open for exactly **N minutes** (`PUT /doors/:id/lock_rule`, type `custom`) |

To set a per-action duration, write directly to `unlock_duration` — this overrides the configuration value for that single call.

**Note:** The API accepts whole minutes only. The door re-locks automatically when the timer expires; early re-locking is done via `lock_rule = 3` (`lock_now`). The adapter checks the door status at the end of a rule, also after a restart and for rules set in the UniFi app.

### Rules for the control states

- Write without `ack` (as usual for commands). The adapter acknowledges the state once the command was carried out.
- **Invalid values are rejected**: `unlock` reacts only to boolean `true`; `unlock_duration` accepts numbers `0`–`600` (fractions are rounded down); `lock_rule` accepts the integers `0`–`4`; the emergency switches accept booleans only. A rejected value is logged as a warning and the state is reset (with `ack`) to the last confirmed value.
- **No connection, no command**: while the controller has not been reachable since the adapter start (doors not loaded yet) or the connection is lost, commands are not executed and not queued — the state is reset and a warning names the reason. Write it again once the controller is connected.
- Doors that disappear from the controller are not deleted automatically; a command to such a door is refused with a warning.

### Emergency states

In addition to per-door control the adapter exposes the controller-wide emergency switches under `doors.emergency.*` (UniFi Access ≥ 1.24.6, applied via `PUT /doors/settings/emergency`):

| State | Type | Direction | Notes |
|---|---|---|---|
| `doors.emergency.lockdown` | boolean | read/write | Lock down all doors |
| `doors.emergency.evacuation` | boolean | read/write | Release all doors (evacuation) |

The other flag is read fresh from the controller before each change. Both states may be `null` while the controller has never reported a value. A failed command does not leave the requested value standing.

## Doorbell calls

When a doorbell rings (UA Ultra, UA G3 Pro, UA G2 Pro, UA Intercom), the adapter shows the active call passively:

| State | Type | Notes |
|---|---|---|
| `doorbell.activeCallId` | string | Id of the ringing call, `null` if none |
| `doorbell.activeFromDevice` | string | Originating door / device |
| `doorbell.activeStartedAt` | number | Epoch milliseconds |

The call is cleared when it was answered, declined, cancelled or the door was opened by an admin (reported via WebSocket or webhook), at adapter start, and at the latest 3 minutes after it started without an end event.

There is **no accept/reject** in the adapter — the UniFi Access Developer API has no endpoint for that. Use the official UniFi Access mobile app to actually answer the call.

## Event thumbnails

The Developer API does not provide on-demand snapshots, but event payloads (WebSocket or webhook) carry a `door_thumbnail` path. The adapter records the latest valid path per device:

| State | Type | Notes |
|---|---|---|
| `devices.<id>.lastThumbnailPath` | string | Path returned by the controller (relative) |
| `devices.<id>.lastThumbnailAt` | number | Epoch milliseconds of the event |
| `devices.<id>.lastThumbnailUrl` | string | URL served by the adapter's thumbnail proxy. **Empty** while the thumbnail server is switched off or the HTTP server is not running; rebuilt at start after port, listen IP, public base URL or TLS were changed |

Other per-device states populated during bootstrap and from live events: `name`, `alias`, `type`, `model`, `firmware`, `online` (from the device list only), `lastSeenAt` (ISO timestamp of the last event).

When **Enable thumbnail server** is on, the adapter delivers the latest image as JPEG at `<base URL>/unifi-access/<i>/thumbnail/<deviceId>.jpg`, where the base URL is the public base URL or `<scheme>://<listen IP or first IPv4>:<listenPort>`. Internally it fetches the image from `/api/v1/developer/system/static/<path>` (Bearer-authenticated), so the browser does not need the controller credentials. Only validated image paths are served. The media URLs themselves are not protected by a password (so they can be embedded in vis).

## Webhook receiver

The WebSocket only carries doorbell ringing/state-change and admin remote-unlock events. To receive `access.door.unlock`, `access.device.dps_status`, `access.device.emergency_status`, `access.unlock_schedule.*`, `access.temporary_unlock.*`, `access.visitor.status.changed` and the doorbell webhook variants, enable the webhook receiver:

1. **HTTP server → Enable webhook receiver**.
2. Check **Listen port** (default `8095`) and **Listen IP** (default `0.0.0.0`), or set a **Public base URL** if the controller reaches ioBroker under another address (reverse proxy, port forwarding, Docker, several network cards).
3. Save. As soon as the controller is reachable, the adapter registers `<base URL>/unifi-access-webhook` via `POST /api/v1/developer/webhooks/endpoints`, stores the returned secret encrypted in the instance configuration and validates every incoming request via HMAC-SHA256 over `<unix>.<rawBody>` (header `Signature: t=…,v1=…`, at most 5 minutes clock difference).

The webhook path is fixed at `/unifi-access-webhook`. Registered events: `access.doorbell.incoming`, `access.doorbell.completed`, `access.doorbell.incoming.REN`, `access.device.dps_status`, `access.door.unlock`, `access.device.emergency_status`, `access.unlock_schedule.activate`, `access.unlock_schedule.deactivate`, `access.temporary_unlock.start`, `access.temporary_unlock.end`, `access.visitor.status.changed`.

- The endpoint at the controller is named `ioBroker.unifi-access (<instance>@<ioBroker host>#<installation id>)`. Only endpoints of this installation are ever changed or removed, so several ioBroker installations can use the same controller. An endpoint of an earlier adapter version is renamed in place at the first start (id and secret are kept).
- When the event list or the URL changes (e.g. new IP, new public base URL), the existing endpoint is updated in place — same id and secret, no adapter restart.
- The registration is checked after every reconnect and every 15 minutes; an endpoint the controller lost is registered again.
- If you ever need a fresh secret (lost backup, leaked secret, lingering "signature verification failed" warnings), press **Re-register webhook**. It deletes this installation's endpoint and creates a new one; storing the new secret restarts the instance.

## Alarm Manager (generic webhook)

The **Alarm Manager** tab opens a second HTTP endpoint on the same shared listener for external systems — e.g. the UniFi Alarm Manager, alarm panels, smart-home hubs or custom scripts. It accepts JSON POSTs and writes the parsed payload into the `notifications.*` states.

| Setting | Default | Notes |
|---|---|---|
| Enable Alarm Manager webhook (`enableGenericWebhook`) | off | |
| Listen path (`genericWebhookPath`) | `/webhook` | A missing leading slash is added, repeated slashes are merged. The paths of the adapter itself (`/unifi-access-webhook` and everything below `/unifi-access/`) are **reserved**: the settings refuse them, and a stored reserved path keeps the generic webhook switched off (error in the log) |
| Authentication mode (`genericWebhookAuth`) | `none` | `none`, `basic` (`genericWebhookUsername` / `genericWebhookPassword`) or `bearer` (`genericWebhookToken`). The scheme name in the `Authorization` header is accepted in any upper/lower case. With `basic` or `bearer` but without stored credentials **every** request is rejected |

The URL display below the settings shows the URL that the running server really answers on — the public base URL plus path, or one URL per network interface — with a copy button. It says when the server is not running or TLS could not be activated, and when changed settings are not saved yet.

Answers: `200 OK` (accepted), `401` (authentication failed), `400` (body could not be read or larger than 1 MB).

States populated on each accepted POST:

| State | Type | Notes |
|---|---|---|
| `notifications.lastRaw` | string | Raw JSON body |
| `notifications.lastAlarmId` | string | Alarm identifier from the payload |
| `notifications.lastEventType` | string | Event type as supplied by the sender |
| `notifications.lastLocationId` | string | Location id (optional) |
| `notifications.lastLocationName` | string | Location name (optional) |
| `notifications.lastUserId` | string | User id (optional) |
| `notifications.lastUserName` | string | User name (optional) |
| `notifications.lastDirection` | string | Direction, e.g. enter/exit |
| `notifications.lastUnlockMethod` | string | Unlock method, e.g. card/pin |
| `notifications.lastTimestamp` | number | Epoch ms |

## UniFi Protect integration (optional)

If your UniFi Protect controller watches the same doors, the adapter can attach a snapshot (and a clip URL) to door events:

| Setting | Default | Notes |
|---|---|---|
| Enable Protect integration (`enableProtect`) | off | |
| Username / Password (`protectUsername` / `protectPassword`) | – | Local Protect account (cloud / UI accounts are **not** supported). The password is stored encrypted |
| Verify TLS certificate (`protectVerifyTLS`) | **off** | Enable only if the console has a valid certificate or its CA certificate is stored on the Connection tab. With the option on and a self-signed certificate the login is refused and a warning explains what to do |

The Protect API is contacted on the same host as UniFi Access, port 443 (`native.protectPort`, no field in the settings). A refused login (credentials, certificate) keeps the integration off until the instance is restarted; a rate-limited or not yet reachable console is retried with growing distance (30 s, 60 s, … up to 10 minutes).

State:

| State | Type | Notes |
|---|---|---|
| `info.protectConnected` | boolean | `true` once the Protect login succeeded |

When connected, snapshots are cached in memory (at most 50 entries / 32 MiB, oldest dropped first) and referenced from the matching event in `events.last` (`protectSnapshotUrl`, `protectVideoUrl`). Clips are streamed through the adapter. URLs are only written while the built-in HTTP server runs. The cache does not survive a restart: the snapshot URL of an older event then answers `404` and the status page shows "Not available" — never a current picture of the camera. The www status page shows the snapshot inline in the event log and offers the clip via a modal.

## Events

The last 50 events are stored in `events.last` (JSON array, newest first). Each entry carries `ts`, `source` (`'ws'` or `'webhook'`), `type`, optional `subtype` (doorbell end reason, unlock result, `open`/`close` of the door sensor), `deviceId`, `deviceName`, `doorId`, `doorName`, `userName`, `granted` (only `access.door.unlock`: whether access was granted), `thumbnailPath`, `protectSnapshotUrl`, `protectVideoUrl`, `raw`.

In `raw`, the WebRTC credentials of a doorbell call (`channel`, `token`) are removed and PIN or card values (`authentication_value`) are replaced by `"***"`.

**Event forwarding** (tab *Event forwarding*): each rule has an event type, an optional device id and a target state id. Every matching event is written as JSON (same format as an entry of `events.last`) with `ack: true` to the target state. A rule with a device id matches only events of exactly that device. Webhook-only events require the webhook receiver.

## sendTo() API

`sendTo('unifi-access.<i>', '<command>', payload, callback)`. Every message with a callback gets exactly one answer; failures are reported in a string field `error`. Requests that arrive while the instance is still starting wait up to 8 s for the first load of the controller state (`getConnectionStatus`, `listDevices`, `listUsers`, `reregisterWebhook`, `getServerInfo`).

| Command | Payload | Reply |
|---|---|---|
| `getConnectionStatus` | `{}` | `{connected, hasToken, lastError, controllerName, webhookRegistered}` |
| `verifyToken` | `{host, port, token, verifyTLS?, caCert?}` | `{ok:true, deviceCount}` / `{ok:false, error:'missing-fields'\|'unauthorized'\|'network'}` / `{ok:false, error:'tls', detail:'<certificate error code>'}` |
| `listDevices` | `{}` | `{devices: [{id, name, alias, type, model, firmware, online, capabilities, lastSeenAt}]}` |
| `listUsers` | `{}` | `{users: [{id, name}]}`, on failure `{users: [], error:'not-configured'\|'unauthorized'\|'network'}` |
| `reregisterWebhook` | `{}` | `{ok:true, id}` / `{ok:false, error}` with `not-configured`, `webhooks-disabled`, `receiver-not-running`, `unloading` (instance is stopping) or an error text |
| `getServerInfo` | `{}` | `{running, scheme, port, baseUrl, tlsEnabled, tlsActive, tlsError, publicBaseUrl}` — actual state of the built-in HTTP server (`scheme`/`baseUrl` are `null` while it does not run) |
| `getNetworkInterfaces` | `{}` | `{addresses: string[]}` (non-internal IPv4 addresses) |

`verifyToken` uses the values of the payload; a missing `verifyTLS` / `caCert` falls back to the stored configuration. The token is never logged. Unknown commands: `{ok:false, error:'unknown-command'}`.

Other adapter-managed read states under `info.*`: `info.connection` (controller reachable, follows the WebSocket), `info.webhookEndpointId`, `info.webhookRegistered` (actual state of this run), `info.protectConnected`. The webhook signing secret is stored encrypted in the instance configuration only.

## Web UI (status & control page)

The adapter ships a React-based web page available via the ioBroker web adapter under `/unifi-access/` (linked automatically from the admin instance list). `index.html?instance=1` shows another instance (default `0`). The page is in English.

Features:

- Controller status badge (live)
- Door list with unlock buttons, lock state, active temporary lock rule and a notice during lockdown/evacuation
- Last-event thumbnail preview (devices with thumbnails)
- Active doorbell call card (passive — points to the official app for answering)
- Recent-events log (`events.last`) with "Access denied" for refused attempts and, with UniFi Protect, the snapshot (short countdown while it is fetched, "Not available" if none came) plus a clip modal
- Settings drawer for layout tweaks (card visibility, thumbnail/snapshot size — stored in the state `admin.uiSettings`, shared by all browsers; only the light/dark choice is kept in the browser)

**Reverse proxy:** the page also works behind a reverse proxy with a path prefix (e.g. `https://proxy.example.com/iob/unifi-access/`). The proxy has to forward the whole web adapter including its `lib/` folder (`…/iob/lib/js/socket.io.js`) and the WebSocket connection. If the connection library cannot be loaded, the page says so. For thumbnails and camera pictures behind the same proxy, set the **Public base URL** of the HTTP server and forward the built-in server as well.

## Not supported

Intentionally **not** included:

- WebRTC live video, doorbell accept/reject, two-way audio — there are no documented endpoints in the UniFi Access Developer API (doorbell calls are shown passively)
- On-demand camera snapshots — the API only delivers thumbnails as part of events
- Triggering a doorbell, access method settings, writing user/visitor management
- Cloud login (UI account / OAuth) — only the local API token
- Automatic removal of doors and devices that disappeared from the controller (delete them manually if needed)
- Password protection of the media URLs (thumbnails, Protect snapshots/clips)

## Troubleshooting

- **`unauthorized` after entering the token** — make sure you copied the whole value. Tokens cannot be re-displayed in the UI; if in doubt, regenerate and re-paste. Also check the permission scopes of the token (see above); a missing permission is named in the log.
- **`network` error / `404` during bootstrap** — verify host/port/firewall. UA Ultra and UniFi OS consoles run UniFi Access on `12445` by default. A host/port that does not answer like the UniFi Access API is reported as `network`.
- **TLS validation errors** — the controller uses a self-signed certificate; TLS verification is off by default. Enable **Verify TLS certificate** only after pasting the controller CA into **CA certificate**. "Test connection" names the certificate problem (e.g. self-signed, host name mismatch).
- **Commands are reset immediately** — the controller is not connected (see the warning in the log) or the value is invalid.
- **WebSocket keeps reconnecting** — the controller may be terminating idle connections. Increase **WebSocket reconnect delay** to keep the back-off bounded.
- **"Webhook endpoint created but response did not include id/secret"** — the UniFi Access controller returned an unexpected response. Most common cause: UniFi Access older than **2.2.10** (minimum version for the webhook API).
- **Webhooks not arriving** — verify the webhook URL is reachable from the controller and that any reverse proxy passes both the body and the `Signature` header through unmodified. Set **Listen IP** or **Public base URL** explicitly instead of relying on the auto-detected first IPv4. The clock of the console and of the ioBroker host must not differ by more than 5 minutes.
- **HTTP server does not start** — with **Enable TLS** check the selected certificates (the log names the reason); otherwise check that the listen port is free.
- **UniFi Protect login failed** — only local Protect accounts work, not the cloud / UI account. Verify the credentials and that the Protect controller is reachable from the ioBroker host. After correcting the settings, the instance restarts and tries again.

## Disclaimer & Credits

See the main [README.md](README.md) for the credits list and disclaimer.

## License

MIT — see [README.md](README.md).
