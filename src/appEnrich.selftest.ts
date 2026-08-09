/**
 * The diagram-enrichment slice. Run: pnpm test:enrich
 *
 * The cases that matter are the RESOLUTION ones. This module maps a NetSapiens domain onto an app
 * organization using a field (`branch.address`) that a customer-side admin can in principle edit, and a
 * resolver that guesses when the answer is ambiguous would attach one tenant's user list to another
 * tenant's diagram. So 0 matches and >1 organization must both refuse, and those two cases are the
 * point of this file.
 */
import {
  appEnrichEnabled, scopeOf, parseOverrides, classifyOrgMatch, connectionsOf, orgidOf,
  matchOrgsForDomain, buildExtIndex, presenceOf,
} from './appEnrich.js';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => {
  if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.error('  FAIL', n); }
};

// ── the gate ────────────────────────────────────────────────────────────────────────────────────
ok('no API key ⇒ disabled', !appEnrichEnabled({}));
ok('an empty key ⇒ disabled', !appEnrichEnabled({ RINGOTEL_API_KEY: '   ' }));
ok('a key ⇒ enabled', appEnrichEnabled({ RINGOTEL_API_KEY: 'k' }));

// ── cache namespacing ───────────────────────────────────────────────────────────────────────────
ok('CACHE_SCOPE defaults to "default"', scopeOf({}) === 'default');
ok('CACHE_SCOPE is honoured', scopeOf({ CACHE_SCOPE: 'viewer' }) === 'viewer');

// ── overrides ───────────────────────────────────────────────────────────────────────────────────
ok('overrides parse', parseOverrides({ RINGOTEL_OVERRIDES: '{"weird.example":"actual"}' })['weird.example'] === 'actual');
ok('absent overrides ⇒ empty map', Object.keys(parseOverrides({})).length === 0);

// ── resolution: the safety-critical half ────────────────────────────────────────────────────────
type Entry = Parameters<typeof matchOrgsForDomain>[0][number];
const entry = (orgid: string, branchid: string, address: string): Entry =>
  ({ orgid, orgName: `Org ${orgid}`, branchid, branchName: `Branch ${branchid}`, address }) as Entry;

// One organization serving one domain from TWO branches is a supported topology (per site, per
// white-label app, or a pilot beside production) — not an error.
const oneOrgTwoBranches = [
  entry('o1', 'b1', 'acme.example'),
  entry('o1', 'b2', 'acme.example'),
  entry('o2', 'b3', 'other.example'),
];
const resolved = classifyOrgMatch(oneOrgTwoBranches, 'acme.example');
ok('one org, two branches ⇒ resolves', orgidOf(resolved) === 'o1');
ok('...and BOTH branches are carried, not just the first', connectionsOf(resolved).length === 2);

ok('an unknown domain resolves to nothing', orgidOf(classifyOrgMatch(oneOrgTwoBranches, 'nope.example')) === undefined);

// TWO ORGANIZATIONS claiming one domain is a misconfiguration, and nothing can tell which one's users
// belong to it. Refusing is the only safe answer; picking one would silently cross tenants.
const twoOrgs = [...oneOrgTwoBranches, entry('o9', 'b9', 'acme.example')];
ok('TWO ORGS on one domain ⇒ refused, never guessed', orgidOf(classifyOrgMatch(twoOrgs, 'acme.example')) === undefined);
ok('...and the refusal does not leak a connection list', connectionsOf(classifyOrgMatch(twoOrgs, 'acme.example')).length === 0);

// Matching is on the address field, and an override redirects it.
ok('an override redirects the match',
  orgidOf(classifyOrgMatch(oneOrgTwoBranches, 'weird.example', { 'weird.example': 'other.example' })) === 'o2');

// ── extension indexing ──────────────────────────────────────────────────────────────────────────
type U = Parameters<typeof buildExtIndex>[0][number];
const user = (ext: string, branchid: string, state = 1): U =>
  ({ extension: ext, name: `User ${ext}`, branchid, state }) as unknown as U;

const idx = buildExtIndex([user('100', 'b1'), user('101', 'b2')], [
  { branchid: 'b1' }, { branchid: 'b2' },
]);
ok('users from every bound branch are indexed', idx.size === 2);
ok('indexed by extension', idx.get('100') !== undefined);

// ── presence ────────────────────────────────────────────────────────────────────────────────────
ok('state 0 ⇒ offline', presenceOf({ state: 0 } as unknown as U) === 'offline');
ok('state 5 ⇒ on a PBX call', presenceOf({ state: 5 } as unknown as U) === 'pbx');
ok('state 1 ⇒ active', presenceOf({ state: 1 } as unknown as U) === 'active');
ok('a missing state ⇒ offline, not active — never claim presence we do not have',
  presenceOf({} as unknown as U) === 'offline');

console.log(`\nappEnrich.selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
