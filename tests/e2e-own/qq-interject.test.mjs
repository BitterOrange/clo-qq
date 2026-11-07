// Natural interjection on the own runtime (the real bot process, mock QQ, mock OpenRouter): on and off, one decision
// per window, cooldown, quota under concurrency, a silent token costing a cooldown, and a real @ never being swallowed.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { decisionText, NEVER_SENT } from '../harness/model-view.mjs';
import { assertEveryPostLegal, GROUP_A, GROUP_B, MEMBER, MEMBER2, netAttempts, PROVIDER, sleep, startOwnStack, TEST_IDS } from '../harness/own.mjs';

const { primary: PRIMARY_ID, decision: DECISION_ID } = TEST_IDS;

const REPLY_DECISION = () => ({ text: decisionText({ action: 'reply' }) });
const SKIP_DECISION = () => ({ text: decisionText({ action: 'skip' }) });
const QUESTION = '有人知道退货要怎么办吗';
// Quiet hours would decide these tests at night.
const ALWAYS_DAY = { quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Shanghai' } };

// The main request the own runtime builds: the locked model, its output cap and effort, no tools and no fallbacks.
// On Anthropic the effort goes in output_config, and no thinking key is sent: Opus 5.5 thinking cannot be turned off.
function assertMainRequest(s, rec) {
  const { primary } = s.eff.models;
  if (s.kind === 'anthropic') {
    assert.equal(rec.body.model, PRIMARY_ID);
    assert.equal(rec.body.max_tokens, primary.maxTokens);
    assert.deepEqual(rec.body.output_config, { effort: primary.effort });
    assert.equal(rec.body.thinking, undefined);
    for (const k of NEVER_SENT.anthropic) assert.equal(rec.body[k], undefined, `no ${k}`);
    return;
  }
  assert.equal(rec.body.model, PRIMARY_ID);
  assert.equal(rec.body.stream, false);
  assert.equal(rec.body.max_tokens, primary.maxTokens);
  assert.deepEqual(rec.body.reasoning, { effort: primary.effort });
  for (const k of ['tools', 'tool_choice', 'fallbacks', 'models', 'response_format']) assert.equal(rec.body[k], undefined, `no ${k}`);
}

// On Anthropic, effort 'none' is sent as thinking disabled at effort low, with the schema in output_config.format
// (decision D9; the paid probe confirms Haiku 5.5 takes it).
function assertDecisionRequest(s, rec) {
  const { decision } = s.eff.models;
  if (s.kind === 'anthropic') {
    assert.equal(decision.effort, 'none');
    assert.equal(rec.body.model, DECISION_ID);
    assert.equal(rec.body.max_tokens, decision.maxTokens);
    assert.deepEqual(rec.body.thinking, { type: 'disabled' });
    assert.equal(rec.body.output_config.effort, 'low');
    assert.equal(rec.body.output_config.format.type, 'json_schema');
    assert.ok(s.view(rec).schema?.properties?.action, 'positive control: the decision schema went out');
    for (const k of NEVER_SENT.anthropic) assert.equal(rec.body[k], undefined, `no ${k}`);
    return;
  }
  assert.equal(rec.body.model, DECISION_ID);
  assert.equal(rec.body.stream, false);
  assert.equal(rec.body.max_tokens, decision.maxTokens);
  assert.deepEqual(rec.body.reasoning, { effort: decision.effort });
  assert.equal(rec.body.tools, undefined);
}

describe('interjection off (default)', () => {
  let s;
  before(async () => {
    s = await startOwnStack({ provider: PROVIDER, label: 'ij-off', groups: { [GROUP_A]: { interject: false } }, decision: REPLY_DECISION, script: () => ({ text: '插话。' }), effective: ALWAYS_DAY });
  });
  after(async () => {
    await s?.stop();
    s?.cleanup();
  });

  test('an ordinary message spends nothing: no decision, no model, no reply', async () => {
    const id = nextId();
    push(s, plain(QUESTION, { id }));
    const row = await s.waitRow(id);
    assert.equal(`${row.state}:${row.reason}`, 'skipped:interject_off');
    assert.equal(s.model.requests.length, 0);
    assert.equal(s.messagePosts().length, 0);
    assert.equal(s.allReservations().length, 0);
  });

  test('positive control: a real @ on the same stack is answered', async () => {
    const id = nextId();
    push(s, fullAt('你好', { id }));
    assert.equal((await s.waitRow(id)).state, 'completed');
    assert.equal(s.messagePosts().length, 1);
  });

  test('a name word with nameMention off is an ordinary message', async () => {
    const id = nextId();
    push(s, plain('可洛今天在吗', { id }));
    const row = await s.waitRow(id);
    assert.equal(row.cls, 'ordinary');
    assert.equal(row.reason, 'interject_off');
    assert.equal(s.model.decisionRequests().length, 0);
  });
});

describe('interjection on', () => {
  let s;
  const cooldown = 8;
  before(async () => {
    s = await startOwnStack({
      provider: PROVIDER,
      label: 'ij-on',
      groups: { [GROUP_A]: { interject: true, nameMention: true, cooldownMinutes: cooldown, perHour: 6, perDay: 8 }, [GROUP_B]: { interject: true, cooldownMinutes: cooldown } },
      decision: REPLY_DECISION,
      script: () => ({ text: '这里可以先查订单页面。' }),
      effective: ALWAYS_DAY,
    });
  });
  after(async () => {
    await s?.stop();
    s?.cleanup();
  });

  test('a decision skip is silent and costs no cooldown', async () => {
    s.model.setDecision(SKIP_DECISION);
    const id = nextId();
    push(s, plain('今天天气真不错啊', { id, group: GROUP_B }));
    const row = await s.waitRow(id);
    assert.equal(`${row.state}:${row.reason}`, 'skipped:decision_skip');
    assert.equal(s.model.decisionRequests().length, 1);
    assertDecisionRequest(s, s.model.decisionRequests()[0]);
    assert.equal(s.model.agentRequests().length, 0);
    assert.equal(s.messagePosts().length, 0);
    assert.equal(s.claims().at(-1).status, 'released');
    assert.ok(!JSON.stringify(s.model.decisionRequests()[0].body).includes(MEMBER), 'senders are pseudonyms');
  });

  test('invalid decision output, timeouts and errors are all a skip', async () => {
    for (const [step, reason] of [[{ text: 'not json' }, 'decision_invalid'], [{ text: '' }, 'decision_invalid'], [{ error: { status: 500 } }, 'decision_invalid']]) {
      s.model.setDecision(() => step);
      const id = nextId();
      push(s, plain('这个问题大家怎么看呢', { id, group: GROUP_B }));
      const row = await s.waitRow(id);
      assert.equal(`${row.state}:${row.reason}`, `skipped:${reason}`, JSON.stringify(step));
    }
    assert.equal(s.messagePosts().length, 0);
    assert.equal(s.model.agentRequests().length, 0, 'no main call after a failed decision');
    await s.acceptUnsettled();
  });

  test('a good interjection: one decision, one short reply, cooldown running', async () => {
    s.model.setDecision(REPLY_DECISION);
    const decisions = s.model.decisionRequests().length;
    const id = nextId();
    push(s, plain(QUESTION, { id }));
    const row = await s.waitRow(id);
    assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
    assert.equal(row.cls, 'interject');
    assert.equal(s.model.decisionRequests().length - decisions, 1);
    assert.equal(s.model.agentRequests().length, 1);
    assertMainRequest(s, s.model.agentRequests()[0]);
    const posts = s.postBodies();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].msg_id, id, 'a passive reply, tied to the message');
    assert.ok(posts[0].msg_seq >= 1);
    assert.equal(s.claims().filter((c) => c.status === 'consumed').length, 1);
    const user = s.view(s.model.agentRequests()[0]).user;
    assert.match(user, /^\[clo-turn class=interject /);
  });

  test('during the cooldown an ordinary message is skipped, and a real @ is still answered', async () => {
    const decisions = s.model.decisionRequests().length;
    const ordinary = nextId();
    push(s, plain('还有别的办法吗各位', { id: ordinary }));
    const skipped = await s.waitRow(ordinary);
    assert.equal(`${skipped.state}:${skipped.reason}`, 'skipped:cooldown');
    assert.equal(s.model.decisionRequests().length, decisions, 'no decision while cooling down');

    s.model.setScript(() => ({ text: '被问到了就答。' }));
    const posts = s.messagePosts().length;
    const at = nextId();
    push(s, fullAt('可以直接问你吗', { id: at }));
    const row = await s.waitRow(at);
    assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
    assert.equal(s.messagePosts().length, posts + 1, 'cooldown did not swallow it');
    assert.equal(s.postBodies().at(-1).content, '被问到了就答。');
  });

  test('a name word goes to the decision and, if addressed, answers as required under the named tier', async () => {
    s.model.setScript(() => ({ text: '我在。' }));
    const decisions = s.model.decisionRequests().length;
    const id = nextId();
    push(s, plain('可洛你觉得这个怎么样', { id }));
    const row = await s.waitRow(id);
    assert.equal(s.model.decisionRequests().length, decisions + 1);
    assert.equal(JSON.parse(s.view(s.model.decisionRequests().at(-1)).user).trigger, 'name');
    assert.equal(row.cls, 'name_addressed');
    assert.equal(row.state, 'completed');
    assert.equal(s.reservations(id).find((r) => r.category === 'reply').tier, 'named');
  });

  test('a name word judged not addressed is skipped, and the cooldown does not apply to name decisions', async () => {
    s.model.setDecision(SKIP_DECISION);
    const id = nextId();
    push(s, plain('可洛这个名字挺好听的', { id }));
    const row = await s.waitRow(id);
    assert.equal(`${row.state}:${row.reason}`, 'skipped:decision_skip');
    assert.equal(JSON.parse(s.view(s.model.decisionRequests().at(-1)).user).trigger, 'name');
    s.model.setDecision(REPLY_DECISION);
  });

  test('messages in one window merge: one decision, and the others end merged', async () => {
    s.model.setDecision(SKIP_DECISION);
    const decisions = s.model.decisionRequests().length;
    const ids = [nextId(), nextId(), nextId()];
    push(s, plain('第一条普通消息哈', { id: ids[0], group: GROUP_B, member: MEMBER }));
    push(s, plain('第二条普通消息哈', { id: ids[1], group: GROUP_B, member: MEMBER2 }));
    push(s, plain('第三条普通消息哈', { id: ids[2], group: GROUP_B, member: MEMBER }));
    const rows = await Promise.all(ids.map((i) => s.waitRow(i)));
    assert.equal(rows.filter((r) => r.state === 'merged').length, 2);
    assert.equal(s.model.decisionRequests().length, decisions + 1);
    s.model.setDecision(REPLY_DECISION);
  });

  test('two members using her name in one window are each decided on and each answered', async () => {
    s.model.setDecision(REPLY_DECISION);
    s.model.setScript(() => ({ text: '我看到了。' }));
    const decisions = s.model.decisionRequests().length;
    const posts = s.messagePosts().length;
    const ids = [nextId(), nextId()];
    push(s, plain('可洛今天开会是几点', { id: ids[0], member: MEMBER }));
    push(s, plain('可洛这本书好看吗', { id: ids[1], member: MEMBER2 }));
    const rows = await Promise.all(ids.map((i) => s.waitRow(i)));
    assert.deepEqual(rows.map((r) => `${r.state}:${r.cls}`), ['completed:name_addressed', 'completed:name_addressed']);
    const asked = s.model.decisionRequests().slice(decisions).map((r) => JSON.parse(s.view(r).user));
    assert.deepEqual(asked.map((d) => d.trigger), ['name', 'name']);
    assert.equal(s.messagePosts().length, posts + 2);
  });

  test('last: every POST on this stack is legal, and the bot reached nothing but the mocks', () => {
    assertEveryPostLegal(s, { minPosts: 3 });
    assert.deepEqual(netAttempts(s), []);
  });
});

