# ioBroker.unifi-access — neuer Adapter für Ubiquiti UniFi Access

Hi zusammen,

ich werkele gerade an einem neuen Adapter für **UniFi Access** und wollte ihn euch mal zeigen, bevor er im offiziellen Repo landet. Schwerpunkt liegt auf der **UA Ultra**, die anderen Türleser/Hubs (G2 Pro, G3 Pro, UAH) werden mit dem unterstützt, was die Developer-API hergibt.

## Was er kann

- Verbindung zum UniFi-Access-Controller per API-Token (lokal, ohne Cloud-Login)
- Live-Events per WebSocket: Klingelrufe, Remote-Unlocks, Status-Wechsel
- Optionaler Webhook-Empfänger (HMAC-signiert) für den vollen Event-Katalog: Türsensoren, Notfall-Status, Visitor-Status, Schedules, Doorbell-Calls
- Türen entriegeln aus ioBroker — wahlweise als kurzer Puls (`/doors/:id/unlock`) oder zeitgesteuert über `lock_rule` (Minuten)
- Last-Event-Thumbnail pro Gerät: der Adapter holt das letzte Klingel-/Türbild vom Controller und stellt es im www-Panel und als JPEG-URL bereit
- Kleines www-Panel mit Türliste, Status-Badge, letztem Bild und Live-Event-Log
- Admin-UI komplett über jsonConfig + zwei Custom-Components (Verbindungstest, Geräte-Übersicht mit Capability-Chips)
- Geräteweiten Lockdown/Evakuierung über die Emergency-States, falls ihr das mal braucht

## Was er bewusst NICHT kann

Damit ihr keine falschen Erwartungen habt — die UniFi-Access-Developer-API gibt das schlicht nicht her:

- Kein Live-Video / WebRTC-Stream — Klingelrufe seht ihr nur passiv (Caller-ID, Zeitpunkt). Annehmen/Ablehnen geht weiterhin nur über die offizielle UniFi-Access-App.
- Kein On-Demand-Snapshot — Bilder gibt's nur, wenn ein Event sie liefert.
- Kein Two-Way-Audio.
- User/Visitor-Verwaltung ist read-only.

## Voraussetzungen

- UniFi-Access-Controller (z. B. UA Hub, UNVR oder Cloud Key) mit aktivierter Developer-API
- Ein API-Token (in den Controller-Einstellungen erzeugen)
- ioBroker mit `js-controller >= 6.0.11` und `admin >= 7.6.20`
- Für Webhooks und Thumbnails: ein erreichbarer HTTP(S)-Port — wenn der ioBroker hinter einem Reverse-Proxy steht, kann die `Public URL` separat gesetzt werden

## Status

Stand jetzt **Pre-Release (0.0.2)**, läuft bei mir im Alltag stabil. Ich hänge gerade an den letzten Aufräumarbeiten, bevor der PR ins zentrale Sources-Repo geht. Heißt: wer Bock hat, kann's gerne testen — Feedback, Bug Reports und Logs sind sehr willkommen, gerade von Leuten mit anderer Hardware als der UA Ultra.

## Wo

GitHub: https://github.com/ticaki/ioBroker.unifi-access

Installation für Tester: in der ioBroker-Admin unter „Adapter" → Katalog → das Oktokat-Symbol → Repo-URL einfügen.

Issues und PRs gerne direkt drüben auf GitHub. Ich freu mich über jede Rückmeldung — auch „läuft bei mir auf Modell XY" hilft, weil ich nicht jede Hardware-Kombination selbst testen kann.

Cheers,
ticaki
