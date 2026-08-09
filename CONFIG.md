# Configuration reference

Every setting this deployment reads, what it controls, and what happens when you leave it out.

**[SETUP.md](./SETUP.md) is the path; this is the map.**

---

## Contents

- [How to read this](#how-to-read-this)
- [Core](#group-core) — `NS_SERVER` · `NS_API_KEY` · `CACHE_SCOPE` · `NS_DEVICE_DETAILS`
- [The access gate](#group-access) — `ACCESS_AUD` · `ACCESS_TEAM_DOMAIN` · `ALLOW_UNGATED_SERVICE_TOKEN`
- [Domain limits](#group-domains) — `ALLOWED_DOMAINS` · `BLOCKED_DOMAINS`
- [App enrichment](#group-ringotel) — `RINGOTEL_API_KEY` and friends
- [Branding](#group-branding) — `BRAND_NAME` · `BRAND_ACCENT` · `BRAND_LABEL`
- [Where each value goes](#where-each-value-goes)

---

<a id="how-to-read-this"></a>

## How to read this

**Three places a value can live, and they are not interchangeable:**

| Kind | How you set it | Notes |
|---|---|---|
| **`vars`** | a `vars` entry in `wrangler.jsonc` | committed to your repo, so anyone who can read the repo can read the value |
| **secret** | `wrangler secret put <NAME>` | never committed, never readable back |
| **binding** | a structural entry in `wrangler.jsonc` (`ratelimits`) | not a string; adding a var of the same name creates nothing |

**Nothing is inherited between environments.** `vars`, secrets and bindings are all per-environment. An
`env` block needs its own full copy of every var — a missing one does not warn, it is simply absent at
runtime.

**Blank is a safe answer everywhere except the two required values and the gate.** Everything else is off,
inert, or at a documented default when unset.

**Truthy values** anywhere below are `1`, `true`, `yes`, `on`.

---

<a id="group-core"></a>

## Core

<a id="NS_SERVER"></a>

### `NS_SERVER` · `vars` · **required**

Your NetSapiens API host — host only, no scheme, no path. Every read goes to
`https://{NS_SERVER}/ns-api/v2`.

- **Example** `api.example.com`
- **Unset** Nothing works. A fresh deployment ships the placeholder `api.example.com`, which is reported as
  a setup blocker on `/` and by `/health`.

<a id="NS_API_KEY"></a>

### `NS_API_KEY` · **secret** · **required**

The stored NetSapiens bearer token this deployment reads as. There is no per-user login here: this token
answers **every** request that reaches the Worker, with its full NetSapiens scope.

- **Unset** The deployment cannot authenticate to NetSapiens, and `/` says so.
- ⚠️ **It is refused until something verifiable is in front of it** — see
  [`ACCESS_AUD`](#ACCESS_AUD) and [`ALLOW_UNGATED_SERVICE_TOKEN`](#ALLOW_UNGATED_SERVICE_TOKEN). This is
  enforced, not advisory.
- **Scope it as narrowly as your platform allows.** This deployment only ever *reads*, so a read-only
  token is the right shape if NetSapiens will issue you one. The token's own scope is the real boundary —
  a reseller-scoped token means the whole fleet, and `ALLOWED_DOMAINS` is a second bound on top of it, not
  a replacement for it.

<a id="CACHE_SCOPE"></a>

### `CACHE_SCOPE` · `vars` · default `default`

Namespace for every cache entry this deployment writes.

- **Example** `viewer-prod`
- **One Worker** Leave it alone.
- **More than one on the same Cloudflare zone** Give each a distinct value. `caches.default` is shared
  **zone-wide**, not per Worker, so two deployments at the same scope read and write one set of cached
  entries — each serving the other's data, and each suppressing the other's forced refresh.
- **How to check** `GET /health` reports the value in use. Compare the `scope` field across deployments.
  One deployment missing the setting degrades safely to its own namespace; *two* missing it quietly share
  one again.

<a id="NS_DEVICE_DETAILS"></a>

### `NS_DEVICE_DETAILS` · `vars`

Show each user's desk-phone model and live registration status on diagram agent lines, read live per
render.

- **Example** `1`
- **Unset** Off.
- **Cost** Extra NetSapiens reads on every render.


<a id="group-access"></a>

## The access gate

The perimeter is this deployment's entire security model, because the stored token is ambient authority.
These three settings are how the Worker decides whether that token may be used at all.

<a id="ACCESS_AUD"></a>

### `ACCESS_AUD` · `vars` · **required in practice**

Your Cloudflare Access application's **Audience (AUD) tag**. Its presence — together with
`ACCESS_TEAM_DOMAIN` — turns on in-Worker verification of the Access JWT, so only requests that already
passed your Zero Trust policy are served.

- **Example** a 64-character hex string, from Zero Trust → Access → your application → Overview
- **Unset** Access verification is off, and the stored token is refused unless
  [`ALLOW_UNGATED_SERVICE_TOKEN`](#ALLOW_UNGATED_SERVICE_TOKEN) is set.
- It is a public identifier — safe in committed `vars`.

<a id="ACCESS_TEAM_DOMAIN"></a>

### `ACCESS_TEAM_DOMAIN` · `vars` · **required in practice**

Your Zero Trust team domain, used to fetch the signing keys the Access JWT is verified against.

- **Example** `yourteam.cloudflareaccess.com`
- **Unset** The check cannot run even with `ACCESS_AUD` set.
- Also a public identifier — safe in `vars`.

⚠️ **Both or neither.** The audience tag identifies the application; the team domain is where the signing
keys come from. One without the other cannot verify anything, so a half-configured gate is treated as
inert **and** the stored token is refused — failing closed rather than reporting itself protected while
the check never runs. Whichever half is missing, the setup page names it.

**Why the Worker verifies the JWT itself** rather than trusting that Access is in front: a Worker on a
custom domain is still reachable at its `*.workers.dev` address, and a route can be added that does not
pass through the Access application. Verifying in-Worker means those paths are refused too.

<a id="ALLOW_UNGATED_SERVICE_TOKEN"></a>

### `ALLOW_UNGATED_SERVICE_TOKEN` · `vars`

A deliberate opt-out of the check above: truthy means the stored token may answer requests with no Access
gate configured.

- **Example** `1`
- **Unset** The token is refused unless both `ACCESS_*` values are set — fail-closed by default.
- **Only for a deployment protected some other way** — mTLS, a WAF, an authenticating proxy in front. You
  own the consequences of setting it.

**Local `wrangler dev` is exempt from all of this**, because it is not internet-reachable.

---

<a id="group-domains"></a>

## Domain limits

App-layer bounds on which NetSapiens domains this deployment will touch — **on top of** the token's own
scope, never a replacement for it.

Comma-separated NetSapiens domain names, exactly as NetSapiens has them. A domain may be bare (`acme`) or
carry a territory suffix (`acme.12345.service`); use whichever form is real for you.

<a id="ALLOWED_DOMAINS"></a>

### `ALLOWED_DOMAINS` · `vars`

Allowlist. Set it and only these domains are listed; any other is refused with a 403 **even though the
token could read it**.

- **Example** `acme.example,demo.12345.service`
- **Unset** Unrestricted — bounded only by the token's NetSapiens scope.
- **Worth setting even on an internal tool.** It is the cheapest bound on the blast radius of a broadly
  scoped token, and the only one that does not depend on your NetSapiens platform issuing you a narrower
  credential.

<a id="BLOCKED_DOMAINS"></a>

### `BLOCKED_DOMAINS` · `vars`

Hide specific domains and refuse every domain-scoped read against them — a DID-holding domain with nothing
to diagram, say.

- **Example** `0000.12345.service`
- **Unset** No domain is blocked beyond the token's own scope.

---

<a id="group-ringotel"></a>

## App enrichment

Optional. **[`RINGOTEL_API_KEY`](#RINGOTEL_API_KEY) is the gate**: absent, there are no calls to the app
platform, no enrichment, and the deployment behaves exactly as if the integration did not exist. Every
other setting in this group is inert without it.

What it adds here is **decoration on a diagram** — app presence on agent lines — and nothing else. There is
no user management, no activation, and no directory in this deployment.

<a id="RINGOTEL_API_KEY"></a>

### `RINGOTEL_API_KEY` · **secret**

Your Ringotel AdminAPI key. Its presence turns enrichment on.

- **Unset** No app calls. The NetSapiens-only diagram is unaffected.

<a id="RINGOTEL_PRESENCE"></a>

### `RINGOTEL_PRESENCE` · `vars` · gated by `RINGOTEL_API_KEY`

Show live presence — active, on a PBX call, offline — on agent lines.

- **Example** `1`
- **Unset** Off by default, deliberately: presence is a point-in-time snapshot (cached ≤10 min) while the
  rest of a diagram is static configuration, and mixing the two without saying so invites a reader to
  believe the whole picture is live.

<a id="RINGOTEL_LABEL"></a>

### `RINGOTEL_LABEL` · `vars` · default `Ringotel` · gated by `RINGOTEL_API_KEY`

Long display name for the app wherever it is named.

- **Example** `Acme App`
- A white-label name is deployment-identifying: prefer a secret so it stays out of a committed file.

<a id="RINGOTEL_LABEL_SHORT"></a>

### `RINGOTEL_LABEL_SHORT` · `vars` · gated by `RINGOTEL_API_KEY`

Short name for tight spots, such as a column header.

- **Example** `Acme`
- **Unset** Falls back to `RINGOTEL_LABEL`, then `Ringotel`.

<a id="RINGOTEL_BASE_URL"></a>

### `RINGOTEL_BASE_URL` · `vars` · gated by `RINGOTEL_API_KEY`

Non-default AdminAPI base URL, for a non-standard deployment.

- **Example** `https://shell.ringotel.co`
- **Unset** The standard base URL.

<a id="RINGOTEL_OVERRIDES"></a>

### `RINGOTEL_OVERRIDES` · `vars` · gated by `RINGOTEL_API_KEY`

JSON `{"<nsDomain>": "<branchAddressToMatch>"}`, for the rare domain whose app branch address does not
equal its NetSapiens domain.

- **Example** `{"weird.example": "actual-branch-address"}`
- **Unset** No overrides. A branch's `address` is matched to the NetSapiens domain automatically — that is
  what binds them — and if yours match, which they normally do, you need none of this.

---

<a id="group-branding"></a>

## Branding

Branding is configuration, never code, so a fork ships unbranded and yours never enters the source.

<a id="BRAND_NAME"></a>

### `BRAND_NAME` · **secret** (by convention) or `vars`

Your company name. Drives the product name shown and the default theme label.

- **Example** `Acme Voice`
- **Unset** The generic product name and the neutral theme.

<a id="BRAND_ACCENT"></a>

### `BRAND_ACCENT` · `vars`

Accent colour for the branded theme.

- **Example** `#1a6bb0`
- **Must be hex** (`#rgb` or `#rrggbb`). Anything else is ignored.
- **Unset** Unbranded — the neutral `ns-portal` theme, which matches the stock Manager-Portal scheme.

<a id="BRAND_LABEL"></a>

### `BRAND_LABEL` · `vars`

Override the theme picker's label for your brand theme.

- **Example** `Acme Portal`
- **Unset** `"<BRAND_NAME> portal"` when `BRAND_NAME` is set, else `"Brand"`.

---


<a id="where-each-value-goes"></a>

## Where each value goes

**`vars` in `wrangler.jsonc`** — non-secret, committed, visible to anyone who can read your repo:

`NS_SERVER`, `CACHE_SCOPE`, `NS_DEVICE_DETAILS`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`,
`ALLOW_UNGATED_SERVICE_TOKEN`, `ALLOWED_DOMAINS`, `BLOCKED_DOMAINS`, `RINGOTEL_PRESENCE`,
`RINGOTEL_BASE_URL`, `RINGOTEL_OVERRIDES`, `BRAND_ACCENT`, `BRAND_LABEL`.

**Secrets** — `wrangler secret put <NAME>`, never committed:

`NS_API_KEY`, `RINGOTEL_API_KEY`, and by convention `BRAND_NAME` / `RINGOTEL_LABEL` /
`RINGOTEL_LABEL_SHORT`.

⚠️ **Deployment-identifying values belong in secrets even though they are not credentials.**
`ALLOWED_DOMAINS`, `BLOCKED_DOMAINS`, `RINGOTEL_OVERRIDES` and the brand labels all say which provider you
run on and which customers you serve. In a private repo a var is fine; **if your copy of this repo is
public, they must be secrets.**

**Put each key in exactly one place.** A key in both `vars` and `.dev.vars` is shadowed by the
`wrangler.jsonc` value, which silently ignores the other.

**Locally:** `cp .dev.vars.example .dev.vars` and fill it in. That file is also what the *Deploy to
Cloudflare* button reads to build its prompt form, which is why it is kept short — every key in it is one
more blank box a newcomer has to understand.
