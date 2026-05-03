# ioBroker.unifi-access

## UniFi Access adapter for ioBroker

This adapter connects ioBroker to your **Ubiquiti UniFi Access** controller using the documented [UniFi Access Developer API](https://assets.identity.ui.com/unifi-access/api_reference.pdf) (also bundled in this repo at `.doc/api_reference.pdf`). Designed around the **UA Ultra** standalone device; the same code paths cover other UniFi Access models. Optional integrations let you pair a UniFi Protect controller (camera snapshots + clip URLs on access events) and expose a second webhook endpoint for external alarm systems.

## Supported devices

| Model | Door unlock | Live events (WebSocket) | Event thumbnails | Doorbell ring (passive) |
|---|:---:|:---:|:---:|:---:|
| **UA Ultra** | ✅ | ✅ | ✅ | ✅ |
| UA G3 Pro Doorbell | ✅ | ✅ | ✅ | ✅ |
| UA G2 Pro reader | ✅ | ✅ | ✅ | – |
| UA Hub | – | ✅ | – | – |
| Other models | basic | basic | – | – |

If you have one of the basic-support models and find a missing function, please open an issue.

## Prerequisites — generating the API token in UniFi Access

1. Open the UniFi Access UI on your controller (typically `https://<controller>:12445/`).
2. Go to **Settings → Security → Advanced → API Token**.
3. Click **Create Token**, give it a descriptive name (e.g. `ioBroker`) and copy the value.
4. The token is shown **only once** — store it safely.

The adapter uses this token both for HTTPS API calls (`Authorization: Bearer <token>`) and for the WebSocket event stream.

## Configuration

Open the adapter instance configuration in the ioBroker admin UI. The settings are split into six tabs:

| Tab | Purpose |
|---|---|
| **Connection** | Controller host/IP, port (default `12445`), API token, optional TLS verification + CA, WebSocket reconnect delay. The embedded `AuthSetup` custom component probes the controller and lets you verify the token before saving. |
| **Devices & Doors** | Auto-discovered UniFi Access devices with capability chips, plus the default unlock duration. |
| **HTTP server** | Single shared HTTP(S) listener for the UniFi webhook receiver, the thumbnail proxy and the generic webhook (default port `8095`, listen IP, optional TLS, plus toggles to enable/disable each individual handler). |
| **Alarm Manager** | Second webhook endpoint for external systems (alarm panels, hubs). Configurable path and `none`/`basic`/`bearer` authentication; the `GenericWebhookUrl` component shows ready-to-paste URLs with a copy button. |
| **UniFi Protect** | Optional integration: username/password/TLS verification for a UniFi Protect controller. |
| **Event forwarding** | Map UniFi event types to arbitrary ioBroker target states (optional). |

> **TLS note:** the `Enable TLS` toggle in the **HTTP server** tab does not yet load certificates from the ioBroker certificate store. Until that path is wired up, leave the toggle off and put a reverse proxy in front of the listener if you need HTTPS.

## Door control

For every door discovered, the adapter creates a channel under `unifi-access.<i>.doors.<doorId>` with these states:

| State | Type | Direction | Notes |
|---|---|---|---|
| `name` | string | read | Human-readable door name |
| `fullName` | string | read | Full path including floor/controller |
| `locked` | boolean | read | `true` = locked, `false` = unlocked, `null` = unknown |
| `position` | string | read | `open` / `close` / `unknown` (sensor-dependent) |
| `isBindHub` | boolean | read | Door is bound to a hub (required for remote unlock) |
| `unlock` | boolean | write | Setting it to `true` unlocks the door |

`defaultUnlockDuration = 0` sends a momentary unlock via `PUT /doors/:id/unlock`. Any value above 0 is rounded up to whole minutes and applied via `PUT /doors/:id/lock_rule {type:"custom", interval}`.

### Emergency states

In addition to per-door control the adapter exposes the controller-wide emergency switches under `doors.emergency.*` (UniFi Access ≥ 1.24.6, applied via `PUT /doors/settings/emergency`):

| State | Type | Direction | Notes |
|---|---|---|---|
| `doors.emergency.lockdown` | boolean | read/write | Lock down all doors |
| `doors.emergency.evacuation` | boolean | read/write | Release all doors (evacuation) |

## Doorbell calls (UA Ultra / UA G3 Pro)

When a doorbell rings, the adapter shows the active call passively:

| State | Type | Notes |
|---|---|---|
| `doorbell.activeCallId` | string | Object id of the ringing event, `null` if none |
| `doorbell.activeFromDevice` | string | Originating door / device |
| `doorbell.activeStartedAt` | number | Epoch milliseconds |

There is **no accept/reject** in the adapter — the UniFi Access Developer API has no endpoint for that. Use the official UniFi Access mobile app to actually answer the call.

## Event thumbnails (UA Ultra / UA G3 Pro / UA G2 Pro)

The Developer API does not provide on-demand snapshots, but every event payload (WebSocket or webhook) carries a `door_thumbnail` path. The adapter records the latest such path per device:

| State | Type | Notes |
|---|---|---|
| `devices.<id>.lastThumbnailPath` | string | Path returned by the controller (relative) |
| `devices.<id>.lastThumbnailAt` | number | Epoch milliseconds of the event |
| `devices.<id>.lastThumbnailUrl` | string | URL served by the adapter's thumbnail proxy (only set when **Enable thumbnail server** is on) |

Other per-device states populated during bootstrap and from live events: `name`, `alias`, `type`, `model`, `firmware`, `online`, `lastSeenAt`.

When **Enable thumbnail server** is enabled, the adapter exposes the latest image as JPEG at `<scheme>://<adapter-host>:<listenPort>/unifi-access/<i>/thumbnail/<deviceId>.jpg`. Internally it fetches the underlying image from `/api/v1/developer/system/static/<path>` (Bearer-authenticated), so the browser does not need the controller credentials.

## Webhook receiver

The WebSocket only carries doorbell ringing/state-change and admin remote-unlock events. To receive `access.door.unlock`, `access.device.dps_status`, `access.device.emergency_status`, `access.unlock_schedule.*`, `access.temporary_unlock.*`, `access.visitor.status.changed` and the doorbell webhook variants, enable the webhook receiver:

1. **HTTP server → Enable webhook receiver**.
2. Check **Listen port** (default `8095`) and **Listen IP** (default `0.0.0.0`).
3. Save. The adapter derives the public URL from those server settings (`<scheme>://<listenIp-or-first-non-internal-IPv4>:<listenPort>/unifi-access-webhook`), calls `POST /api/v1/developer/webhooks/endpoints`, persists the returned secret and from then on validates every incoming POST via HMAC-SHA256 over `<unix>.<rawBody>` using that secret.
4. If the controller can't reach the auto-detected URL (NAT, multi-homed host, reverse proxy), set **Listen IP** explicitly to the address the controller can reach.

The webhook path is fixed at `/unifi-access-webhook`. Registered events: `access.doorbell.incoming`, `access.doorbell.completed`, `access.doorbell.incoming.REN`, `access.device.dps_status`, `access.door.unlock`, `access.device.emergency_status`, `access.unlock_schedule.activate`, `access.unlock_schedule.deactivate`, `access.temporary_unlock.start`, `access.temporary_unlock.end`, `access.visitor.status.changed`.

If you ever need a fresh secret (lost backup, leaked secret), trigger a re-registration via the `reregisterWebhook` sendTo command from the admin UI.

## Alarm Manager (generic webhook)

The **Alarm Manager** tab opens a second HTTP endpoint on the same shared listener for external systems — alarm panels, smart-home hubs, custom scripts. It accepts arbitrary JSON POSTs and writes the parsed payload into a dedicated state branch.

Configuration:

- `enableGenericWebhook` — master toggle.
- `genericWebhookPath` — URL path (default `/webhook`).
- `genericWebhookAuth` — `none`, `basic` or `bearer`. Basic auth uses `genericWebhookUsername`/`genericWebhookPassword`; bearer uses `genericWebhookToken`.

The embedded `GenericWebhookUrl` component lists ready-to-copy URLs for each network interface so you can paste them into the upstream system.

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

If your UniFi Protect controller watches the same doors, the adapter can attach a snapshot (and a clip URL) to every relevant access event:

- `enableProtect` — master toggle.
- `protectUsername` / `protectPassword` — local Protect account (cloud accounts are **not** supported).
- `protectVerifyTLS` — verify the Protect controller's certificate.

State:

| State | Type | Notes |
|---|---|---|
| `info.protectConnected` | boolean | `true` once the Protect login succeeded |

When connected, snapshots are cached in memory (FIFO, max 50 entries) and referenced from each event in `events.last`. The www status page shows the snapshot inline in the event log and offers a clip URL via a modal.

## Events & sendTo() API

The last 50 events are stored in `events.last` (JSON array). Each entry carries `ts`, `source` (`'ws'` or `'webhook'`), `type`, optional `deviceId`, `deviceName`, `doorId`, `doorName`, `userName`, `thumbnailPath`, `protectSnapshotUrl`, `protectVideoUrl`, `raw`.

`sendTo` commands accepted by the adapter:

| Command | Payload | Reply |
|---|---|---|
| `getConnectionStatus` | `{}` | `{connected, hasToken, lastError, controllerName, webhookRegistered}` |
| `verifyToken` | `{host, port, token, verifyTLS?}` | `{ok, error?, controllerName?}` |
| `listDevices` | `{}` | `{devices: [...]}` |
| `reregisterWebhook` | `{}` | `{ok, id?}` / `{ok:false, error}` |
| `getNetworkInterfaces` | `{}` | `{interfaces: [{name, addresses[]}]}` (used by the Alarm Manager URL display) |

Other adapter-managed read states under `info.*`: `info.connection` (controller online), `info.webhookEndpointId`, `info.webhookSecret`, `info.webhookRegistered`, `info.protectConnected`.

## Web UI (status & control page)

The adapter ships a React-based web page available via the ioBroker web adapter under `/unifi-access/` (linked automatically from the admin instance list).

Features in v1:

- Controller status badge (live)
- Door list with unlock buttons
- Last-event thumbnail preview (UA Ultra / UA G3 Pro / UA G2 Pro)
- Active doorbell call card (passive — points to the official app for answering)
- Recent-events log (`events.last`) with optional UniFi Protect snapshot + clip-URL modal
- Settings drawer for local layout tweaks (card visibility, thumbnail/snapshot size — stored in the browser's `localStorage`, not in ioBroker)

WebRTC live video, doorbell accept/reject and on-demand camera snapshots are intentionally **not** included — there are no documented endpoints in the UniFi Access Developer API for them.

## Troubleshooting

- **`unauthorized` after entering the token** — make sure you copied the whole value, including any leading/trailing characters. Tokens cannot be re-displayed in the UI; if in doubt, regenerate and re-paste.
- **`network` error / `404` during bootstrap** — verify host/port/firewall. UA Ultra and UniFi OS consoles run UniFi Access on `12445` by default. The controller responds to `GET /api/v1/developer/devices`; anything else is not a UniFi Access endpoint.
- **TLS validation errors** — the controller uses a self-signed certificate. The adapter disables TLS verification by default. Enable `Verify TLS certificate` only after pasting the controller CA into `CA certificate`.
- **WebSocket keeps reconnecting** — the controller may be terminating idle connections. Increase `WebSocket reconnect delay` to keep the back-off bounded.
- **Webhooks not arriving** — verify the public URL is reachable from the controller (try `curl -X POST <public-url>` from the controller's host) and that any reverse proxy passes both the body and the `Signature` header through unmodified. If the controller logs "endpoint unreachable", set **Listen IP** explicitly instead of relying on the auto-detected first IPv4.
- **UniFi Protect login failed** — only local Protect accounts work, not the cloud / UI account. Verify the credentials and that the Protect controller is reachable from the ioBroker host.

## Disclaimer & Credits

See the main [README.md](README.md) for the credits list and disclaimer.

## License

MIT — see [README.md](README.md).
