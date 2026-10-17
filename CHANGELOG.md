# Changelog

Notable changes to **ns-callflow-viewer**.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Which version am I running?** `GET /health` on your deployment reports it:

```json
{ "ok": true, "configured": true, "version": "0.1.0", "scope": "default" }
```

## [0.2.0] — 2026-10-17

### Changed

- **Diagrams are drawn by [Pele](https://github.com/obsidianmd/pele) instead of Mermaid.** Pele reads the
  same Mermaid text but lays it out and measures labels itself, so labels no longer clip. It loads from
  jsDelivr pinned with Subresource Integrity, through `@dszp/netsapiens-lib` 0.14.0, and its output passes
  through the library's SVG sanitizer before it reaches the page.
- **PNG and SVG downloads use the library's exporters.** A light theme exports on white, a dark one on its
  diagram background, and the SVG opens correctly outside a browser.
- Themes still switch node colors and the page's light/dark chrome. The hand-drawn theme now draws as its
  plain palette, since Pele has no hand-drawn style.
- Requires `@dszp/netsapiens-lib` 0.14.0 (was 0.1.x). The jump also brings the library's fix for domains
  with more than 100 users or numbers, which were missing entries in diagrams and entity lists.

### Removed

- **The ELK layout toggle.** Pele has its own layout engine. This also removes the one script the viewer
  loaded without Subresource Integrity: ELK's plugin, an on-demand import from jsDelivr.

## [0.1.0] — 2026-08-09

Initial release. Extracted from a combined NetSapiens portal toolkit, where this viewer had been one of
two products sharing a Worker with two different security models: a stored credential answering every
request here, and per-caller delegated tokens there. The same two environment variables were mandatory
in one mode and destructive in the other, and nothing in the code said so. They are now two repos.

### What this is

- **Call-flow diagrams resolved live** from the NetSapiens API — DID → time-of-day → auto-attendant menu
  → queue → agents → voicemail or an external number. Nothing is stored, so a diagram cannot be stale.
- **A viewer** with pan/zoom, a system-following theme picker, and a layout toggle between two graph
  engines.
- **Export** as SVG, PNG, or Mermaid source.
- **Optional enrichment** on agent lines: desk-phone model and registration (`NS_DEVICE_DETAILS`), and
  softphone app presence (`RINGOTEL_API_KEY` + `RINGOTEL_PRESENCE`).
- **A setup checklist** at `/` naming exactly which settings are unset, and `GET /health` answering the
  same question as JSON. Both report only *whether* a value is present, never what it is.
- **An offline CLI** (`pnpm flow <snapshot.json> gallery`) for rendering from a saved snapshot.

### Changed from the combined deployment

- **The stored credential is `NS_API_KEY`** (it was `NS_API_TOKEN`). After the split each repo holds
  exactly one stored credential, so the `TOKEN`/`KEY` pair implied a mechanical difference that never
  existed — both are bearer tokens for the same service, sent as-is. **An existing deployment must
  `wrangler secret put NS_API_KEY` before cutting over.** The old name is not read and does not warn at
  deploy time; the setup page detects it and says so, but only once you open the page.
- **State the privilege this deployment wants:** broad fleet **read**, and read-only if your platform
  will issue such a key. It only ever reads. A shared name invites a shared value, which is the reason
  the rename happened with the split rather than after it.
- **The portal-backend half is gone entirely** — no injected script, no delegated tokens, no operator
  console, no writes. A deployment that used those wants the portal kit instead.
- **Three settings no longer exist here** because nothing reads them: the portal issuer host, the JWT
  rate-limiter binding, and the CORS origin allowlist. Each served the delegated-token path or a
  cross-origin caller, and this Worker serves its own viewer, same-origin. A documented setting that
  does nothing is the failure mode this split existed to remove.

### Security

- **The stored credential is refused until something verifiable is in front of it.** With `NS_API_KEY`
  set and no Cloudflare Access configured, the Worker serves setup instructions instead of data. That is
  enforced, not advised.
- **Both `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`, or neither.** One alone cannot verify anything, so a
  half-configured gate is treated as no gate — and the credential stays refused rather than being served
  by a deployment that reports itself protected.
- **The Access JWT is verified in-Worker**, not assumed from routing, so a `*.workers.dev` URL or a route
  the Access application does not cover is refused too.
- **The exposure gate applies to the data routes as well as the HTML** — a 403 on the page and a 200 on
  the JSON would be the whole vulnerability with a friendly page in front of it.
- **Domains are normalized before comparison**, so a mixed-case or trailing-dot variant cannot slip an
  allow- or block-list.
- **A boundary selftest** fails the suite if a portal concept appears in `src/`, so the two security
  models cannot silently recombine.
