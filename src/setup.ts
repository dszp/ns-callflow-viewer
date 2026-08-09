import { page } from './pageShell.js';
import { accessConfig } from './access.js';
import { truthy } from './mode.js';
/**
 * First-run setup check.
 *
 * Neither the "Deploy to Cloudflare" button nor `npm create cloudflare -- --template=…` can prompt for
 * configuration — Cloudflare's own template guidance says so, and recommends validating at runtime and
 * warning prominently instead. This is that warning.
 *
 * A fresh copy ships `NS_SERVER: "api.example.com"` and no credential, so its first request would
 * otherwise fail somewhere deep in an API call with a confusing error. Instead the viewer route renders
 * a short checklist naming exactly what is missing.
 *
 * SAFE TO SERVE UNAUTHENTICATED: it only ever reports whether values are *present* or still the shipped
 * placeholder — never a value, never a secret, and it disappears entirely once configured, so a running
 * deployment discloses nothing. It also cannot mask a real problem: if setup IS complete, this module is
 * inert.
 */

/** The value a fresh copy ships with. Matching it means "never configured", not "configured oddly". */
export const PLACEHOLDER_SERVER = 'api.example.com';

export interface SetupEnv {
  NS_SERVER?: string;
  NS_API_KEY?: string;
  ALLOW_UNGATED_SERVICE_TOKEN?: string;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  /** Not read for anything. Present so the checklist can tell an operator they set the OLD name — see
   *  the legacy-name issue below. This is the only place in the repo that mentions it. */
  NS_API_TOKEN?: string;
}

export interface SetupIssue {
  /** 'blocker' = nothing will work until fixed. 'warning' = it runs, but you probably don't want this. */
  level: 'blocker' | 'warning';
  title: string;
  detail: string;
  fix: string;
}

const set = (v?: string): boolean => (v ?? '').trim().length > 0;

/** Is NS_SERVER set to something other than the shipped placeholder? One predicate, so "is NS_SERVER
 *  really configured" cannot drift between the checklist and anything else that asks. */
export function nsServerConfigured(env: SetupEnv): boolean {
  const server = (env.NS_SERVER ?? '').trim();
  return !!server && server !== PLACEHOLDER_SERVER;
}

