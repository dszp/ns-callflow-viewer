/**
 * The first-run checklist. Run: pnpm test:setup
 *
 * What matters here is not the wording but WHICH states are blockers: `needsSetup` gates the whole
 * viewer route, so a state wrongly classed as a warning ships a deployment that fails deeper, and one
 * wrongly classed as a blocker bricks a working deployment behind a checklist.
 */
import { setupIssues, needsSetup, nsServerConfigured } from './setup.js';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => {
  if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.error('  FAIL', n); }
};
const titles = (env: Parameters<typeof setupIssues>[0]) => setupIssues(env).map((i) => i.title).join(' | ');

const GOOD = {
  NS_SERVER: 'api.acme.example',
  NS_API_KEY: 'k',
  ACCESS_AUD: 'a',
  ACCESS_TEAM_DOMAIN: 'yourteam.cloudflareaccess.com',
};

ok('a complete deployment has no issues', setupIssues(GOOD).length === 0);
ok('and therefore does not need setup', !needsSetup(GOOD));

ok('placeholder NS_SERVER is raised', titles({ ...GOOD, NS_SERVER: 'api.example.com' }).includes('NS_SERVER'));
ok('placeholder NS_SERVER blocks', needsSetup({ ...GOOD, NS_SERVER: 'api.example.com' }));
ok('empty NS_SERVER blocks', needsSetup({ ...GOOD, NS_SERVER: '' }));
ok('nsServerConfigured agrees', !nsServerConfigured({ NS_SERVER: 'api.example.com' }) && nsServerConfigured({ NS_SERVER: 'api.acme.example' }));

ok('no credential is a blocker', titles({ ...GOOD, NS_API_KEY: '' }).includes('authenticate'));
ok('the OLD credential name is caught, not ignored',
  titles({ ...GOOD, NS_API_KEY: '', NS_API_TOKEN: 'k' }).includes('OLD name'));
ok('and it blocks', needsSetup({ ...GOOD, NS_API_KEY: '', NS_API_TOKEN: 'k' }));
ok('the old name is NOT mentioned once the new one is set',
  !titles({ ...GOOD, NS_API_TOKEN: 'k' }).includes('OLD name'));

ok('credential with no gate is raised', titles({ ...GOOD, ACCESS_AUD: '', ACCESS_TEAM_DOMAIN: '' }).includes('access gate'));
ok('...as a WARNING, not a blocker — the deployment runs, it just refuses to use the credential',
  !needsSetup({ ...GOOD, ACCESS_AUD: '', ACCESS_TEAM_DOMAIN: '' }));
ok('the explicit opt-out silences it',
  !titles({ ...GOOD, ACCESS_AUD: '', ACCESS_TEAM_DOMAIN: '', ALLOW_UNGATED_SERVICE_TOKEN: '1' }).includes('access gate'));

ok('half a gate names the MISSING half (team domain)', titles({ ...GOOD, ACCESS_TEAM_DOMAIN: '' }).includes('ACCESS_TEAM_DOMAIN'));
ok('half a gate names the MISSING half (aud)', titles({ ...GOOD, ACCESS_AUD: '' }).includes('ACCESS_AUD'));
ok('half a gate WITH a credential blocks — it looks protected and is not',
  needsSetup({ ...GOOD, ACCESS_TEAM_DOMAIN: '' }));
// Assert the LEVEL of the half-gate issue itself, not needsSetup — with no credential there is a
// separate blocker ("no way to authenticate"), so needsSetup is true for a reason that has nothing to
// do with this case and would make the assertion vacuous.
ok('half a gate with NO credential is only a warning — nothing to expose yet',
  setupIssues({ NS_SERVER: 'api.acme.example', NS_API_KEY: '', ACCESS_AUD: 'a' })
    .find((i) => i.title.includes('half-configured'))?.level === 'warning');

ok('blockers sort before warnings', (() => {
  const l = setupIssues({ NS_SERVER: 'api.example.com', NS_API_KEY: 'k' }).map((i) => i.level);
  return l.indexOf('blocker') < l.indexOf('warning');
})());

ok('no issue text ever contains a value', setupIssues({ ...GOOD, NS_SERVER: 'api.example.com' })
  .every((i) => !`${i.detail}${i.fix}`.includes('api.acme.example')));

console.log(`\nsetup.selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
