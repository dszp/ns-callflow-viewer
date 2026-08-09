# Setup

**NS Call-Flow Viewer** is a standalone tool you open: point it at your NetSapiens server, give it a
token, put Cloudflare Access in front of it, and you get live call-flow diagrams for any domain that token
can read.

It has no dependency on anything inside your Manager Portal. You do not need to inject JavaScript, you do
not need your provider to change a portal setting, and there is nothing to install for your users. That is
the whole point of this deployment shape: it works on day one, for one person, without anyone else's
cooperation.

Setup is three things: two values and a token, a gate in front, and a deploy.

---

## Contents

- [What you get](#what-you-get)
- [How it works, and the one thing to understand about it](#how-it-works)
- [Before you start](#prerequisites)
- [Deploy it](#deploy)
- [Put Access in front — this is enforced](#the-gate)
- [Try it locally first](#local)
- [Getting updates later](#getting-updates)

**Every setting, in detail, is in [CONFIG.md](./CONFIG.md).**

---

<a id="what-you-get"></a>

## What you get

### Call-flow diagrams, resolved live

Pick a domain, pick an entity — a DID, an auto attendant, a call queue, a user — and it resolves that
entity's routing from the API and draws it: DID → time-of-day → auto-attendant menu → queue → agents →
voicemail or an external number. Nothing is stored; the diagram is generated per view.

**Why?** The answer to "where does this number actually go" is spread across six screens of the Manager
Portal, and the usual substitute is a drawio diagram that was accurate the day someone drew it. A
generated diagram cannot be stale, and it takes no maintenance to keep that way.

### A viewer built for reading them

Browse the domains the token can reach, pick an entity, and read the result: pan and zoom (**scroll pans;
Ctrl/⌘ + scroll zooms**), a theme picker that follows your system light/dark setting, and a layout toggle
between two graph engines for when a dense diagram lays out badly under one of them.

**Why?** A call flow is a graph with long labels, and the difference between a readable one and an
unreadable one is usually layout and contrast rather than content.

### Export

Any diagram can be exported as **SVG**, as **PNG**, or as its **Mermaid source**.

**Why?** Because a diagram that cannot leave the tool ends up redrawn by hand for the customer document,
the ticket, or the runbook — which is exactly the hand-drawn artifact this replaces. The Mermaid source
matters most: it drops into any document system that renders Mermaid and stays editable.

### Optional enrichment on the agent lines

Two independent settings add detail to the people on a diagram: desk-phone **model and registration
status**, and softphone **app presence**.

**Why?** "The queue rings four agents" and "the queue rings four agents, two of whom have no registered
device" are different answers to the same question, and only one of them explains the complaint you are
investigating.

*Settings: [`NS_DEVICE_DETAILS`](./CONFIG.md#NS_DEVICE_DETAILS) and
[`RINGOTEL_PRESENCE`](./CONFIG.md#RINGOTEL_PRESENCE), the second of which needs
[`RINGOTEL_API_KEY`](./CONFIG.md#RINGOTEL_API_KEY).*

### A setup page that tells you what is missing

Open `/` on a deployment that is not finished and it lists exactly which settings are unset, with the fix
for each. `GET /health` answers the same question as JSON. Both report only *whether* a value is present,
never what it is.

**Why?** Because the failure mode of a misconfigured Worker is a 500 with nothing useful in it, and the
answer is usually one unset variable.

---

<a id="how-it-works"></a>

## How it works, and the one thing to understand about it

This deployment holds **a stored NetSapiens credential**, and that credential answers *every* request that
reaches the Worker.

There is no per-user login here. Whoever opens the URL gets whatever the token can read — and a
reseller-scoped token can read your whole fleet. That is not a flaw to work around; it is the design that
makes a single-user internal tool this easy to run. It does mean the perimeter is the entire security
model, which is why the Worker **refuses to use the token at all** until there is something verifiable in
front of it. See [the gate](#the-gate).

Everything else follows from that:

- **Reads are bounded by the token's own NetSapiens scope**, first and foremost. Prefer a narrowly-scoped,
  read-only token if your platform can issue one.
- **[`ALLOWED_DOMAINS`](./CONFIG.md#ALLOWED_DOMAINS) is a second bound on top**, at the app layer. Set it
  and any other domain is refused even though the token could read it.
- **Nothing is stored between requests** except short-lived caches.

---

<a id="prerequisites"></a>

## Before you start

### The three values

| Setting | Where | Example |
|---|---|---|
| [`NS_SERVER`](./CONFIG.md#NS_SERVER) | `vars` in `wrangler.jsonc` | `api.yourprovider.com` |
| [`NS_API_KEY`](./CONFIG.md#NS_API_KEY) | secret | a NetSapiens API token |
| [`ACCESS_AUD`](./CONFIG.md#ACCESS_AUD) **+** [`ACCESS_TEAM_DOMAIN`](./CONFIG.md#ACCESS_TEAM_DOMAIN) | `vars` | your Cloudflare Access application |

The Access pair counts as one decision and is listed here rather than under optional settings because
[the token is refused without it](#the-gate).

### What else you might want

| To get | Set |
|---|---|
| A bound on which domains this deployment will touch | [`ALLOWED_DOMAINS`](./CONFIG.md#ALLOWED_DOMAINS), [`BLOCKED_DOMAINS`](./CONFIG.md#BLOCKED_DOMAINS) |
| Desk-phone model and registration on agent lines | [`NS_DEVICE_DETAILS`](./CONFIG.md#NS_DEVICE_DETAILS) |
| App presence on agent lines | [`RINGOTEL_API_KEY`](./CONFIG.md#RINGOTEL_API_KEY) + [`RINGOTEL_PRESENCE`](./CONFIG.md#RINGOTEL_PRESENCE) |
| Your name and colour on it | [`BRAND_NAME`](./CONFIG.md#BRAND_NAME), [`BRAND_ACCENT`](./CONFIG.md#BRAND_ACCENT) |
| More than one deployment on the same Cloudflare zone | a distinct [`CACHE_SCOPE`](./CONFIG.md#CACHE_SCOPE) per deployment |

**Am I done?** `GET /health` reports `{"ok":true,"configured":true,...}`, and `/` lists anything still
missing.

---

<a id="deploy"></a>

## Deploy it

**No bindings to provision** — no KV, R2, D1, or Durable Objects. All caching uses the Workers Cache API,
so this deploys clean.

**The deploy button** (no terminal) clones this repo into your own GitHub account, deploys to your own
Cloudflare, and prompts for the values on a form.

**Wrangler:**

```bash
git clone https://github.com/<your-account>/ns-callflow-viewer
cd ns-callflow-viewer
pnpm install                # or: npm install
npx wrangler login          # opens a browser; no API token to create

# edit wrangler.jsonc -> vars.NS_SERVER, and the two ACCESS_* values
npx wrangler secret put NS_API_KEY
npx wrangler deploy
```

**Turn off the `*.workers.dev` URL** (`"workers_dev": false`) once you have a route. A Worker on a custom
domain behind Access is still reachable at its `*.workers.dev` address otherwise, and that address does
not pass through your Access application — the in-Worker check catches it and refuses, but there is no
reason to leave the door there.

**If you run more than one deployment**, use a `wrangler.jsonc` `env` block per Worker. Two rules bite
everyone: **environments do not inherit top-level `vars`**, so each `env` needs its own full block; and
**secrets are per-environment** (`wrangler secret put NS_API_KEY --env internal`).

---

<a id="the-gate"></a>

## Put Access in front — this is enforced

If `NS_API_KEY` is set and **nothing verifiable is in front of it**, the Worker refuses to use the token
and serves setup instructions instead. That is enforced in code, not advice.

A public URL plus a stored token equals your fleet for anyone who finds it. So the token stays unused
until one of these is true:

| | How |
|---|---|
| **Cloudflare Access in front** (recommended) | Set `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN`. The Worker verifies the Access JWT **itself**, against your team's signing keys — so a request that skipped Access, or arrived on a route Access does not cover, is refused too. |
| **You protect it another way** | `ALLOW_UNGATED_SERVICE_TOKEN=1` — a deliberate opt-out for mTLS, a WAF, or an authenticating proxy. You own the consequences. |

⚠️ **Both Access variables or neither.** One alone leaves the check inert — it cannot verify anything with
half a configuration — and because the same check decides whether the token may be used, a half-configured
gate leaves you with a deployment that refuses to work. The setup page names the missing half rather than
letting you guess. This is fail-closed by design; the alternative failure mode is a deployment that reports
itself protected while the check never runs.

**Setting it up in Cloudflare**, in short: Zero Trust → Access → Applications → add a self-hosted
application for your Worker's hostname, add a policy for whoever should get in, then copy the
application's **AUD tag** from its Overview into `ACCESS_AUD` and your team domain
(`yourteam.cloudflareaccess.com`) into `ACCESS_TEAM_DOMAIN`. Both are public identifiers — they are safe in
committed `vars`.

**Local `wrangler dev` is exempt**, because it is not internet-reachable and there is nothing to expose.

---

<a id="local"></a>

## Try it locally first

No Cloudflare Access, no Zero Trust setup, nothing to provision:

```bash
cp .dev.vars.example .dev.vars     # put your NS_API_KEY in it
npx wrangler dev                   # -> http://localhost:8787
```

Open that URL and you get the viewer, running against your live NetSapiens data. This is the fastest way
to find out whether the tool is useful to you before committing to any of it.

**Put each key in exactly one place.** A key in both `wrangler.jsonc` `vars` and `.dev.vars` is shadowed by
the `vars` value, which silently ignores the other — the classic way to "set" `ALLOWED_DOMAINS` and have it
do nothing.

There is also an offline CLI for rendering from a saved snapshot rather than the live API:

```bash
pnpm flow <snapshot.json> gallery   # -> out/*.gallery.html
```

---

<a id="getting-updates"></a>

## Getting updates later

The deploy button **clones** this repo rather than forking it, so your copy has no link back — there is no
"Sync fork" button. Point your copy at this one once, and updates are two commands forever after:

```bash
git remote add upstream https://github.com/dszp/ns-callflow-viewer   # once
git fetch upstream
git merge upstream/main
git push
```

Conflicts should be rare and boring: `wrangler.jsonc` is the file you edited, and it is the file most
likely to move here. Your `vars` are yours — keep them.
