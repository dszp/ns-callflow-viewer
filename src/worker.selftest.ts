/**
 * End-to-end Worker test (offline, no workerd): stubs `caches` and global `fetch`, then drives
 * worker.fetch through the whole path — gates → fetchDomainSnapshot → resolveFlow → JSON/HTML.
 *
 *   tsx src/worker.selftest.ts [snapshot.json]
 *
 * THE LOAD-BEARING CASES IN THIS FILE are the gate ones, and two in particular:
 *   - "ungated credential ⇒ 403 on a DATA route too". boundary.selftest can only check that the
 *     exposure gate is CALLED somewhere in worker.ts; only this case proves it is called on the
 *     routes that return data. Do not delete it in favour of the boundary check.
 *   - the 404 probes run with an INERT env on purpose. If one fails, do NOT fix it by moving the 404
 *     ahead of the Access gate — that converts an authenticated deployment into a route-probing
 *     surface for anyone who can reach the URL.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Snapshot } from '@dszp/netsapiens-lib';

const DEFAULT_SNAP = resolve(fileURLToPath(import.meta.url), '../../test/snapshots/demo.12345.service-snapshot.json');
const snapPath = process.argv[2] ?? DEFAULT_SNAP;
const raw = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;
const DOMAIN = String((raw as any).meta?.domain ?? (raw as any).domain?.domain ?? '');

// ── stub the Cache API ───────────────────────────────────────────────────────────────────────────
class MemoryCache {
  store = new Map<string, Response>();
  async match(req: Request): Promise<Response | undefined> {
    const r = this.store.get(req.url);
    return r ? r.clone() : undefined;
  }
  async put(req: Request, res: Response): Promise<void> { this.store.set(req.url, res.clone()); }
  async delete(req: Request): Promise<boolean> { return this.store.delete(req.url); }
}
(globalThis as any).caches = { default: new MemoryCache() };

// ── stub global fetch: NetSapiens v2 reads served from the fixture ───────────────────────────────
let nsCalls = 0;
const origFetch = globalThis.fetch;
(globalThis as any).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const u = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (u.includes('/ns-api/')) {
    nsCalls++;
    if (/\/domains(\?|$)/.test(u)) {
      return new Response(JSON.stringify([{ domain: DOMAIN }, { domain: 'blocked.example' }, { domain: 'other.example' }]),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // Everything else the snapshot fetcher asks for: answer with an empty collection. The flow tests
    // below assert status and shape, not diagram content — cli.ts covers rendering against the fixture.
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return origFetch(input as any, init);
};

const worker = (await import('./worker.js')).default;

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => {
  if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.error('  FAIL', n); }
};

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const GOOD = { NS_SERVER: 'api.acme.example', NS_API_KEY: 'k', ACCESS_AUD: 'a', ACCESS_TEAM_DOMAIN: 'yourteam.cloudflareaccess.com' };
const INERT = { NS_SERVER: 'api.acme.example' };            // no credential, no Access ⇒ both gates inert
const UNGATED = { NS_SERVER: 'api.acme.example', NS_API_KEY: 'k' }; // credential, NO gate ⇒ must refuse

const hit = (path: string, env: any = GOOD, host = 'viewer.acme.example') =>
  worker.fetch(new Request(`https://${host}${path}`), env, ctx);

// ── /health: before every gate, and safe there ───────────────────────────────────────────────────
ok('/health is 200 even with a fully gated env and no Access assertion', (await hit('/health')).status === 200);
ok('/health works with no credential at all', (await hit('/health', INERT)).status === 200);
ok('/health reports configured:false when incomplete',
  (await (await hit('/health', { NS_SERVER: 'api.example.com' })).json() as any).configured === false);
ok('/health reports configured:true when complete',
  (await (await hit('/health', GOOD)).json() as any).configured === true);
ok('/health never echoes a value',
  !JSON.stringify(await (await hit('/health', GOOD)).json()).includes('api.acme.example'));

// ── the exposure gate: the most important cases here ─────────────────────────────────────────────
ok('ungated credential ⇒ 403 on the viewer', (await hit('/', UNGATED)).status === 403);
ok('ungated credential ⇒ 403 on a DATA route too, not just the HTML', (await hit('/domains', UNGATED)).status === 403);
ok('...and the data refusal is JSON, not the teaching page',
  (await hit('/domains', UNGATED)).headers.get('content-type')?.includes('application/json') === true);
ok('localhost is exempt — wrangler dev is not internet-reachable',
  (await hit('/', UNGATED, 'localhost')).status === 200);
ok('the explicit opt-out serves', (await hit('/', { ...UNGATED, ALLOW_UNGATED_SERVICE_TOKEN: '1' })).status === 200);

// ── the Access gate ──────────────────────────────────────────────────────────────────────────────
ok('a gated deployment with no Access assertion ⇒ refused on a data route', (await hit('/domains')).status === 403);
ok('...and on the viewer', (await hit('/')).status === 403);

// ── the setup page ───────────────────────────────────────────────────────────────────────────────
ok('incomplete config ⇒ 503 setup page', (await hit('/', { NS_SERVER: 'api.example.com' })).status === 503);
ok('...and it is HTML a human can read', (await hit('/', { NS_SERVER: 'api.example.com' })).headers.get('content-type')?.includes('text/html') === true);

// ── no credential on a data route: a clean refusal, never a deep failure ─────────────────────────
ok('no credential ⇒ 401 on a data route, not a 500', (await hit('/domains', INERT)).status === 401);

// ── routes that must NOT exist here ──────────────────────────────────────────────────────────────
for (const p of ['/kit/portal.js', '/kit/status', '/me/status', '/me/app-access', '/rapp/activate', '/rapp/org', '/p.js']) {
  ok(`${p} is 404 — the portal surface is not in this repo`, (await hit(p, INERT)).status === 404);
}
ok('an unknown path behind a LIVE gate is refused, not 404-probed', (await hit('/kit/status')).status === 403);

// ── method ───────────────────────────────────────────────────────────────────────────────────────
ok('POST is 405', (await worker.fetch(new Request('https://viewer.acme.example/flow', { method: 'POST' }), INERT, ctx)).status === 405);
ok('POST behind a live gate is refused before the method check', (await worker.fetch(new Request('https://viewer.acme.example/flow', { method: 'POST' }), GOOD, ctx)).status === 403);

// ── domain bounds, including the variants normDomain exists to catch ─────────────────────────────
const OPEN = { ...UNGATED, ALLOW_UNGATED_SERVICE_TOKEN: '1' };
ok('a blocked domain is refused',
  (await hit('/entities?domain=blocked.example', { ...OPEN, BLOCKED_DOMAINS: 'blocked.example' })).status === 403);
ok('MIXED CASE does not slip the blocklist',
  (await hit('/entities?domain=Blocked.Example', { ...OPEN, BLOCKED_DOMAINS: 'blocked.example' })).status === 403);
ok('a TRAILING DOT does not slip the blocklist',
  (await hit('/entities?domain=blocked.example.', { ...OPEN, BLOCKED_DOMAINS: 'blocked.example' })).status === 403);
ok('a configured list with odd case still matches a canonical request',
  (await hit('/entities?domain=blocked.example', { ...OPEN, BLOCKED_DOMAINS: ' Blocked.Example. ' })).status === 403);
ok('a domain outside the allowlist is refused',
  (await hit('/entities?domain=other.example', { ...OPEN, ALLOWED_DOMAINS: 'acme.example' })).status === 403);
ok('MIXED CASE does not slip the allowlist either',
  (await hit('/entities?domain=Other.Example.', { ...OPEN, ALLOWED_DOMAINS: 'acme.example' })).status === 403);
ok('/domains filters the blocklist out of the listing', await (async () => {
  const r = await hit('/domains', { ...OPEN, BLOCKED_DOMAINS: 'blocked.example' });
  return !JSON.stringify(await r.json()).includes('blocked.example');
})());
ok('/domains filters to the allowlist', await (async () => {
  const r = await hit('/domains', { ...OPEN, ALLOWED_DOMAINS: DOMAIN });
  return !JSON.stringify(await r.json()).includes('other.example');
})());

// ── /flow argument validation ────────────────────────────────────────────────────────────────────
ok('/flow with no kind/ref is a 400, not a crash', (await hit(`/flow?domain=${DOMAIN}`, OPEN)).status === 400);
ok('/flow with an unknown kind is a 400', (await hit(`/flow?domain=${DOMAIN}&kind=nope&ref=1`, OPEN)).status === 400);
ok('/entities with no domain is a 400', (await hit('/entities', OPEN)).status === 400);

// ── baseline security headers, on HTML and on JSON ───────────────────────────────────────────────
for (const [label, p, env] of [['the viewer', '/', OPEN], ['/health', '/health', OPEN]] as const) {
  const h = (await hit(p, env)).headers;
  ok(`${label} sets X-Frame-Options: DENY`, h.get('X-Frame-Options') === 'DENY');
  ok(`${label} sets a frame-ancestors CSP`, (h.get('Content-Security-Policy') ?? '').includes("frame-ancestors 'none'"));
  ok(`${label} sets X-Content-Type-Options: nosniff`, h.get('X-Content-Type-Options') === 'nosniff');
  ok(`${label} sets Referrer-Policy: no-referrer`, h.get('Referrer-Policy') === 'no-referrer');
}
ok('no CORS allow-origin is emitted — this Worker serves its own SPA, same-origin',
  (await hit('/', OPEN)).headers.get('Access-Control-Allow-Origin') === null);

// ── error shaping: never echo upstream detail ────────────────────────────────────────────────────
ok('an upstream failure does not leak the NetSapiens host', await (async () => {
  const r = await hit('/domains', { ...OPEN, NS_SERVER: 'api.secret-host.example' });
  const body = await r.text();
  return !body.includes('secret-host');
})());

console.log(`\nworker.selftest: ${pass} passed, ${fail} failed   (${nsCalls} stubbed NS calls)`);
if (fail > 0) process.exit(1);
