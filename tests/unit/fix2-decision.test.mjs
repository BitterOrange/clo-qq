// The decision excerpt's focus and the decision hold: both measured against what really goes out.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadPolicy, mappedCopy, POLICY_V1_SHA256 } from '../../src/clo-plugin/lib/core/contentPolicy.js';
import { estimateTokens } from '../../src/clo-plugin/lib/core/context.js';
import { buildRequest, shapeCurrentText } from '../../src/clo-plugin/lib/core/decision.js';
import { classify } from '../../src/clo-plugin/lib/core/gate.js';
import { DECISION_INPUT_TOKENS } from '../../src/clo-plugin/lib/core/ledger.js';
import { buildPlan, FIXED, suggestConfig } from '../../src/tools/q5-probe.mjs';
import { decisionOf, inbound, makeHarness, ROOT } from '../fixtures/inbound.mjs';

const dir = mkdtempSync(join(tmpdir(), 'clo-fix2-decision-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const PROMPT = readFileSync(join(ROOT, 'persona', 'decision-prompt.zh.md'), 'utf8');
const RETENTION = { decisionLines: 15, decisionLineChars: 200, decisionCurrentChars: 800 };
const REQUEST_EFF = { models: { decision: { id: 'm', effort: 'none', maxTokens: 200 } }, retention: RETENTION };
const estimateOf = (input) => estimateTokens(JSON.stringify(buildRequest(REQUEST_EFF, PROMPT, input).messages));
const largest = (fill) => estimateOf({
  trigger: 'crisis_route',
  lines: Array.from({ length: 15 }, () => ({ sender: 'U99999', text: fill.repeat(200) })),
  current: { sender: 'U99999', text: fill.repeat(800) },
});

// Each code point as it stands in the measured body: JSON in the user message, then JSON again around messages.
function worstFill() {
  let worst = null;
  let most = 0;
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    const ch = String.fromCodePoint(cp);
    let ascii = 0;
    let other = 0;
    for (const unit of JSON.stringify(JSON.stringify(ch)).slice(3, -3)) {
      if (unit.codePointAt(0) < 128) ascii += 1;
      else other += 1;
    }
    const cost = other * 2 + ascii / 3;
    if (cost > most) {
      most = cost;
      worst = ch;
    }
  }
  return worst;
}

test('the hold covers the largest input under its own estimator, for the worst character there is', () => {
  const fill = worstFill();
  const worst = largest(fill);
  assert.ok(worst > largest('长'), 'positive control: non-ASCII is not the worst case');
  assert.ok(worst > 9000, 'positive control: this is more than the old hold');
  assert.ok(worst <= DECISION_INPUT_TOKENS, `input of ${worst} tokens, ${DECISION_INPUT_TOKENS} held`);
  for (const other of ['\u0001', '\u001f', '\ud83d', '\udc00']) assert.equal(largest(other), worst, 'one of the worst class');
});

test('through the gate: control characters reach the request and the reservation covers them', async () => {
  const h = makeHarness({ decide: async () => decisionOf({ action: 'skip' }) });
  for (let i = 0; i < 15; i += 1) await h.sendAndFlush(h.event({ text: '\u0001'.repeat(300) }));
  await h.sendAndFlush(h.event({ text: `可洛${'\u0001'.repeat(798)}` }));
  const call = h.decideCalls.at(-1);
  assert.equal(call.trigger, 'name');
  assert.equal(call.lines.length, 15, 'positive control: nothing filtered these lines');
  assert.equal([...call.lines[0].text].length, 200);
  assert.equal([...call.current.text].length, 800);
  const row = h.store.q("SELECT held_micros AS held FROM reservations WHERE category='decision' ORDER BY created_at DESC LIMIT 1").get();
  const { price, maxTokens } = h.eff.current.models.decision;
  const input = estimateTokens(JSON.stringify(buildRequest(h.eff.current, PROMPT, call).messages));
  assert.ok(input > 9000, 'positive control: above the old hold');
  assert.ok(row.held >= Math.ceil(input * price.inputPerM + maxTokens * price.outputPerM), `${row.held} micros held for ${input} tokens`);
  await h.close();
});

test('the probe scales its hold suggestion to the same worst input', () => {
  const plan = buildPlan(ROOT);
  const base = { plan, turns: [], lag: null, prices: null };
  const observed = 2000;
  const calls = [{ id: 'decision_with_prompt', class: 'ok', role: 'decision', promptTokens: observed, completionTokens: 10, finishReason: 'stop' }];
  const hold = suggestConfig({ ...base, calls }).find((s) => s.name === 'ledger.decisionHoldInputTokens');
  const short = estimateTokens(JSON.stringify(buildRequest(REQUEST_EFF, plan.texts.decisionPrompt, FIXED.decisionInput).messages));
  const estimate = (fill) => estimateTokens(JSON.stringify(buildRequest(REQUEST_EFF, plan.texts.decisionPrompt, {
    trigger: 'crisis_route',
    lines: Array.from({ length: 15 }, (_, i) => ({ sender: `U${1000 + i}`, text: fill.repeat(200) })),
    current: { sender: 'U9999', text: fill.repeat(800) },
  }).messages));
  assert.equal(hold.basis, 'largest_input_above_hold');
  assert.equal(hold.suggested, Math.ceil(observed * estimate(worstFill()) / short));
});

const NAMES = ['可洛', '可洛小姐', 'Clo'];
const shapeEff = (names) => ({ names, retention: { decisionCurrentChars: 800, decisionLineChars: 200 } });
const dots = (s) => s.split('…').length - 1;
const wrap = (mid) => `${'前'.repeat(2000)}${mid}${'后'.repeat(2000)}`;

test('a name that only composes as a whole string classifies as a name and gets its window, as typed', () => {
  for (const [name, typed, label] of [
    ['é', 'é', 'base and combining mark'],
    ['が', 'が', 'kana and voicing mark'],
    ['ガ', 'ｶﾞ', 'halfwidth kana, whose mark is not a mark until NFKC'],
    ['카', '카', 'conjoining jamo, which are letters'],
    ['각', '각', 'three jamo'],
    ['Renée', 'Renée', 'inside a longer name'],
  ]) {
    assert.equal(classify(inbound({ text: wrap(typed) }), { hasBotRef: () => false, names: [name] }).cls, 'name', `positive control: ${label}`);
    const out = shapeCurrentText(shapeEff([name]), wrap(typed));
    assert.ok(out.includes(typed), label);
    assert.equal(dots(out), 2, label);
    assert.ok([...out].length <= 800, label);
  }
});

test('the focus never disagrees with the classifier: a mark that changes the last letter means no name', () => {
  const text = wrap('Cló');
  assert.equal(classify(inbound({ text }), { hasBotRef: () => false, names: NAMES }).cls, 'ordinary');
  assert.equal(dots(shapeCurrentText(shapeEff(NAMES), text)), 1);
  const plain = wrap('可洛́');
  assert.equal(classify(inbound({ text: plain }), { hasBotRef: () => false, names: NAMES }).cls, 'name');
  assert.ok(shapeCurrentText(shapeEff(NAMES), plain).includes('可洛́'), 'a mark that composes with nothing stays with the name');
});

test('mappedCopy reads as the whole string does, and its offsets are in code points of the text', () => {
  const nfkc = (s) => s.normalize('NFKC');
  for (const text of [
    '',
    'plain',
    'é',
    '́leading mark',
    'á̴ composes past a mark that does not',
    'aﾞ́ halfwidth mark first',
    'ｶ̴ﾞ',
    'ẹ̇ reordered',
    'ﬁ́ expands, then composes',
    '각ᄀ',
    '각',
    '😀é😀',
    '\ud83d lone \udc00',
    '㌔ＡＢ',
  ]) {
    assert.equal(mappedCopy(text, nfkc).copy, nfkc(text), JSON.stringify(text));
  }
  const { copy, from, to } = mappedCopy('😀éz', nfkc);
  assert.equal(copy, '😀éz');
  const at = copy.indexOf('é');
  assert.deepEqual([from[at], to[at]], [1, 3], 'the run, in code points');
  assert.deepEqual([from[at + 1], to[at + 1]], [3, 4]);
  const wide = mappedCopy('前㌔后', nfkc);
  assert.equal(wide.copy, '前キロ后');
  assert.deepEqual(wide.from, [0, 1, 1, 2]);
  assert.deepEqual(wide.to, [1, 2, 2, 3]);
});

test('mappedCopy never shapes more than a bounded piece of a long run of mixed marks', () => {
  const nfkc = (s) => s.normalize('NFKC');
  const measured = (text) => {
    const sizes = [];
    const mapped = mappedCopy(text, (run) => {
      sizes.push([...run].length);
      return nfkc(run);
    });
    return { ...mapped, largest: Math.max(...sizes) };
  };
  const longest = 'a' + '̴́'.repeat(15);
  assert.equal(measured(longest).copy, nfkc(longest), 'stream-safe text, 30 marks, still reads as the whole string');
  assert.equal(measured(longest).largest, 31, 'positive control: that is one run');

  const text = `a${'̴́'.repeat(5000)}z`;
  const { copy, from, to, largest } = measured(text);
  assert.ok(largest <= 32, `shaped ${largest} code points at once`);
  assert.deepEqual([...copy].sort(), [...nfkc(text)].sort(), 'cut, not lost');
  assert.deepEqual([from[copy.length - 1], to[copy.length - 1]], [10001, 10002], 'offsets still count from the start');
});

test('a term after a long run of mixed marks is still found, at its real offsets', () => {
  const policy = loadPolicy({
    policyFile: join(ROOT, 'persona', 'CONTENT-POLICY.md'),
    sha256: POLICY_V1_SHA256,
    rulesFile: join(ROOT, 'policy', 'rules.json'),
    crisisFile: join(ROOT, 'policy', 'crisis-route.json'),
  });
  const run = `a${'̴́'.repeat(100)}`;
  const text = `${run}想死${run}`;
  assert.equal(policy.isCrisisRoute(text), true, 'positive control');
  assert.deepEqual(policy.lastCrisisSpan(text), { start: 201, end: 203 });
  const shaped = shapeCurrentText(shapeEff(['可洛']), `${run.repeat(20)}可洛${run.repeat(20)}`);
  assert.equal(dots(shaped), 2, 'the name still gets its window');
  assert.ok(shaped.includes('可洛'));
});

test('a span ending just past the head counts to the end of its run, so the head cut cannot split the name', () => {
  const name = 'é';
  const text = `${'前'.repeat(199)}${name}${'中'.repeat(1000)}想死${'后'.repeat(2000)}`;
  const start = [...text].indexOf('想');
  const out = shapeCurrentText(shapeEff(['é']), text, { start, end: start + 2 });
  assert.ok(out.includes('想死'), 'positive control: the crisis window is there, so the head stops at 200');
  assert.ok(out.includes(name), 'the name stays whole');
  assert.ok([...out].length <= 800);
});

test('lastCrisisSpan finds a term that only composes as a whole string, as isCrisisRoute does', () => {
  const crisisFile = join(dir, 'crisis.json');
  writeFileSync(crisisFile, JSON.stringify({ terms: ['がんばれない', 'é'] }));
  const policy = loadPolicy({
    policyFile: join(ROOT, 'persona', 'CONTENT-POLICY.md'),
    sha256: POLICY_V1_SHA256,
    rulesFile: join(ROOT, 'policy', 'rules.json'),
    crisisFile,
  });
  const text = '前がんばれない后';
  assert.equal(policy.isCrisisRoute(text), true, 'positive control');
  assert.deepEqual(policy.lastCrisisSpan(text), { start: 1, end: 8 }, 'the whole term, marks included');
  assert.deepEqual(policy.lastCrisisSpan('前É后'), { start: 1, end: 3 });
});

test('the shaped text sent to the decision keeps the name through the gate', async () => {
  const h = makeHarness({ decide: async () => decisionOf({ action: 'skip' }) });
  h.eff.current = { ...h.eff.current, names: ['é'] };
  await h.sendAndFlush(h.event({ text: wrap('é') }));
  const call = h.decideCalls.at(-1);
  assert.equal(call.trigger, 'name');
  assert.ok(call.current.text.includes('é'));
  await h.close();
});
