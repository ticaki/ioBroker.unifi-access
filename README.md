![Logo](admin/unifi-access.png)
# ioBroker.unifi-access

[![NPM version](https://img.shields.io/npm/v/iobroker.unifi-access.svg)](https://www.npmjs.com/package/iobroker.unifi-access)
[![Downloads](https://img.shields.io/npm/dm/iobroker.unifi-access.svg)](https://www.npmjs.com/package/iobroker.unifi-access)
![Number of Installations](https://iobroker.live/badges/unifi-access-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/unifi-access-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.unifi-access.png?downloads=true)](https://nodei.co/npm/iobroker.unifi-access/)

**Tests:** ![Test and Release](https://github.com/ticaki/ioBroker.unifi-access/workflows/Test%20and%20Release/badge.svg)

## UniFi Access adapter for ioBroker

This adapter integrates Ubiquiti's UniFi Access platform with ioBroker. It uses the documented [UniFi Access Developer API](https://assets.identity.ui.com/unifi-access/api_reference.pdf) (also bundled in this repo at `.doc/api_reference.pdf`). Built around the **UA Ultra** standalone reader/hub/camera/doorbell, with basic integration for other UniFi Access devices (UA G2 Pro readers, UA G3 Pro doorbell, UA Hub). It can optionally pair with a UniFi Protect controller to enrich access events with camera snapshots and clip URLs, and ships a generic webhook receiver to bridge external alarm systems into ioBroker.

Capabilities exposed by the adapter:

- **Door unlock** — momentary pulse via `PUT /doors/:id/unlock`, or timed unlock for N minutes via `PUT /doors/:id/lock_rule`.
- **Emergency control** — `doors.emergency.lockdown` and `doors.emergency.evacuation` as read/write states (UniFi Access ≥ 1.24.6, written via `PUT /doors/settings/emergency`).
- **Live event stream** — UniFi Access WebSocket (`access.remote_view`, `access.remote_view.change`, `access.data.device.remote_unlock`) plus optional webhook receiver for the full event catalogue (`access.doorbell.incoming/.completed/.incoming.REN`, `access.door.unlock`, `access.device.dps_status`, `access.device.emergency_status`, `access.unlock_schedule.*`, `access.temporary_unlock.*`, `access.visitor.status.changed`).
- **Doorbell ringing notification** — passive: states show who is ringing and when. Accepting/rejecting calls is **not** part of this adapter — it requires WebRTC and is what the official UniFi Access mobile app is for.
- **Last-event thumbnail** — for UA Ultra, UA G3 Pro, UA G2 Pro, UA Intercom and every other device that delivers one, the adapter captures the `door_thumbnail` path from each event and exposes the latest image as a JPEG via a small built-in HTTP proxy (the controller serves it via `/system/static`, behind Bearer auth).
- **UniFi Protect integration (optional)** — links Protect cameras to access events, caching live snapshots and exposing them in the recent-events log alongside a clip URL.
- **Generic webhook receiver (optional)** — second HTTP endpoint with optional Basic/Bearer auth, lets external alarm systems push events into the adapter's `notifications.*` states.

Requires Admin 8.0.12 or newer and js-controller 6.0.11 or newer.

Explicitly **not** provided (because the UniFi Access Developer API has no endpoint for it): on-demand camera snapshots, doorbell accept/reject, two-way audio, WebRTC live video.

[![Deutsche Dokumentation](https://img.shields.io/badge/Doku-Deutsch-green?logo=readme)](README_GERMAN.md)

[![English documentation](https://img.shields.io/badge/docs-English-blue?logo=readme)](README_ENGLISH.md)


---

## Credits

- **[UniFi Access Developer API reference](https://assets.identity.ui.com/unifi-access/api_reference.pdf)** — official endpoint documentation provided by Ubiquiti.
- **[hjdhjd/unifi-access](https://github.com/hjdhjd/unifi-access)** — community Node.js client that maps out many of the developer-API quirks and was used as a reference for the WebSocket event format.

A big thank you to all contributors of these projects!


## Disclaimer

This adapter is an independent, community-developed open-source project. It is **not affiliated with, endorsed by, or in any way officially connected to Ubiquiti Inc.**

*UniFi*, *UniFi Access*, *UA Ultra* and all other Ubiquiti trademarks are the property of Ubiquiti Inc. All product names, logos, and brands are property of their respective owners. The use of these names is for identification purposes only.

The adapter accesses the UniFi Access controller using the same APIs that are used by Ubiquiti's own clients. Use of those APIs is subject to Ubiquiti's Terms of Service. By using this adapter, you agree to comply with all applicable Ubiquiti terms and conditions. The author accepts no liability for any misuse of the adapter.


## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
- (ticaki) changed: the settings page requires Admin 8.0.12 or newer (custom components adapted to Admin 8, settings page and status page updated to current React and MUI versions)
- (ticaki) changed: existing installations — "Verify TLS certificate" on the Protect tab is now effective and off by default; with a saved "on" and a self-signed console certificate there are no Protect snapshots until the option is switched off or the CA certificate is stored (a warning explains this)
- (ticaki) changed: existing installations — a stored plain-text Protect password is encrypted at the first start (one additional instance restart)
- (ticaki) changed: existing installations — the built-in HTTP server (port 8095) is only opened when the webhook receiver, the thumbnail server, the Alarm Manager webhook or UniFi Protect is enabled
- (ticaki) changed: existing installations — "Enable TLS" really serves HTTPS with the certificates from the ioBroker certificate store; if they cannot be loaded the server is not started at all (no fall-back to plain http) and the reason is logged
- (ticaki) changed: existing installations — the Alarm Manager webhook rejects every request when Basic or Bearer authentication is selected without stored credentials, and its path must not be one of the adapter's own paths (/unifi-access-webhook, /unifi-access/…)
- (ticaki) changed: existing installations — the state info.webhookSecret is removed; the webhook secret is kept encrypted in the instance configuration only and no longer appears in the debug log
- (ticaki) changed: existing installations — the webhook endpoint at the controller is named after instance, ioBroker host and installation (renamed in place at the first start); only endpoints of this installation are changed or removed, so two installations at the same controller no longer remove each other's endpoint
- (ticaki) changed: existing installations — door and emergency commands are refused while the controller has not been loaded yet or the connection is lost; invalid values (unlock_duration outside 0–600 minutes, lock_rule outside 0–4, non-boolean switches) are rejected; in both cases the state is reset and a warning names the reason
- (ticaki) changed: existing installations — PIN or card values (authentication_value) are shown as "***" in events.last and in forwarded events
- (ticaki) changed: existing installations — the snapshot URL of a Protect event recorded before a restart answers 404 (the panel shows "Not available") instead of a current camera picture
- (ticaki) changed: existing installations — "Test connection" reports the number of devices found instead of a controller name
- (ticaki) changed: the public base URL and the Alarm Manager path are checked in the settings; an unusable saved value has to be corrected before the settings can be saved again
- (ticaki) changed: API token and Alarm Manager bearer token are masked in the settings
- (ticaki) changed: system logs are only queried when the UniFi Protect integration is active; Protect video clips are streamed instead of being loaded into memory
- (ticaki) new: optional public base URL for the built-in HTTP server (reverse proxy, port forwarding) — used for the webhook registration and all thumbnail and camera URLs
- (ticaki) new: states doors.<id>.lockRuleType and doors.<id>.lockRuleEndsAt show the active temporary lock rule; lock_rule value 4 (lock_early) ends an active unlock schedule early
- (ticaki) new: UA Lite, UA Intercom and further hub models are recognised; UA G2 Pro readers get the doorbell and thumbnail functions
- (ticaki) new: configurable unlock actor — select a UniFi Access user whose name appears in controller logs and webhooks when ioBroker opens a door with a pulse unlock
- (ticaki) new: button "Re-register webhook" on the HTTP server tab; it explains why it cannot work (receiver off, server not running, host or token missing)
- (ticaki) new: door unlock events carry "granted"; the status page shows refused attempts as "Access denied"
- (ticaki) new: the status page shows the active temporary lock rule and a lockdown/evacuation notice, offers the last event image for UA G2 Pro and UA Intercom, and can show another instance with index.html?instance=1 (the instance link opens the right one)
- (ticaki) new: full translations of the settings page in es, fr, it, nl, pl, pt, ru, uk and zh-cn
- (ticaki) fixed: info.connection follows the WebSocket; dead WebSocket connections are detected and re-established, devices and doors are reloaded after a reconnect (but not every few seconds for a flapping connection)
- (ticaki) fixed: API errors that the controller reports with a successful HTTP status (e.g. "device offline" on unlock) are recognised; a host/port that does not answer like the UniFi Access API is reported instead of "connected, 0 devices"
- (ticaki) fixed: the CA certificate field is multi-line; a pasted certificate that lost its line breaks still works, an unusable one is reported; it is trusted in addition to the system CAs, is also used when only Protect verifies TLS, and "Test connection" uses the value entered in the form and names certificate problems (e.g. host name mismatch)
- (ticaki) fixed: far fewer repeated log entries while the controller is unreachable or requests to the built-in server fail; missing API token permissions are named in the log
- (ticaki) fixed: door position (open/close) is taken from the documented field of the door sensor event and no longer shown as "unknown" after every change
- (ticaki) fixed: the "locked" state is read back from the controller after unlocks, lock rules and schedule events; a refused access attempt is no longer reported as an unlocked door; the end of a timed unlock is checked also after a restart and for rules set in the UniFi app; a lock rule one door cannot report no longer stops the status of all doors
- (ticaki) fixed: a failed emergency command no longer leaves the requested lockdown/evacuation value standing
- (ticaki) fixed: the active doorbell call is cleared when it was answered, declined, cancelled or the door was opened by an admin (also when only the webhook reports it), at start and at the latest 3 minutes after a call without end event; a late webhook or the end of an earlier call no longer replaces or clears a call that is still ringing
- (ticaki) fixed: webhook registration no longer causes a restart loop; the controller's "endpoint duplicated" answer is handled; an existing endpoint is updated in place when its URL or event list changes (same secret, no restart)
- (ticaki) fixed: the webhook is registered as soon as the controller becomes reachable and checked after every reconnect and every 15 minutes; an endpoint the controller lost (e.g. after restoring a backup) is registered again
- (ticaki) fixed: "Re-register webhook" during the periodic registration check could restore the old secret (all webhooks were then rejected)
- (ticaki) fixed: stopping or restarting the instance while it was starting or waiting for the controller could leave the HTTP server running ("address in use" at the next start) or still create a webhook endpoint or write states afterwards
- (ticaki) fixed: events arriving at the same time are no longer lost in events.last; a remote unlock is logged once even if the webhook arrives before the WebSocket event; devices are no longer shown as offline after a webhook event
- (ticaki) fixed: the thumbnail proxy only serves validated image paths; the URL of the last event image is cleared while the thumbnail server is off and rebuilt after port, listen address or TLS were changed
- (ticaki) fixed: Protect login is retried with growing distance (30 s, 60 s, … up to 10 min) when the console is rate-limited or not reachable yet; logins are no longer repeated for every media request; aborted clip requests no longer leave connections open; a login that completes after the instance stopped no longer shows "Protect connected"
- (ticaki) fixed: camera pictures are attached only to the door event they belong to
- (ticaki) fixed: the Alarm Manager webhook answers a path without leading slash where the settings show it and accepts the Basic/Bearer scheme name in any upper/lower case; custom headers of other webhook integrations are masked in the debug log
- (ticaki) fixed: the Alarm Manager URL in the settings shows the scheme, path, port and public base URL the adapter really uses, explains when the server is not running or TLS could not be activated, says when changes are not saved yet, and its copy button works when admin is opened via http
- (ticaki) fixed: settings page — the selected unlock actor is shown again after reopening, the complete user list is read on larger installations, no endless loading or "no devices" while the instance is stopped or still starting, missing translations added, about 7 MB less to download, the capability chip "event thumbnail" is readable in the dark theme, the public base URL can be saved in older browsers
- (ticaki) fixed: status page — no door named "emergency", the connection badge follows a lost and restored connection, no blank page with invalid events, a door with unknown lock state is no longer shown open, the doorbell card ignores invalid values, the snapshot countdown runs exactly 3 seconds independent of the browser clock and only for events that just arrived, "Not available" only when Protect is connected
- (ticaki) fixed: status page — its settings (admin.uiSettings) can be stored and are no longer overwritten or flipped back, switches and sliders no longer flicker, device selection and event snapshots work with keyboard and screen reader and keep a visible focus
- (ticaki) fixed: status page — it connects also behind a reverse proxy with a path prefix (e.g. /iob/unifi-access/) and says when the socket library of the web adapter cannot be loaded

### 0.0.2 (2026-05-03)
- (ticaki) Aligned API integration with the documented UniFi Access Developer API: removed undocumented snapshot/doorbell-call endpoints, switched timed door unlock to lock_rule, added a webhook receiver (HMAC-validated) for the full event catalogue, replaced polled snapshots with an event-driven last-thumbnail card.

### 0.0.1 (2026-05-02)
- (ticaki) initial release

## License
MIT License

Copyright (c) 2026 ticaki <github@renopoint.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