describe('quota under concurrency', () => {
  test('two groups fill at once: each interjects once; the second window of the same group cannot take a claim', async () => {
    const s = await startOwnStack({
      provider: PROVIDER,
      label: 'ij-conc',
      groups: { [GROUP_A]: { interject: true, cooldownMinutes: 8, perHour: 1, perDay: 1 }, [GROUP_B]: { interject: true, cooldownMinutes: 8, perHour: 1, perDay: 1 } },
      decision: () => ({ text: decisionText({ action: 'reply' }), delayMs: 800 }),
      script: () => ({ text: '接一句。', delayMs: 500 }),
      effective: { ...ALWAYS_DAY, window: { windowMs: 100 } },
    });
    try {
      const a1 = nextId();
      const b1 = nextId();
      push(s, plain('第一组的第一条消息', { id: a1 }));
      push(s, plain('第二组的第一条消息', { id: b1, group: GROUP_B }));
      await sleep(250);
      // The first window of group A is deciding. This one closes while the claim is held.
      const a2 = nextId();
      push(s, plain('第一组的第二条消息', { id: a2 }));
      const rows = await Promise.all([a1, b1, a2].map((i) => s.waitRow(i)));
      assert.deepEqual(rows.slice(0, 2).map((r) => r.state), ['completed', 'completed'], 'positive control: each group got one');
      assert.equal(rows[2].state, 'skipped');
      assert.ok(['inflight', 'cooldown', 'hour'].includes(rows[2].reason), rows[2].reason);
      assert.equal(s.claims().filter((c) => c.status === 'consumed').length, 2);
      assert.equal(s.messagePosts().length, 2);

      // The per-hour cap holds once the cooldown no longer applies.
      s.updateEffective({ qq: { groups: { [GROUP_A]: { cooldownMinutes: 0 } } } });
      const a3 = nextId();
      push(s, plain('第一组的第三条消息', { id: a3 }));
      const third = await s.waitRow(a3);
      assert.equal(`${third.state}:${third.reason}`, 'skipped:hour');
      assert.equal(s.messagePosts().length, 2);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});

describe('a silent token on an interjection', () => {
  test('one model call, no retry, silent, cooldown consumed', async () => {
    const s = await startOwnStack({
      provider: PROVIDER,
      label: 'ij-silent',
      groups: { [GROUP_A]: { interject: true, cooldownMinutes: 8 } },
      decision: REPLY_DECISION,
      script: () => ({ text: 'NO_REPLY' }),
      effective: ALWAYS_DAY,
    });
    try {
      const id = nextId();
      push(s, plain(QUESTION, { id }));
      const row = await s.waitRow(id);
      assert.equal(row.state, 'silent');
      assert.equal(s.model.agentRequests().length, 1, 'the runner never asks again');
      assert.equal(s.messagePosts().length, 0);
      assert.equal(s.claims().at(-1).status, 'consumed', 'the cooldown runs');
      assert.equal(s.reservations(id).find((r) => r.category === 'reply').status, 'settled');

      const next = nextId();
      push(s, plain('那还有别的办法吗', { id: next }));
      assert.equal((await s.waitRow(next)).reason, 'cooldown');

      s.model.setScript(() => ({ text: '这句才发。' }));
      const at = nextId();
      push(s, fullAt('直接问你', { id: at }));
      await s.waitRow(at);
      assert.equal(s.messagePosts().length, 1, 'positive control: a required turn on the same stack does post');
      assert.equal(s.postBodies()[0].content, '这句才发。');
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});

describe('quiet hours', () => {
  test('ordinary messages stop in quiet hours and a real @ does not', async () => {
    // A window covering every minute of the day: start one minute after end.
    const s = await startOwnStack({
      provider: PROVIDER,
      label: 'ij-quiet',
      groups: { [GROUP_A]: { interject: true } },
      decision: REPLY_DECISION,
      script: () => ({ text: '夜里被问到。' }),
      effective: { quietHours: { start: '00:01', end: '00:00', timezone: 'Asia/Shanghai' } },
    });
    try {
      const ordinary = nextId();
      push(s, plain(QUESTION, { id: ordinary }));
      const row = await s.waitRow(ordinary);
      // One minute of each day is outside the window; that minute is tolerated rather than mocked.
      if (row.reason !== 'quiet') assert.equal(new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16), '00:00');
      assert.equal(s.model.decisionRequests().length, row.reason === 'quiet' ? 0 : 1);
      const at = nextId();
      push(s, fullAt('还在吗', { id: at }));
      assert.equal((await s.waitRow(at)).state, 'completed');
      assert.ok(s.messagePosts().length >= 1);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});
