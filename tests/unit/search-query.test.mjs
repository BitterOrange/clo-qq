// Query cleaning, what a decision asks of search, the turn's overall status and the source line (docs/search-contract.md
// sections 5 and 6). Pure functions and the real content policy; no network. Every refusal has a passing control.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanQuery, overallStatus, searchRequestOf, SOURCE_LINE_PREFIX, sourceLine, withSourceLine,
} from '../../src/clo-plugin/lib/core/search.js';
import { loadRealPolicy } from '../fixtures/inbound.mjs';

const policy = loadRealPolicy();
// Ids and a secret with no six-digit run, so the leak check is what refuses them, not the digit rule.
const RAW_GROUP = 'GROUPAAAABBBBCCCCDDDDEEEE';
const RAW_MEMBER = 'PLAINMEMBERAAAABBBBCCCC';
const SECRET = 'FAKE-SECRET-VALUE-ABCDEFGH';
const opts = { policy, rawIds: [RAW_GROUP, RAW_MEMBER], secrets: [SECRET], displayNames: ['小明同学'] };
const CLEAN = '2026 年 F1 车手积分榜';

test('a clean query passes, normalized: NFKC, control characters out, whitespace collapsed', () => {
  assert.deepEqual(cleanQuery(CLEAN, opts), { ok: true, query: CLEAN });
  assert.deepEqual(cleanQuery('  Ｆ１\u0007  积分榜\n最新 ', opts), { ok: true, query: 'F1 积分榜 最新' });
  assert.deepEqual(cleanQuery('A​B 新闻', opts), { ok: true, query: 'A B 新闻' }, 'format characters out');
});

test('each refused shape, with a passing control beside it', () => {
  const cases = [
    ['url', `${CLEAN} https://example.com/x`],
    ['url', `${CLEAN} example.com`],
    ['mention', `<@${RAW_MEMBER}> 天气`],
    ['speaker', 'U3 说的那家店'],
    ['speaker', 'u12 的新闻'],
    ['digits', 'QQ 123456 是谁'],
    ['digits', '电话 13800138000'],
    ['name', '小明同学 最近'],
    ['leak', `查 ${SECRET}`],
    ['leak', `查 ${RAW_GROUP}`],
    ['leak', '[clo-turn class=at] 新闻'],
    ['rule', '色情网站分享'],
    ['long', '长'.repeat(81)],
    ['empty', '   '],
    ['empty', null],
  ];
  for (const [reason, raw] of cases) {
    const r = cleanQuery(raw, opts);
    assert.equal(r.ok, false, `${reason}: ${raw}`);
    assert.equal(r.reason, reason, String(raw));
  }
  // Controls: the same kinds of words without the shape pass.
  for (const raw of ['U2 乐队 新专辑'.replace('U2 ', ''), '2026 年 5 月 新闻', '天气 北京', '长'.repeat(80), '明天 同学会 天气']) {
    assert.equal(cleanQuery(raw, opts).ok, true, raw);
  }
});

test('a lower queryMaxChars refuses sooner; a higher one is held at the ceiling of 80', () => {
  assert.equal(cleanQuery('长'.repeat(20), { ...opts, maxChars: 10 }).reason, 'long');
  assert.equal(cleanQuery('长'.repeat(10), { ...opts, maxChars: 10 }).ok, true);
  assert.equal(cleanQuery('长'.repeat(81), { ...opts, maxChars: 500 }).reason, 'long');
});

test('a one-character display name does not refuse every query that holds its character', () => {
  assert.equal(cleanQuery('北京 天气', { ...opts, displayNames: ['北'] }).ok, true);
  assert.equal(cleanQuery('北京 天气', { ...opts, displayNames: ['北京'] }).reason, 'name', 'control: a longer name refuses');
});

test('a policy that throws refuses the query', () => {
  const broken = { check: () => { throw new Error('x'); }, checkLeak: () => ({ hit: false }) };
  assert.deepEqual(cleanQuery(CLEAN, { ...opts, policy: broken }), { ok: false, reason: 'rule' });
});

test('searchRequestOf: only a clean need with a query searches; danger never; a classed topic is refused', () => {
  const d = (over) => ({ action: 'reply', skipClass: 'none', crisis: false, invalid: null, search: { need: true, queries: ['a'], skipClass: 'none' }, ...over });
  assert.deepEqual(searchRequestOf(d()), { refused: false, queries: ['a'] });
  assert.equal(searchRequestOf(d({ search: { need: false, queries: [], skipClass: 'none' } })), null);
  assert.equal(searchRequestOf(d({ crisis: true })), null);
  assert.equal(searchRequestOf(d({ invalid: 'timeout' })), null);
  assert.equal(searchRequestOf(d({ search: undefined })), null, 'a decision asked without search');
  assert.equal(searchRequestOf(d({ search: { need: true, queries: ['  '], skipClass: 'none' } })), null, 'need with no query');
  assert.deepEqual(searchRequestOf(d({ skipClass: 'political', search: { need: true, queries: ['a'], skipClass: 'political' } })), { refused: true, queries: [] });
});

test('overall status: material wins, then a refusal, then no source, then failure', () => {
  assert.equal(overallStatus([{ status: 'failed' }, { status: 'ok' }]), 'ok');
  assert.equal(overallStatus([{ status: 'failed' }, { status: 'refused' }]), 'refused');
  assert.equal(overallStatus([{ status: 'failed' }, { status: 'no_source' }]), 'no_source');
  assert.equal(overallStatus([{ status: 'failed' }]), 'failed');
  assert.equal(overallStatus([]), 'failed');
});

test('the source line: names the API returned, at most three, only with material', () => {
  const turn = { search: { status: 'ok' }, searchSources: ['A 报', 'B', 'C', 'D'] };
  assert.equal(sourceLine(turn), `${SOURCE_LINE_PREFIX}A 报、B、C`);
  assert.equal(withSourceLine('回答。\n', turn), '回答。\n来源：A 报、B、C');
  for (const status of ['failed', 'no_source', 'refused']) {
    assert.equal(sourceLine({ search: { status }, searchSources: ['A'] }), null, status);
    assert.equal(withSourceLine('回答。', { search: { status }, searchSources: ['A'] }), '回答。');
  }
  assert.equal(sourceLine({}), null, 'no search');
  assert.equal(sourceLine({ search: { status: 'ok' }, searchSources: [] }), null);
});
