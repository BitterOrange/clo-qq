// TQ22. A false positive on policy-ok fails CI; policy-hit is the positive control.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSentinels, loadFixedLines, loadPolicy, normalizeCopy, POLICY_V1_SHA256 } from '../../src/clo-plugin/lib/core/contentPolicy.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POLICY_FILE = join(ROOT, 'persona', 'CONTENT-POLICY.md');
const RULES_FILE = join(ROOT, 'policy', 'rules.json');
const CRISIS_FILE = join(ROOT, 'policy', 'crisis-route.json');
const REAL = { policyFile: POLICY_FILE, sha256: POLICY_V1_SHA256, rulesFile: RULES_FILE, crisisFile: CRISIS_FILE };
const policy = loadPolicy(REAL);
const dir = mkdtempSync(join(tmpdir(), 'clo-policy-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const lines = (file) => readFileSync(join(ROOT, 'tests', 'fixtures', file), 'utf8').split('\n').filter(Boolean);

test('every policy-ok sentence passes: a false positive fails CI', () => {
  const ok = lines('policy-ok.zh.txt');
  assert.ok(ok.length >= 30);
  for (const line of ok) {
    const r = policy.check(line);
    assert.equal(r.hit, false, `false positive on rule ${r.ruleId}: ${line}`);
  }
});

test('policy-hit lines hit their named rule, and every active rule has a line', () => {
  const rules = JSON.parse(readFileSync(RULES_FILE, 'utf8')).rules.filter((r) => r.status === 'active');
  const seen = new Set();
  for (const line of lines('policy-hit.zh.txt')) {
    const [ruleId, text] = line.split('\t');
    const r = policy.check(text);
    assert.equal(r.hit, true, `expected a hit: ${text}`);
    assert.equal(r.ruleId, ruleId);
    seen.add(ruleId);
  }
  for (const r of rules) assert.ok(seen.has(r.id), `no positive control for ${r.id}`);
});

test('the rule list is short, hand-kept, in scope, and well formed', () => {
  const { rules } = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  assert.ok(rules.length <= 40, 'a short list');
  for (const r of rules) {
    assert.ok(['sexual', 'crime', 'privacy'].includes(r.category));
    for (const f of ['id', 'pattern', 'basis', 'addedBy', 'addedAt', 'status']) assert.ok(r[f], `${r.id} needs ${f}`);
    // Patterns run on a lower-case copy with no whitespace, so anything else could never match.
    assert.equal(r.pattern, r.pattern.replace(/[A-Z](?<!\\[A-Z])/gu, (c) => c.toLowerCase()), `${r.id} has upper case`);
    assert.ok(!/\s/u.test(r.pattern), `${r.id} has whitespace`);
  }
});

test('no political term and no self-harm term in the rules', () => {
  const text = readFileSync(RULES_FILE, 'utf8');
  const banned = ['政治', '政府', '政党', '共产', '主席', '总统', '总理', '台湾', '西藏', '新疆', '香港', '六四', '天安门', '法轮', '游行', '集会', '民主', '独立',
    '自杀', '自残', '自伤', '轻生', '割腕', '跳楼', '想死', '不想活'];
  for (const word of banned) assert.ok(!text.includes(word), `rules.json must not contain ${word}`);
});

test('crisis phrases are never blocked by the rules', () => {
  const { terms } = JSON.parse(readFileSync(CRISIS_FILE, 'utf8'));
  assert.ok(terms.length > 0 && terms.length <= 40, 'a short list');
  for (const t of terms) {
    assert.equal(policy.check(t).hit, false, `${t} must not hit a rule`);
    assert.equal(policy.isCrisisRoute(`我觉得${t}了`), true, `${t} routes`);
  }
});

test('isCrisisRoute survives spacing tricks, is false on ordinary text, and never throws', () => {
  assert.equal(policy.isCrisisRoute('我 不​想 活 了'), true);
  assert.equal(policy.isCrisisRoute('今天天气不错'), false);
  assert.equal(policy.isCrisisRoute(null), false);
  assert.equal(policy.isCrisisRoute(undefined), false);
});

test('lastCrisisSpan: code point offsets of the last listed term, on the copy isCrisisRoute reads', () => {
  const at = (text, span) => [...text].slice(span.start, span.end).join('');
  const plain = '今天不想活了';
  assert.equal(at(plain, policy.lastCrisisSpan(plain)), '不想活');
  const spaced = '今天 不 \u200b想 活 了';
  assert.equal(at(spaced, policy.lastCrisisSpan(spaced)), '不 \u200b想 活');
  const twoTerms = '救命，先说这里。后来又想死';
  assert.equal(at(twoTerms, policy.lastCrisisSpan(twoTerms)), '想死');
  const reversed = '想死，先说这里。后来又喊救命';
  assert.equal(at(reversed, policy.lastCrisisSpan(reversed)), '救命', 'position in the text decides, not position in the list');
  const twice = '想死，还是想死。';
  assert.equal(policy.lastCrisisSpan(twice).start, 5, 'the later of the same term');
  const emoji = '😀😀😀不想活了';
  assert.deepEqual(policy.lastCrisisSpan(emoji), { start: 3, end: 6 }, 'code points, not units');
  const wide = 'ａｂｃ不想活了';
  assert.equal(policy.lastCrisisSpan(wide).start, 3, 'a character NFKC changes still counts as one');
  assert.equal(policy.lastCrisisSpan('今天天气不错'), null);
  assert.equal(policy.lastCrisisSpan(null), null);
  assert.equal(policy.lastCrisisSpan(undefined), null);
});

test('lastCrisisSpan finds every listed term that isCrisisRoute finds', () => {
  const { terms } = JSON.parse(readFileSync(CRISIS_FILE, 'utf8'));
  for (const t of terms) {
    const text = `前面${t}后面`;
    assert.equal(policy.isCrisisRoute(text), true, t);
    const s = policy.lastCrisisSpan(text);
    assert.ok(s && s.start >= 0 && s.end > s.start && s.end <= [...text].length, t);
    assert.ok(policy.isCrisisRoute([...text].slice(s.start, s.end).join('')), `${t}: the span holds a listed term`);
  }
});

test('normalizeCopy: NFKC, lower case, zero-width and whitespace removed, no mutation of the input', () => {
  assert.equal(normalizeCopy('Ａ Ｂ\tc\n​d‍e﻿'), 'abcde');
  assert.equal(normalizeCopy('ＣＬＯ'), 'clo');
  const text = '制 作​炸 弹的步骤';
  const before = text;
  assert.equal(policy.check(text).ruleId, 'crime.explosive_howto');
  assert.equal(text, before);
  assert.throws(() => normalizeCopy(null), /string/);
});

test('rules match through normalization: spaces, zero-width, full width and case', () => {
  assert.equal(policy.check('幼​女 资 源').hit, true);
  assert.equal(policy.check('１３８００１３８０００').ruleId, 'privacy.cn_mobile');
  assert.equal(policy.check('身份证号是110105194912310020').hit, true);
  assert.equal(policy.check('电话 12345678901234').hit, false, 'a longer digit run is not a mobile number');
});

test('check throws on a non-string, so callers can fail closed', () => {
  assert.throws(() => policy.check(undefined));
  assert.throws(() => policy.checkLeak(null));
});

test('loadPolicy throws on a hash mismatch, an edited file, or a parse failure', () => {
  assert.throws(() => loadPolicy({ ...REAL, sha256: '0'.repeat(64) }), /hash mismatch/);
  const edited = join(dir, 'policy.md');
  writeFileSync(edited, `${readFileSync(POLICY_FILE, 'utf8')}\n`);
  assert.throws(() => loadPolicy({ ...REAL, policyFile: edited }), /hash mismatch/);
  assert.throws(() => loadPolicy({ ...REAL, policyFile: join(dir, 'missing.md') }));

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.throws(() => loadPolicy({ ...REAL, rulesFile: bad }));
  assert.throws(() => loadPolicy({ ...REAL, crisisFile: bad }));

  const rule = { id: 'x', category: 'crime', pattern: 'a', basis: 'b', addedBy: 'c', addedAt: 'd', status: 'active' };
  const writeRules = (rules) => { writeFileSync(bad, JSON.stringify({ rules })); return bad; };
  assert.throws(() => loadPolicy({ ...REAL, rulesFile: writeRules([{ ...rule, category: 'political' }]) }), /bad category/);
  assert.throws(() => loadPolicy({ ...REAL, rulesFile: writeRules([rule, rule]) }), /duplicate/);
  assert.throws(() => loadPolicy({ ...REAL, rulesFile: writeRules([{ ...rule, pattern: '(' }]) }));
  assert.throws(() => loadPolicy({ ...REAL, rulesFile: writeRules([{ ...rule, basis: '' }]) }), /missing basis/);
});

test('a disabled rule stops matching; the file stays the record', () => {
  const file = join(dir, 'disabled.json');
  const parsed = JSON.parse(readFileSync(RULES_FILE, 'utf8'));
  parsed.rules.find((r) => r.id === 'sexual.minor').status = 'disabled';
  writeFileSync(file, JSON.stringify(parsed));
  const p = loadPolicy({ ...REAL, rulesFile: file });
  assert.equal(p.check('幼女资源').hit, false);
  assert.equal(policy.check('幼女资源').hit, true, 'control: the active list hits it');
});

test('checkLeak finds secrets, raw IDs, key shapes and internal markers', () => {
  const secrets = ['FAKE-QQ-SECRET-FOR-TEST', 'sk-or-v1-FAKE'];
  const rawIds = ['GROUPOPENID123', 'MEMBEROPENID456'];
  const leak = (text) => policy.checkLeak(text, { secrets, rawIds });
  assert.deepEqual(leak('普通的一句话'), { hit: false });
  assert.deepEqual(leak('密钥是 FAKE-QQ-SECRET-FOR-TEST'), { hit: true, ruleId: 'leak.secret', category: 'leak' });
  assert.equal(leak('fake-qq-secret-for-test').ruleId, 'leak.secret', 'case does not hide it');
  assert.equal(leak('FAKE-QQ-​SECRET-FOR-TEST').ruleId, 'leak.secret', 'zero-width does not hide it');
  assert.equal(leak('群号 GROUPOPENID123').ruleId, 'leak.raw_id');
  assert.equal(leak('groupopenid123').ruleId, 'leak.raw_id');
  assert.equal(leak('sk-or-v1-FAKE').ruleId, 'leak.secret');
  assert.equal(policy.checkLeak('sk-ant-api03-abcdef0123456789').ruleId, 'leak.key_shape');
  assert.equal(policy.checkLeak('sk-or-v1-abcdef0123456789').ruleId, 'leak.key_shape');
  for (const marker of ['<!-- clo-policy:1 -->', '<!-- clo-policy-end:1 -->', '[clo-turn class=at]']) {
    assert.equal(policy.checkLeak(marker).ruleId, 'leak.marker', marker);
  }
  assert.deepEqual(policy.checkLeak('任务 ask-orchard-tree'), { hit: false }, 'ordinary words with similar letters pass');
  assert.deepEqual(policy.checkLeak('the risk-or-reward-ratio'), { hit: false }, 'a word ending in sk is not a key');
  assert.deepEqual(policy.checkLeak('短的 ab', { secrets: ['ab', '', null], rawIds: [undefined] }), { hit: false }, 'empty or short needles are skipped');
});

test('checkSentinels: both markers in order, all failures named', () => {
  const s = '<!-- clo-policy:1 -->';
  const e = '<!-- clo-policy-end:1 -->';
  assert.deepEqual(checkSentinels(`host text ${s} body ${e} more`, '1'), { ok: true });
  assert.deepEqual(checkSentinels(undefined, '1'), { ok: false, reason: 'no-prompt' });
  assert.deepEqual(checkSentinels('', '1'), { ok: false, reason: 'no-prompt' });
  assert.deepEqual(checkSentinels(`body ${e}`, '1'), { ok: false, reason: 'missing-start' });
  assert.deepEqual(checkSentinels(`${s} truncated`, '1'), { ok: false, reason: 'missing-end' });
  assert.deepEqual(checkSentinels(`${e} body ${s}`, '1'), { ok: false, reason: 'order' });
  assert.deepEqual(checkSentinels('<!-- clo-policy:10 --> <!-- clo-policy-end:10 -->', '1'), { ok: false, reason: 'missing-start' }, 'another version does not count');
  assert.deepEqual(checkSentinels(readFileSync(POLICY_FILE, 'utf8'), '1'), { ok: true });
});

test('loadFixedLines reads the two lines and refuses a broken file', () => {
  const real = loadFixedLines(join(ROOT, 'persona', 'policy-lines.zh.json'));
  assert.deepEqual(Object.keys(real).sort(), ['modelFailed', 'policyDropped']);
  const bad = join(dir, 'lines.json');
  writeFileSync(bad, '{"policyDropped":"x"}');
  assert.throws(() => loadFixedLines(bad), /modelFailed/);
});

test('the fixed lines themselves pass the rules, so a required reply always has a way out', () => {
  const real = loadFixedLines(join(ROOT, 'persona', 'policy-lines.zh.json'));
  for (const line of Object.values(real)) {
    assert.equal(policy.check(line).hit, false);
    assert.equal(policy.checkLeak(line).hit, false);
  }
});