/** Everything wrong with this deployment's config, worst first. Empty ⇒ good to go. */
export function setupIssues(env: SetupEnv): SetupIssue[] {
  const issues: SetupIssue[] = [];

  if (!nsServerConfigured(env)) {
    issues.push({
      level: 'blocker',
      title: 'NS_SERVER is not configured',
      detail: `Still the shipped placeholder (${PLACEHOLDER_SERVER}), so every API read would go nowhere.`,
      fix: 'Set vars.NS_SERVER in wrangler.jsonc to your NetSapiens API host, then redeploy.',
    });
  }

  if (!set(env.NS_API_KEY)) {
    issues.push({
      level: 'blocker',
      title: 'No way to authenticate',
      detail: 'This deployment reads NetSapiens as a stored credential, and there is none.',
      fix: 'Run `wrangler secret put NS_API_KEY` with a NetSapiens API token — read-only, if your platform will issue one.',
    });
  }

  // The legacy name, caught rather than ignored. An operator migrating from the combined portal kit will
  // run `wrangler secret put NS_API_TOKEN` from muscle memory: the put SUCCEEDS, nothing reads it, and
  // the deployment reports "No way to authenticate" with no hint that the secret exists under the wrong
  // name. Reading a legacy key in order to say "that is the wrong name" is the opposite of the behaviour
  // the boundary guard exists to keep out, which is why boundary.selftest allows the string here only.
  if (!set(env.NS_API_KEY) && set(env.NS_API_TOKEN)) {
    issues.push({
      level: 'blocker',
      title: 'The credential is set under its OLD name (NS_API_TOKEN)',
      detail:
        'This deployment reads NS_API_KEY. NS_API_TOKEN was the name in the combined portal kit and is ' +
        'not read here — so the secret exists, and nothing uses it.',
      fix: 'Run `wrangler secret put NS_API_KEY` with the same value, then `wrangler secret delete NS_API_TOKEN`.',
    });
  }

  // A stored credential is ambient authority: it answers ANY request that reaches the Worker, with its
  // full NetSapiens scope. `accessConfig(env) === null` rather than `!set(env.ACCESS_AUD)`: AUD alone
  // leaves the check inert, so testing the raw var would hide this from exactly the half-configured
  // deployment that needs it. The exposure gate keys off the same predicate — these must agree, or they
  // lie to each other.
  if (set(env.NS_API_KEY) && accessConfig(env) === null && !truthy(env.ALLOW_UNGATED_SERVICE_TOKEN)) {
    issues.push({
      level: 'warning',
      title: 'Stored credential is not behind an access gate — reads are REFUSED',
      detail:
        'Anyone who reached this Worker would get whatever the credential can read, so it is not used at ' +
        'all until something verifiable is in front of it. This is enforced, not advisory (src/exposure.ts).',
      fix:
        'Set ACCESS_AUD + ACCESS_TEAM_DOMAIN to turn on the in-Worker Cloudflare Access check (it fails ' +
        'closed). Or, if you have your own protection in front (mTLS, a WAF, an authenticating proxy), ' +
        'set ALLOW_UNGATED_SERVICE_TOKEN=1 to accept the risk deliberately.',
    });
  }

  // EITHER half alone is the same dead deployment, so name whichever is missing. Symmetric on purpose:
  // an operator who set only the team domain is just as entitled to be told which var is absent as one
  // who set only the AUD.
  const missingHalf =
    set(env.ACCESS_AUD) && !set(env.ACCESS_TEAM_DOMAIN)
      ? {
          absent: 'ACCESS_TEAM_DOMAIN',
          present: 'ACCESS_AUD',
          fix: 'Set vars.ACCESS_TEAM_DOMAIN to your yourteam.cloudflareaccess.com host, or remove ACCESS_AUD if you did not mean to enable Access. Then redeploy.',
        }
      : set(env.ACCESS_TEAM_DOMAIN) && !set(env.ACCESS_AUD)
        ? {
            absent: 'ACCESS_AUD',
            present: 'ACCESS_TEAM_DOMAIN',
            fix: "Set vars.ACCESS_AUD to your Access application's AUD tag (Zero Trust → Access → your app → Overview), or remove ACCESS_TEAM_DOMAIN if you did not mean to enable Access. Then redeploy.",
          }
        : null;
  if (missingHalf) {
    issues.push({
      level: set(env.NS_API_KEY) ? 'blocker' : 'warning',
      title: `Cloudflare Access is half-configured (${missingHalf.absent} missing)`,
      detail:
        `${missingHalf.present} is set but ${missingHalf.absent} is not. The Access check needs both, so ` +
        'it cannot run — Access is NOT verifying anyone, and the stored credential is refused until this ' +
        'is fixed.',
      fix: missingHalf.fix,
    });
  }

  // Blockers first: the page renders in array order, and burying a blocker under a warning is backwards
  // for the person reading it in order to unblock themselves.
  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'blocker' ? -1 : 1));
}

/** True when this deployment cannot work as configured. Warnings alone do NOT trigger setup. */
export function needsSetup(env: SetupEnv): boolean {
  return setupIssues(env).some((i) => i.level === 'blocker');
}

/** A plain, self-contained checklist page. No CDN, no fonts — it must render on a broken deployment. */
export function setupHtml(env: SetupEnv, productName = 'NS Call-Flow Viewer'): string {
  return page({
    title: `Setup — ${productName}`,
    heading: `${productName} — finish setup`,
    intro:
      "This deployment is not configured yet, so it can't talk to NetSapiens. Nothing here is secret: it " +
      'reports only which settings are missing, never their values, and it disappears once they are set.',
    items: setupIssues(env).map((i) => ({ level: i.level, title: i.title, body: [i.detail, i.fix] })),
    footer:
      'Configure <code>vars</code> in <code>wrangler.jsonc</code>, set secrets with ' +
      '<code>wrangler secret put &lt;NAME&gt;</code>, then redeploy. Every setting is defined in CONFIG.md.',
  });
}
