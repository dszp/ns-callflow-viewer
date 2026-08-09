/**
 * The Worker entry — six routes and nothing else.
 *
 * THE SECURITY MODEL, IN ONE PARAGRAPH. This deployment holds a stored NetSapiens credential
 * (`NS_API_KEY`) and there is no per-user login: whoever reaches the URL gets whatever that credential
 * can read, which for a reseller-scoped key is the whole fleet. That is ambient authority, and it is
 * what makes a single-purpose internal tool this simple to run — but it means the PERIMETER is the
 * entire security model. So the credential is refused outright until something verifiable is in front
 * of it (`exposure.ts`), and the Access JWT is verified in-Worker rather than trusted from routing
 * (`access.ts`), because a `*.workers.dev` URL or a route the Access application does not cover would
 * otherwise reach the credential without ever passing a policy.
 *
 * ORDER MATTERS AND IS TESTED. `/health` answers before every gate — it is how you diagnose a
 * deployment that is refusing everything else, and it discloses only whether settings are present,
 * never a value. Everything after it passes the Access gate FIRST, including the method check and the
 * final 404: answering "no such route" to an unauthenticated caller turns this into a route-probing
 * surface. The exposure gate then applies to the DATA routes as well as the HTML ones — a 403 on the
 * page and a 200 on the JSON would be the whole vulnerability with a friendly page in front of it.
 *
 * WHAT IS NOT HERE, DELIBERATELY: no delegated per-caller tokens, no principal, no policy engine, no feature
 * gates, no injection, no writes. Those belong to the portal backend, which is a different product
 * with a different security model. `boundary.selftest.ts` fails the suite if one of them appears.
 */

import {
  NsClient,
  NsApiError,
  fetchDomainSnapshot,
  listDomains,
  resolveFlow,
  listEntities,
  toMermaid,
  renderGalleryHtml,
  type EntityRef,
} from '@dszp/netsapiens-lib';

import { viewerHtml } from './viewerApp.js';
import { VERSION, productName, brandAccent, type BrandEnv } from './brand.js';
import { needsSetup, setupHtml, type SetupEnv } from './setup.js';
import { serviceTokenBlocked, exposureHtml, BLOCKED_REASON, type ExposureEnv } from './exposure.js';
import { accessConfig, verifyAccessRequest } from './access.js';
import { appEnrichEnabled, enrichFlowGraph, scopeOf, type AppEnrichEnv } from './appEnrich.js';
import { nsDeviceDetailsEnabled, enrichDeviceDetails, type NsDeviceEnv } from './nsDevices.js';

/** Every setting this Worker reads. If it is not here, CONFIG.md must not document it. */
export interface Env extends BrandEnv, SetupEnv, ExposureEnv, AppEnrichEnv, NsDeviceEnv {
  NS_SERVER?: string;
  NS_API_KEY?: string;
  ALLOWED_DOMAINS?: string;
  BLOCKED_DOMAINS?: string;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ALLOW_UNGATED_SERVICE_TOKEN?: string;
  CACHE_SCOPE?: string;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public reason?: string,
  ) {
    super(message);
  }
}

const ENTITY_KINDS = new Set(['did', 'user', 'queue', 'attendant']);

/**
 * Normalize a domain for comparison: NetSapiens domains are lowercase, and this guards against case
 * and trailing-dot variants (e.g. `?domain=0000.12345.Service.` slipping the blocklist). BOTH the
 * configured lists and the incoming parameter must pass through it, or the comparison is raw-string
 * and every canonical test case still passes.
 */
const normDomain = (d: string): string => d.trim().toLowerCase().replace(/\.+$/, '');

/**
 * Baseline security headers on EVERY response. The CSP is the deliberately NON-BREAKING subset: it does
 * not restrict script-src (the viewer runs inline modules plus an SRI-pinned Mermaid from a CDN, so a
 * script-src policy would need 'unsafe-inline' or a nonce refactor for little gain) — it locks down the
 * cheap, high-value directives instead. The viewer is never framed, so `frame-ancestors 'none'` plus
 * X-Frame-Options forbids embedding; object-src / base-uri / form-action 'none' kill plugin,
 * <base>-hijack and form-exfiltration vectors.
 *
 * There is no CORS allowlist here: this Worker serves its own SPA, same-origin. A cross-origin caller
 * is not a use case, so there is nothing to allow.
 */
const securityHeaders = (): Record<string, string> => ({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
});

const json = (body: unknown, status: number, extra: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });

const html = (body: string, status: number, extra: Record<string, string>): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...extra } });

/** Parse the domain allowlist (normalized); null ⇒ unrestricted. */
function domainAllowlist(env: Env): Set<string> | null {
  const list = (env.ALLOWED_DOMAINS ?? '').split(',').map(normDomain).filter(Boolean);
  return list.length ? new Set(list) : null;
}

/** Parse the domain blocklist (normalized, subtractive; always applied). */
function domainBlocklist(env: Env): Set<string> {
  return new Set((env.BLOCKED_DOMAINS ?? '').split(',').map(normDomain).filter(Boolean));
}

/**
 * The domain a request may act on. Blocklist first, then the allowlist if one exists — these are an
 * app-layer bound ON TOP OF the credential's own NetSapiens scope, never a replacement for it.
 */
function requireDomain(url: URL, env: Env): string {
  const domain = normDomain(url.searchParams.get('domain') ?? '');
  if (!domain) throw new HttpError(400, 'Provide ?domain=<domain>');
  if (domainBlocklist(env).has(domain)) throw new HttpError(403, `Domain "${domain}" is blocked`);
  const allow = domainAllowlist(env);
  if (allow && !allow.has(domain)) throw new HttpError(403, `Domain "${domain}" is not in ALLOWED_DOMAINS`);
  return domain;
}

