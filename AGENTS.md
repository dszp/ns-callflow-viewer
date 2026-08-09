# AGENTS.md — deploying this project

For a coding agent asked to **deploy** `ns-callflow-viewer` for an operator. It carries the order of
operations and the decisions that belong to a human; it does **not** restate what each setting means —
that is [CONFIG.md](./CONFIG.md), linked at each step. One fact, one place.

If you are changing the code rather than deploying it, this file is not for you: read
[ARCHITECTURE.md](./ARCHITECTURE.md) and run `pnpm test`.

Two things make this deployment unusual, and both are decisions rather than commands:

- **It stores a NetSapiens credential, and that credential answers every request that reaches it.** There
  is no per-user login. The perimeter is the entire security model.
- **The configuration names your customers.** Domain lists and brand strings are ordinary settings here,
  so *where the config lives* is a privacy decision, not a preference.

---

## STOP — the token and the gate are one decision

Do not deploy a token and "add Access later". You will not get the chance to forget: with `NS_API_KEY`
set and nothing verifiable in front of it, the Worker **refuses to use the token** and serves setup
instructions instead. That is enforced behaviour, not a warning, and it exists because a public URL plus a
stored token equals the operator's entire fleet for anyone who finds it.

So establish, before running anything:

| Ask | Why it must be answered first |
|---|---|
| **Does the operator have Cloudflare Zero Trust set up?** | `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` are the supported gate, and creating the Access application is a step in their Cloudflare account that you may not be able to do for them. |
| **What is the narrowest NetSapiens token that works?** | This deployment only ever *reads*. If their platform will issue a read-only or domain-scoped token, that is the one to use — the token's own scope is the real boundary, and everything else is a bound on top of it. |
| **Which domains should be visible?** | `ALLOWED_DOMAINS` refuses any other domain even though the token could read it. On a broadly scoped token this is the operator's main lever, and it is theirs to set. |

**Never reach for `ALLOW_UNGATED_SERVICE_TOKEN=1` to get past the refusal.** It exists for an operator who
already has mTLS, a WAF or an authenticating proxy in front of the Worker. Setting it to make an error go
away hands the operator's fleet to anyone who finds the URL.

## Step 1 — get the code as a PRIVATE copy

**Default: a private repository they own.** Not a fork. A fork of a public repository is itself public, and
this project's `wrangler.jsonc` legitimately holds `NS_SERVER` and domain allow/block lists — so a public
fork publishes which provider the operator runs on and which customer domains they serve. That is the
operator's business information, and it is permanent once pushed.

- **No terminal:** use the *Deploy to Cloudflare* button and tick **Create private Git repository**.
- **Terminal:** clone, create an empty private repo in their account, and push to it.

Either way the copy has **no link back upstream**, so add one once — this is the whole update story:

```bash
git remote add upstream https://github.com/dszp/ns-callflow-viewer   # once
git fetch upstream && git merge upstream/main                        # to update, later
git push                                                             # deploys if wired to Workers Builds
```

