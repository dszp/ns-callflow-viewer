/**
 * The exposure gate is the single most security-relevant predicate in this repo: it decides whether a
 * stored credential that answers ANY request may be used at all. It gets its own suite rather than
 * riding along in the worker test, because a regression here is silent, total, and fleet-wide.
 *
 * Run: pnpm test:exposure
 */
import { serviceTokenBlocked, isLocalRequest, BLOCKED_REASON } from './exposure.js';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name); }
};

const KEY = { NS_API_KEY: 'k' };
const GATE = { ACCESS_AUD: 'a', ACCESS_TEAM_DOMAIN: 'yourteam.cloudflareaccess.com' };
const HOST = 'viewer.example.com';

// The baseline: nothing to protect.
ok('no credential ⇒ nothing to block', !serviceTokenBlocked({}, HOST));

// The whole point of the module.
ok('credential, no gate ⇒ BLOCKED', serviceTokenBlocked(KEY, HOST));
ok('credential + both Access vars ⇒ allowed', !serviceTokenBlocked({ ...KEY, ...GATE }, HOST));

// The fail-open shape. Half a gate cannot verify anything, so it must NOT open this one — keying off
// ACCESS_AUD alone was a real fail-open, and these two cases are why the predicate is shared with
// accessConfig() rather than re-derived here.
ok('credential + AUD only ⇒ BLOCKED (half a gate is no gate)',
  serviceTokenBlocked({ ...KEY, ACCESS_AUD: 'a' }, HOST));
ok('credential + team domain only ⇒ BLOCKED',
  serviceTokenBlocked({ ...KEY, ACCESS_TEAM_DOMAIN: 'yourteam.cloudflareaccess.com' }, HOST));

// The deliberate opt-out, and each truthy form of it: a regression that only re-read "1" would
// otherwise pass while silently ignoring an operator who wrote "true".
for (const v of ['1', 'true', 'yes', 'on', 'ON', ' 1 ']) {
  ok(`explicit opt-out ALLOW_UNGATED_SERVICE_TOKEN=${JSON.stringify(v)} ⇒ allowed`,
    !serviceTokenBlocked({ ...KEY, ALLOW_UNGATED_SERVICE_TOKEN: v }, HOST));
}
for (const v of ['0', 'false', 'no', 'off', '', undefined]) {
  ok(`a falsy opt-out ${JSON.stringify(v)} does NOT open the gate`,
    serviceTokenBlocked({ ...KEY, ALLOW_UNGATED_SERVICE_TOKEN: v }, HOST));
}

// Local dev. A deployed Worker is routed by Host, so `Host: localhost` never reaches one — this
// cannot be spoofed into opening the gate on a real deployment.
ok('localhost is exempt', !serviceTokenBlocked(KEY, 'localhost'));
ok('127.0.0.1 is exempt', !serviceTokenBlocked(KEY, '127.0.0.1'));
ok('isLocalRequest: localhost', isLocalRequest('localhost'));
ok('isLocalRequest: 127.0.0.1', isLocalRequest('127.0.0.1'));
ok('isLocalRequest: ::1', isLocalRequest('::1'));
ok('isLocalRequest: a *.localhost dev host', isLocalRequest('viewer.localhost'));
ok('isLocalRequest: a real host is NOT local', !isLocalRequest('viewer.example.com'));
ok('isLocalRequest: a lookalike host is not local', !isLocalRequest('localhost.example.com'));

// The refusal text names settings, never values — it is shown to whoever reached the URL.
ok('the reason names the credential setting', BLOCKED_REASON.includes('NS_API_KEY'));
ok('the reason names both halves of the gate',
  BLOCKED_REASON.includes('ACCESS_AUD') && BLOCKED_REASON.includes('ACCESS_TEAM_DOMAIN'));
ok('the reason does not mention the old credential name', !BLOCKED_REASON.includes('NS_API_TOKEN'));

console.log(`\nexposure.selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