/**
 * Cloudflare Access, verified here rather than assumed from routing. Inert unless BOTH `ACCESS_AUD` and
 * `ACCESS_TEAM_DOMAIN` are set — and when it is inert, the exposure gate refuses the credential, so an
 * unverified deployment serves nothing rather than serving everything.
 */
async function requireAccess(request: Request, env: Env): Promise<void> {
  const cfg = accessConfig(env);
  if (!cfg) return; // not configured; exposure.ts is what refuses the credential in that state
  const verdict = await verifyAccessRequest(request, cfg, caches.default);
  if (!verdict.ok) throw new HttpError(verdict.status, 'Cloudflare Access required', verdict.reason);
}

function client(env: Env): NsClient {
  return new NsClient({ server: env.NS_SERVER ?? '', token: env.NS_API_KEY ?? '' });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const headers = securityHeaders();

    // Before every gate, on purpose: this is how an operator diagnoses a deployment that is refusing
    // everything else. It reports whether configuration is complete, never what any value is.
    if (url.pathname === '/health') {
      return json(
        { ok: true, configured: !needsSetup(env), version: VERSION, scope: scopeOf(env) },
        200,
        headers,
      );
    }

    try {
      // Access FIRST — before the method check and before the 404, so an unauthenticated caller cannot
      // map the route surface by watching which paths answer differently.
      await requireAccess(request, env);

      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);

      if (url.pathname === '/' || url.pathname === '/app') {
        if (needsSetup(env)) return html(setupHtml(env, productName(env)), 503, headers);
        if (serviceTokenBlocked(env, url.hostname)) {
          return html(exposureHtml(env, url.hostname, productName(env)), 403, headers);
        }
        return html(viewerHtml(env), 200, headers);
      }

      if (url.pathname === '/domains' || url.pathname === '/entities' || url.pathname === '/flow') {
        // The exposure gate applies to DATA routes too. A 403 on the HTML and a 200 on the JSON would
        // be the whole vulnerability with a friendly page in front of it.
        if (serviceTokenBlocked(env, url.hostname)) {
          throw new HttpError(403, 'Stored credential is not protected', BLOCKED_REASON);
        }
        // And an unconfigured deployment refuses cleanly here rather than constructing an NsClient with
        // an empty bearer and failing somewhere deep in the library with an unhelpful shape.
        if (!(env.NS_API_KEY ?? '').trim()) {
          throw new HttpError(401, 'Not configured', 'This deployment has no NS_API_KEY. Open / for the setup checklist.');
        }

        const ns = client(env);

        if (url.pathname === '/domains') {
          const allow = domainAllowlist(env);
          const block = domainBlocklist(env);
          let doms = await listDomains(ns);
          if (allow) doms = doms.filter((d) => allow.has(normDomain(d.domain)));
          if (block.size) doms = doms.filter((d) => !block.has(normDomain(d.domain)));
          return json(doms, 200, headers);
        }

        if (url.pathname === '/entities') {
          const domain = requireDomain(url, env);
          const shallow = await fetchDomainSnapshot(ns, domain, { shallow: true, includeDidDestRules: true });
          return json(listEntities(shallow), 200, headers);
        }

        // /flow
        const domain = requireDomain(url, env);
        const kind = (url.searchParams.get('kind') ?? '').toLowerCase();
        const ref = url.searchParams.get('ref') ?? '';
        if (!ENTITY_KINDS.has(kind) || !ref) {
          return json({ error: 'Provide ?kind=did|user|queue|attendant&ref=<id>' }, 400, headers);
        }

        const snapshot = await fetchDomainSnapshot(ns, domain, { includeDialrules: true });
        const graph = resolveFlow(snapshot, { kind, ref } as EntityRef);

        // Both enrichments are fully gated and best-effort: with their settings unset this is a no-op
        // and the graph is byte-identical to the NetSapiens-only baseline.
        if (url.searchParams.get('enrich') !== '0') {
          const refresh = url.searchParams.get('refresh') === '1';
          if (nsDeviceDetailsEnabled(env)) await enrichDeviceDetails(graph, ns, caches.default, env, domain, { refresh });
          if (appEnrichEnabled(env)) await enrichFlowGraph(graph, domain, env, caches.default, { refresh });
        }

        const format = url.searchParams.get('format') ?? 'json';
        if (format === 'html') {
          return html(
            renderGalleryHtml(domain, [graph], {
              subtitle: graph.entity.label,
              theme: 'light',
              accent: brandAccent(env),
            }),
            200,
            headers,
          );
        }
        if (format === 'mermaid') {
          return new Response(toMermaid(graph), {
            headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
          });
        }
        // JSON carries the rendered Mermaid so the SPA can render and export client-side.
        return json({ ...graph, __mermaid: toMermaid(graph) }, 200, headers);
      }

      return json({ error: 'Not found' }, 404, headers);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message, reason: err.reason }, err.status, headers);
      }
      if (err instanceof NsApiError) {
        // Upstream status is useful; the upstream BODY is not safe to echo — it can carry the
        // NetSapiens hostname, a path, or a fragment of the credential.
        console.error('NetSapiens API error', err.status, err.message);
        return json({ error: 'Upstream request failed', reason: `NetSapiens returned ${err.status}` }, 502, headers);
      }
      console.error('request failed', err);
      return json({ error: 'Request failed' }, 500, headers);
    }
  },
};
