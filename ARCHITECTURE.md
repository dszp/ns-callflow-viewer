# Architecture

How this fits together, and the traps worth knowing before you change it. For *what to set*, read
[CONFIG.md](./CONFIG.md); for *how to deploy*, [SETUP.md](./SETUP.md).

## The shape

A Cloudflare Worker serving six routes over a published library. The diagram engine — the resolver, the
Mermaid emitter, the HTML renderers — is **not in this repo**: it lives in
[`@dszp/netsapiens-lib`](https://github.com/dszp/netsapiens-lib), which also runs in Node and in the
browser. What is here is the host layer: authentication, the perimeter, the route surface, and the SPA.

| File | Role |
|---|---|
| `worker.ts` | The entry. Six routes, both gates, the domain bounds, the error mapper. The only file with an opinion about ordering. |
| `access.ts` | Cloudflare Access JWT verification (RS256 against the team JWKS). Fails closed on any decode/fetch/verify problem. |
| `exposure.ts` | The gate that refuses to use the stored credential when nothing verifiable is in front of it. |
| `setup.ts` | The first-run checklist — what is unset, and what to do about it. Safe to serve unauthenticated. |
| `viewerApp.ts` | The SPA served at `/` and `/app`. Calls `/domains`, `/entities`, `/flow` and nothing else. |
| `appEnrich.ts` | Optional softphone-app enrichment on agent lines. Fully gated on one API key. |
| `nsDevices.ts` | Optional desk-phone model and registration enrichment. |
| `brand.ts` · `pageShell.ts` | Branding (configuration, never source) and the plain HTML shell the setup and exposure pages render into. |
| `cli.ts` | Offline rendering from a saved snapshot. A Node program, not Worker code. |

## The security model, and why it is shaped this way

**This deployment holds ambient authority.** `NS_API_KEY` answers whatever request reaches the Worker,
with that credential's full NetSapiens scope — for a reseller-scoped key, the whole fleet. There is no
per-user login. That is what makes a single-purpose internal tool this simple to run, and it means the
**perimeter is the entire security model**.

Three consequences are wired into the code rather than left to documentation:

1. **The credential is refused until a gate exists.** `serviceTokenBlocked` returns true whenever a
   credential is set, Access is not fully configured, the explicit opt-out is absent, and the request is
   not local. Callers refuse rather than falling back. A warning would not do: the failure is silent and
   total.
2. **"Access is configured" means BOTH variables.** `accessConfig()` returns null unless `ACCESS_AUD`
   *and* `ACCESS_TEAM_DOMAIN` are set, because the team domain is what builds the JWKS URL — with the AUD
   alone there is nothing to verify against and the check cannot run. Keying anything off the AUD alone
   was a real fail-open in this code's history: a half-configured deployment reported itself protected
   while the check was inert. **Every consumer asks `accessConfig(env) !== null` and nothing else.**
3. **The JWT is verified here, not assumed from routing.** A Worker on a custom domain is still reachable
   at its `*.workers.dev` address, and a route can be added that does not pass through the Access
   application. Verifying in-Worker refuses those paths too.

**Order in `fetch()` is part of the contract.** `/health` answers before every gate — it is how you
diagnose a deployment refusing everything else, and it discloses only whether settings are present.
Everything after it passes Access **first**, including the method check and the final 404: answering "no
such route" to an unauthenticated caller turns this into a route-probing surface. The exposure gate then
applies to the data routes as well as the HTML ones.

**`boundary.selftest.ts` enforces the repo's own scope.** It fails if a portal concept — a `PORTAL_`
setting, a delegated token, a principal, the policy engine, the write client — appears in `src/`, and
also if a route or a gate call disappears from `worker.ts`. The positive half is presence-only and says so
in its own comment: the behavioural proof that the exposure gate covers data routes is a case in
`worker.selftest.ts`, not here.

## The NetSapiens routing model

The resolver in `netsapiens-lib` decodes a domain snapshot into a flow graph. What it walks:

- **A DID** resolves through its destination rule to a user, queue, or attendant.
- **Time-of-day** rules fan a single entity into branches by schedule, each with its own destination.
- **An auto attendant** is decoded from its dialplan rather than from the `/autoattendants` endpoint,
  which is incomplete — the menu options and their targets live in dialplan entries.
- **A queue** carries agents by extension, plus cascade tiers and an overflow destination.
- **Queue overflow emanates from the agents node**, not the queue, so it reads as the post-ring fallback.
  A park queue with no agents routes from the queue node instead.

**Cycle back-edges render as reference leaves.** The builder keeps a DFS path stack; an edge whose target
is an ancestor on that path — an attendant option returning to the queue that feeds it — draws a compact
dashed `↩ <target>` leaf instead of a line looping back up. The real node still shows in full where it was
first expanded. This is centralized in one `edge()` method, so it covers every call site. If you add a new
expandable node kind that can form cycles, give it the same enter/leave treatment.

**Mermaid IDs must never carry data.** The emitter uses synthetic `n<i>` identifiers; NetSapiens values
(hosts, parameters, anything with `.`/`:`/`@`/`*`/spaces) go only in quoted labels. Data in an ID position
makes `mermaid.render()` throw on real domains.

## Rendering traps

**Edge-label clipping is fixed in CSS, not by measurement.** Mermaid sizes each edge-label
`foreignObject` from a font measurement that drifts under `look: neo`, so the rendered span was wider than
its box and the right edge clipped ("press 2" → "press "). Padding the label to buy slack could not beat
the drift. The durable fix is `g.edgeLabel foreignObject { overflow: visible }` — plus, because that then
reveals Mermaid's oversized semi-transparent label background, `.labelBkg { background: transparent }`,
`foreignObject > div { white-space: nowrap; line-height: 1.35; max-width: none }`, and an inline-block
span with its own padding and radius. Keep the span background theme-derived rather than hardcoded, so it
adapts across themes.

**The theme registry is the source of truth**, and it lives in the library. The viewer consumes it as
injected data and re-themes **client-side**: the Worker emits legacy dark, no-frontmatter Mermaid, and the
page swaps each `classDef` line for the chosen palette and prepends the frontmatter. So theme and layout
switches are instant with no round-trip. Branding is layered on at request time from `BRAND_ACCENT` /
`BRAND_NAME`, returning a **new** object — module scope is shared across requests in a Worker, so mutating
the registry would leak one request's branding into every other.

## Caching

Everything uses the Workers Cache API (`caches.default`), so there is no binding to provision. Two things
follow:

- **It is shared zone-wide, not per Worker.** `CACHE_SCOPE` namespaces every entry this deployment writes.
  Two deployments on one zone at the same scope read and write one set of entries, each serving the
  other's data. `GET /health` reports the scope in use, which is the cheapest way to compare them.
- **It must be an explicit per-environment var**, never derived from the hostname — a scheduled
  invocation has no request to derive one from.

## Testing

```
pnpm test          # every offline suite; no credentials, no network
pnpm typecheck
pnpm flow test/snapshots/<file>.json gallery    # offline render -> out/*.gallery.html
```

**Verify Worker changes in real workerd, not just the suites.** They stub `caches` and `fetch` and run
under Node's lenient undici, so they will not catch Workers-specific traps — a global like `fetch` called
as `this.x(...)` throws "Illegal invocation" in workerd but passes in Node. Boot `npx wrangler dev` and
render one real diagram before trusting a change.

**`test/snapshots/` holds only fictional snapshots.** A real domain snapshot — names, emails, DIDs,
addresses — belongs in the gitignored `fixtures/`, never here.
