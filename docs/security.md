> [← Back to README](../README.md) · [All documentation](README.md)

# Security notes

- All AI inference is local — no API keys, no data sent to any third-party model provider.
- The Gmail app password lives only in `config.json`, on-device, and that file is git-ignored.
- Network traffic Aigentik generates: Gmail IMAP/SMTP; local calls to `llama-server` on `127.0.0.1`; outbound calls to the Restoricon Core API (`do-not-contact.js`, `email-rules.js`, and other write-through modules, bearer-authenticated via `config.core_api.token`); and an internal HTTP server of its own on `127.0.0.1:8081` (`http-server.js`) that `restoricon_core/services/notification_service.py` calls to send email/calendar invites/cancellations — bearer-authenticated via a locally-generated shared secret (WP0.1, 2026-10-07) and gated on the do-not-contact list before any send. Before WP0.1 this server had no authentication at all (`NEW-764`).
- TLS 1.2+ is enforced on both IMAP and SMTP connections, with certificate validation on.
- SMTP has file and URL attachment access disabled outright (reduces SSRF/local-file exposure); emails and replies sent to third parties also carry auto-responder-suppression headers, to reduce the risk of triggering auto-reply loops with other bots.
- IMAP reconnects automatically on connection loss, with exponential backoff and jitter, up to a built-in retry limit (10 attempts by default — this is a code-level default, not currently exposed in `config.json`).

See [Configuration reference](configuration.md) for where credentials live, and [Installation](installation.md) for how `config.json` gets created (never checked into git).

---

[← Back to README](../README.md) · [All documentation](README.md)
