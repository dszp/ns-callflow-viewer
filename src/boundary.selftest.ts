/**
 * The boundary guard. Run: pnpm test:boundary
 *
 * This repo serves ONE product. The portal backend is a different repo with a different security model
 * — delegated per-caller tokens instead of a stored credential, writes, an injection surface, a policy
 * engine. A portal concept appearing here means the cut has leaked, and the failure mode is silent:
 * nothing fails to compile, no test goes red, and the two security models quietly recombine in one
 * Worker. That is precisely the state the extraction existed to end, so it is enforced by a test.
 *
 * WHAT THIS CANNOT DO. The positive checks below are PRESENCE checks — one call site anywhere in
 * worker.ts satisfies them. A refactor that gates the HTML routes and drops the data-route check would
 * pass this suite. The behavioural guard for that is worker.selftest's "ungated credential ⇒ 403 on a
 * DATA route too". Do not read a green boundary suite as proof the gates are wired correctly.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => {
  if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.error('  FAIL', n); }
};

const SRC = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(SRC, '..');

// RECURSIVE: a future src/routes/ or src/lib/ must not escape the scan simply by existing.
const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts') && !f.endsWith('boundary.selftest.ts'));

/**
 * Each entry is a thing this repo structurally does not have, plus the files allowed to name it.
 *
 * `PORTAL_` as a single pattern subsumes MODE / FEATURES / SUPERADMINS / MENUS / SECONDARIES /
 * HANDOFF_URL / APPS_HIDE — which only works because NS_PORTAL_ISS was dropped from Env. If a delegated
 * path is ever added back, that pattern has to be split before it can be re-broadened.
 *
 * The eligibility pattern matches the IMPORT, not the word: a guard that fires on prose is a guard
 * people learn to bypass, and this file's own value rests on never crying wolf.
 */
const FORBIDDEN: Array<{ what: string; re: RegExp; allow?: string[] }> = [
  { what: 'any PORTAL_ setting', re: /PORTAL_/ },
  { what: 'delegated ns_t tokens', re: /\bns_t\b/ },
  { what: 'principals', re: /\btoPrincipal\b|\bPrincipal\b/ },
  { what: 'the policy engine', re: /\bisAllowed\b|FeaturePolicies|\bcan\(/ },
  { what: 'the feature registry', re: /\bfeatureGate\b|FEATURE_REGISTRY|resolveFeaturePolicies/ },
  { what: 'the injected primary', re: /PRIMARY_BASENAME|kitConfigError/ },
  { what: 'the status console', re: /statusModel|statusPage|kit\.status/ },
  { what: 'event subscriptions', re: /NS_EVENTS|NsSubscriptionsClient/ },
  { what: 'the write client', re: /NsWriteClient|RINGOTEL_WRITE_DOMAINS/ },
  // The eligibility engine is the tell that too much of the app integration came across.
  { what: 'the eligibility engine', re: /from '\.\/eligibility\.js'|evaluateEligibility/ },
  // The old credential name, allowed in setup.ts ONLY, where it is read in order to tell an operator
  // they set the wrong one. Anywhere else means something still expects the old value.
  {
    // setup.ts READS it, to tell an operator they set the wrong name. Its selftest asserts that
    // behaviour, and exposure.selftest asserts the refusal text does NOT mention it. Three named
    // exceptions rather than a *.selftest.ts wildcard: the point is that a NEW file naming the old
    // credential is a regression, and a wildcard would let one in.
    what: 'the old credential name', re: /NS_API_TOKEN/,
    allow: ['setup.ts', 'setup.selftest.ts', 'exposure.selftest.ts'],
  },
];

for (const { what, re, allow = [] } of FORBIDDEN) {
  const hits = files
    .filter((f) => !allow.some((a) => f.endsWith(a)))
    .filter((f) => re.test(readFileSync(join(SRC, f), 'utf8')));
  ok(`no ${what} in src/${allow.length ? ` (outside ${allow.join(', ')})` : ''}`, hits.length === 0);
  if (hits.length) console.error('       found in:', hits.join(', '));
}

// ── docs and config drift silently and forever ───────────────────────────────────────────────────
// A SETUP.md that says `wrangler secret put NS_API_TOKEN` recreates the exact wrong-name trap that
// setup.ts now detects, and nothing compiles a document.
for (const doc of ['README.md', 'SETUP.md', 'CONFIG.md', 'AGENTS.md', 'wrangler.jsonc', '.dev.vars.example']) {
  let text: string;
  try { text = readFileSync(join(ROOT, doc), 'utf8'); } catch { ok(`${doc} exists`, false); continue; }
  ok(`${doc} does not name NS_API_TOKEN`, !/NS_API_TOKEN/.test(text));
  ok(`${doc} does not document a PORTAL_ setting`, !/PORTAL_/.test(text));
}

// ── the positive half: the surface that must not quietly shrink ──────────────────────────────────
const worker = readFileSync(join(SRC, 'worker.ts'), 'utf8');
for (const route of ['/health', '/app', '/domains', '/entities', '/flow']) {
  ok(`worker.ts still serves ${route}`, worker.includes(`'${route}'`));
}
ok('worker.ts calls the exposure gate', /serviceTokenBlocked\(/.test(worker));
ok('worker.ts calls the Access gate', /requireAccess\(/.test(worker));
ok('worker.ts normalizes domains', /normDomain\(/.test(worker));
ok('worker.ts emits the baseline security headers', /securityHeaders\(/.test(worker));

console.log(`\nboundary.selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
