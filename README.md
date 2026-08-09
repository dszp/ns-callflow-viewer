# ns-callflow-viewer

Live **call-flow diagrams for NetSapiens**, as a tool you open. Runs on Cloudflare Workers; bring your own
NetSapiens token and Cloudflare account.

Pick a domain, pick an entity — a DID, an auto attendant, a call queue, a user — and it resolves that
entity's routing from the API and draws it: DID → time-of-day → auto-attendant menu → queue → agents →
voicemail or an external number. Nothing is stored, so the diagram cannot be stale.

> ### 📖 Read **[SETUP.md](./SETUP.md)** first — before you deploy.
> It is short, and it covers the one thing the deploy form cannot tell you: this deployment holds a
> **stored NetSapiens credential** that answers every request reaching it, so the perimeter in front of it
> is the whole security model. The Worker enforces that — it refuses to use the token until an access gate
> is configured — but you should know why before you meet the refusal.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dszp/ns-callflow-viewer)

That clones this repo into **your own** GitHub account and deploys to **your own** Cloudflare. No bindings
to provision (no KV, R2, D1, or Durable Objects), so it deploys clean.

**It needs nothing from your Manager Portal.** No injected JavaScript, no platform setting, no request to
your provider, nothing installed for your users. If you are a reseller under another carrier, this works
on day one without anyone else's cooperation — which is the main reason to run it.

## What you get

- **Diagrams resolved live** from the NetSapiens API, per view — not a stored picture, and not a drawing
  that was accurate the day someone made it.
- **A viewer built for reading them** — scroll pans, Ctrl/⌘+scroll zooms, a theme picker that follows your
  system light/dark setting, and a layout toggle between two graph engines for when a dense diagram lays
  out badly under one of them.
- **Export** — SVG, PNG, or the **Mermaid source**, which drops into any document system that renders
  Mermaid and stays editable. A diagram that cannot leave the tool ends up redrawn by hand for the customer
  document, which is exactly the artifact this replaces.
- **Optional enrichment on agent lines** — desk-phone model and registration status, and softphone app
  presence. "The queue rings four agents, two of whom have no registered device" is a different answer to
  the same question.
- **A setup page that tells you what is missing** — open `/` on an unfinished deployment and it lists
  exactly which settings are unset, with the fix for each. It reports only *whether* a value is present,
  never what it is.

## Quick start

**Try it locally first** — no Cloudflare Access, no Zero Trust setup, nothing to provision:

```bash
git clone https://github.com/dszp/ns-callflow-viewer && cd ns-callflow-viewer
pnpm install
cp .dev.vars.example .dev.vars     # add your NS_API_KEY
npx wrangler dev                   # -> http://localhost:8787
```

The viewer runs against your live NetSapiens data. Local `wrangler dev` is exempt from the access gate,
because it is not internet-reachable — which is exactly why this step is safe and the deployed equivalent
is not. Fastest way to find out whether this is useful to you.

Then, for a real deploy:

```bash
# 1. edit wrangler.jsonc -> vars
#    NS_SERVER            your NetSapiens API host
#    ACCESS_AUD           your Cloudflare Access application's AUD tag
#    ACCESS_TEAM_DOMAIN   yourteam.cloudflareaccess.com
#    also: "workers_dev": false, once you have a route

# 2. the token
wrangler secret put NS_API_KEY

# 3. deploy
pnpm run deploy     # `run` matters: bare `pnpm deploy` is a pnpm builtin, not this script
```

**Not sure what's missing?** Open `/` and it tells you, or `GET /health` for the same answer as JSON.

## The one thing to understand

There is no per-user login here. **Whoever opens the URL gets whatever the token can read** — and a
reseller-scoped token can read your whole fleet. That is not a flaw to work around; it is the design that
makes a single-user internal tool this easy to run. It does mean the perimeter is the entire security
model.

So the Worker **refuses to use the token at all** until something verifiable is in front of it: set
`ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` and it verifies the Cloudflare Access JWT **itself**, against your
team's signing keys — so a request that skipped Access, or arrived on a route Access does not cover, is
refused too. Both values or neither; one alone leaves the check inert and the token still refused.
`ALLOW_UNGATED_SERVICE_TOKEN=1` exists for a deployment with its own mTLS, WAF or authenticating proxy in
front, and is not a way to silence the refusal.

Bound it further with `ALLOWED_DOMAINS`, which refuses any domain not on the list even though the token
could read it. It is the cheapest bound on the blast radius of a broadly scoped token, and the only one
that does not depend on your platform issuing you a narrower credential.

## Configuration

A working deployment needs **three** things:

| Setting | Where | What |
|---|---|---|
| `NS_SERVER` | `vars` in `wrangler.jsonc` | your NetSapiens API host, e.g. `api.example.com` |
| `NS_API_KEY` | secret | a NetSapiens API token — read-only, if your platform will issue one |
| `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` | `vars` | your Cloudflare Access application. Both, or the token is refused |

Everything else is **optional and off unless set** — domain scoping, branding, device details, app
presence.

**→ [CONFIG.md](./CONFIG.md) defines every setting**: what it means, what a valid value looks like, and
whether it belongs in `vars`, a secret, or a binding.

**Branding is config, never source.** Unset, you get the neutral `ns-portal` theme (the stock NetSapiens
scheme).

## Also offline

There is a CLI for rendering from a saved snapshot rather than the live API:

```bash
pnpm flow <snapshot.json> gallery   # -> out/*.gallery.html
```

## Built on

- [`@dszp/netsapiens-lib`](https://github.com/dszp/netsapiens-lib) — the portable NetSapiens toolkit
  (API client, `ns_t` validation, resolver, renderers). The resolver, the Mermaid emitter and the HTML
  renderers all live there, so this repo is a thin layer over a library maintained anyway.
- [`@dszp/ringotel-lib`](https://github.com/dszp/ringotel-lib) — the portable Ringotel AdminAPI toolkit,
  used only for the optional app-presence enrichment.

Both are Node-free and run unchanged in a Worker, in Node, or the browser.

## Docs

- **[SETUP.md](./SETUP.md)** — what you get, what it needs, and how to deploy it. Start here.
- **[CONFIG.md](./CONFIG.md)** — the settings reference: every value, its default, and what happens when
  you leave it out.
- **[AGENTS.md](./AGENTS.md)** — deploying this, written for a coding agent.

## License

[MIT](./LICENSE) © David Szpunar