**If they want a public fork anyway** (for the *Sync fork* button), then **every value that names a
customer domain or a brand must be a secret**, not a var — `ALLOWED_DOMAINS`, `BLOCKED_DOMAINS`,
`RINGOTEL_OVERRIDES`, `BRAND_NAME`. See [CONFIG.md § Where each value goes](./CONFIG.md#where-each-value-goes).

**If the repo is connected to Workers Builds**, editing variables in the Cloudflare dashboard **will not
stick** — the next build overwrites `vars` from `wrangler.jsonc`. Edit the file. (Secrets are not
overwritten.)

## Ask the operator these — do not choose them

| Ask | Why you must not decide it |
|---|---|
| The three questions in **STOP**, above | They decide what the worst case is. |
| Should the `*.workers.dev` URL stay on? | Recommend `"workers_dev": false` once a route exists. The in-Worker Access check refuses a request that arrived there, so this is defence in depth rather than the gate — but there is no reason to leave the door standing. |
| Should app-presence enrichment be on? | `RINGOTEL_API_KEY` reaches a **third-party** system on every render that needs it. It only decorates a diagram; it is not required for anything. |
| Should desk-phone details be on? | `NS_DEVICE_DETAILS` costs extra NetSapiens reads per render, which matters on the Workers Free plan's subrequest cap. |
| Brand name and accent colour? | Branding is configuration here, never source. Absent it ships unbranded, which is correct until they tell you otherwise. |

## Never

- **Never deploy a stored token with no gate**, and never set `ALLOW_UNGATED_SERVICE_TOKEN=1` to silence
  the refusal. See STOP.
- **Never set only one of `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`.** The audience tag identifies the
  application; the team domain is where the signing keys come from. One alone cannot verify anything, so
  the gate is inert **and** the token is refused — a deployment that looks configured and does nothing.
  The setup page names the missing half; read it rather than guessing.
- **Never invent `NS_SERVER`.** Ask; do not guess from a domain name.
- **Never let two Workers on one zone share a `CACHE_SCOPE`.** Cloudflare's `caches.default` is zone-wide,
  not per Worker, so a shared value means each deployment serves the other's cached data. `env` blocks do
  **not** inherit `vars`, so each needs its own.
- **Never put a value that names a customer domain or a brand into a committed file** unless the operator
  has confirmed the repository is private. Prefer a secret; see the fork note above.
- **Never put the same key in both `vars` and `.dev.vars`.** The `wrangler.jsonc` value wins silently.
  This is the classic way to "set" `ALLOWED_DOMAINS` and have it do nothing.
- **Never commit `.dev.vars`.**
- **Never invent a config value to get past an error.** A missing answer is a question for the operator;
  an invented one converts a loud startup error into a silent misconfiguration.

## The sequence

1. **Install.**
   ```bash
   pnpm install        # or: npm install
   ```

2. **See it locally before deploying anything** — the fastest way to find out whether this is useful at
   all, and it needs no Cloudflare Access, no Zero Trust, nothing provisioned:
   ```bash
   cp .dev.vars.example .dev.vars     # put the operator's NS_API_KEY in it
   npx wrangler dev                   # -> http://localhost:8787
   ```
   Open it: the viewer runs against their live NetSapiens data. Local `wrangler dev` is exempt from the
   gate because it is not internet-reachable — which is exactly why this step is safe and the deployed
   equivalent is not.

3. **Create the Cloudflare Access application** (or confirm the operator has): Zero Trust → Access →
   Applications → self-hosted, for the Worker's hostname, with a policy for whoever should get in. Copy
   the application's **AUD tag** and the team domain.

4. **Configure.** Edit `wrangler.jsonc` `vars`: `NS_SERVER`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, and the
   answers from the questions above. Both Access values are public identifiers, so `vars` is right for
   them. Set `"workers_dev": false` if a route exists. Leave anything you were not told about unset.
   Reference: [SETUP.md § Before you start](./SETUP.md#prerequisites).
   - *Deploying more than one Worker:* give each `env` block a distinct `CACHE_SCOPE`, and remember `env`
     blocks do not inherit top-level `vars`.

5. **Set the secrets.** `npx wrangler secret put NS_API_KEY`, plus `RINGOTEL_API_KEY` if presence
   enrichment was asked for, plus anything the fork/privacy decision moved out of `vars`. **Secrets are
   per-environment** — if you used `env` blocks, pass `--env <name>` or the secret lands on the wrong
   Worker and the deployment looks unconfigured for no visible reason.

6. **Deploy.**
   ```bash
   pnpm run deploy     # `run` matters: bare `pnpm deploy` is a pnpm builtin, not this script
   ```

## Verify, in this order

Each rung proves something the previous one did not.

1. **`GET /health`** → `{"ok":true,"configured":true,...}`. Proves the Worker is deployed and routing, and
   reports whether configuration is complete — never any value. It also reports the cache `scope`: if the
   operator runs more than one Worker, **compare that field across them**. Two deployments reporting the
   same scope are sharing a cache, which is invisible from either one.
2. **Open `/`.** An incomplete deployment lists exactly which settings are unset, with the fix for each.
   A complete one gives you the viewer.
3. **Confirm Access actually challenges you.** Open the Worker's URL in a browser with no session and
   check you are sent to the Access login rather than straight in. Then, if `workers_dev` is still on, hit
   the `*.workers.dev` address and confirm it is **refused** — that is the in-Worker check doing the job
   the perimeter alone cannot.
4. **Render one diagram** for a real domain. This is the first step that exercises the token, its
   NetSapiens scope, and `ALLOWED_DOMAINS` together.
5. **Try a domain that should be refused**, if `ALLOWED_DOMAINS` is set. A bound you have not seen refuse
   anything is a bound you are assuming.

## Things that fail silently

- **`env` blocks do not inherit top-level `vars`.** Every environment needs its own complete `vars` block;
  a missing one does not warn, it is simply absent at runtime.
- **The Workers **Free** plan caps 50 subrequests per request.** A large domain's call-flow diagram fans
  out into many NetSapiens calls and can exceed it, so the diagram fails to render on Free while small
  domains work perfectly. That is the clearest single reason to move to the $5 plan. `NS_DEVICE_DETAILS`
  adds to that fan-out.
- **A half-configured Access gate reports nothing at runtime.** It is caught on the setup page, not in the
  logs of a request that was refused — so check `/` rather than inferring from a failure.
- **App presence is a point-in-time snapshot** (cached ≤10 minutes) while the rest of a diagram is static
  configuration. If the operator reads the whole picture as live, that is the setting to explain.

## If it fails

Most failures are one of: a stored token with no Access pair or only half of one (the Worker tells you
which var is missing — read the response), `NS_SERVER` still on its placeholder, a secret set on the wrong
environment, or a domain refused by `ALLOWED_DOMAINS` that the operator expected to see. Check
`GET /health` first, then open `/`: this project reports what is missing rather than failing blank.
