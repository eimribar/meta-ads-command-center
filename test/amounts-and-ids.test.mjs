// Settings and brain rows a person types: amounts that could be read two ways, an Ads Manager
// link where the account id goes, several events where one goes, and the plain error line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.mjs';
import { parseAmountText, ambiguousAmount } from '../src/money.mjs';
import { checkBrainRow } from '../src/brain-rules.mjs';
import { errorLines } from '../src/cli.mjs';
import { BASE_ENV } from './helpers.mjs';

test('an amount with one dot and three digits after it is refused, the usual ones still work', () => {
  for (const v of ['1.250', '€1.250', '2.500']) {
    assert.equal(parseAmountText(v), null, v);
    assert.ok(ambiguousAmount(v), v);
  }
  assert.match(ambiguousAmount('1.250'), /write 1250 for the thousands \(no dot\), or 1\.25 for the decimal/);
  for (const [v, n] of [['1,250', 1250], ['1250', 1250], ['1.25', 1.25], ['€40', 40], ['40', 40], ['12.5', 12.5], ['1,250.50', 1250.5]]) {
    assert.equal(parseAmountText(v), n, v);
    assert.equal(ambiguousAmount(v), null, v);
  }
});

test('the money settings refuse an ambiguous amount and say how to write it', () => {
  const { problems, config } = parseConfig({ ...BASE_ENV, TARGET_COST_PER_RESULT: '1.250', MAX_DAILY_BUDGET: '2.500' });
  const by = Object.fromEntries(problems.map((p) => [p.key, p.message]));
  assert.match(by.TARGET_COST_PER_RESULT, /is ambiguous: "1\.250" can be read two ways: write 1250/);
  assert.match(by.MAX_DAILY_BUDGET, /write 2500 for the thousands/);
  assert.equal(config.TARGET_COST_PER_RESULT, undefined);
  const ok = parseConfig({ ...BASE_ENV, TARGET_COST_PER_RESULT: '1,250', MAX_DAILY_BUDGET: '€1.25' });
  assert.equal(ok.config.TARGET_COST_PER_RESULT, 1250);
  assert.equal(ok.config.MAX_DAILY_BUDGET, 1.25);
});

test('a policy/target row that could be read two ways is not saved', () => {
  assert.throws(() => checkBrainRow('policy', 'target', '1.250'), /policy\/target was not saved: "1\.250" can be read two ways.*Nothing was saved/);
  assert.equal(checkBrainRow('policy', 'target', '1,250'), 1250);
  assert.equal(checkBrainRow('policy', 'target', '40'), 40);
});

test('an Ads Manager link in META_AD_ACCOUNT_ID names the account number in it', () => {
  const link = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1234567890&business_id=55&nav_entry_point=lep_237';
  let { problems } = parseConfig({ ...BASE_ENV, META_AD_ACCOUNT_ID: link });
  let p = problems.find((x) => x.key === 'META_AD_ACCOUNT_ID');
  assert.equal(p.message, 'is an Ads Manager link; the account number in it is 1234567890, so write META_AD_ACCOUNT_ID=act_1234567890');
  ({ problems } = parseConfig({ ...BASE_ENV, META_AD_ACCOUNT_ID: 'https://business.facebook.com/settings/ad-accounts' }));
  p = problems.find((x) => x.key === 'META_AD_ACCOUNT_ID');
  assert.match(p.message, /a link with no account number in it/);
  ({ problems } = parseConfig({ ...BASE_ENV, META_AD_ACCOUNT_ID: 'my account' }));
  assert.match(problems.find((x) => x.key === 'META_AD_ACCOUNT_ID').message, /must be act_ followed by the account number/);
  assert.equal(parseConfig({ ...BASE_ENV, META_AD_ACCOUNT_ID: '987' }).config.META_AD_ACCOUNT_ID, 'act_987');
});

test('several events where one goes says one event only, not the custom conversion message', () => {
  for (const v of ['Purchase,Lead', 'Schedule and Lead', 'Purchase Lead', 'Lead / Schedule']) {
    const { problems } = parseConfig({ ...BASE_ENV, RESULT_EVENT: v });
    const p = problems.find((x) => x.key === 'RESULT_EVENT');
    assert.ok(p, v);
    assert.match(p.message, /names more than one event .*it takes one event only.*Schedule, Lead, Purchase or CompleteRegistration.*SECONDARY_EVENT/, v);
    assert.ok(!problems.some((x) => /custom conversion/.test(x.message)), v);
  }
  const sec = parseConfig({ ...BASE_ENV, SECONDARY_EVENT: 'Lead,Contact' }).problems.find((x) => x.key === 'SECONDARY_EVENT');
  assert.match(sec.message, /one event only/);
  assert.ok(!/SECONDARY_EVENT$/.test(sec.message));
  for (const v of ['Schedule', 'Complete Registration', 'complete_registration', '1234567890']) {
    assert.ok(!parseConfig({ ...BASE_ENV, RESULT_EVENT: v }).problems.some((x) => x.key === 'RESULT_EVENT'), v);
  }
});

test('a known failure prints only its plain line, anything else keeps the message', () => {
  const raw = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_1"}';
  const lines = errorLines(raw);
  assert.deepEqual(lines, ['Anthropic refused the key: check ANTHROPIC_API_KEY (npm run check).']);
  assert.ok(!lines.join('\n').includes('{'));
  assert.deepEqual(errorLines('something odd'), ['something odd', 'Run `npm run check` to see what needs attention.']);
});
