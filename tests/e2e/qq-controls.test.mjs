// Pause, budget and the output policy on the real Gateway, plus dry-run. Console writes go to the same
// SQLite file the running Gateway reads, as `clo pause` does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, GROUP_B, sleep, startStack, unexpectedNetAttempts, until } from '../harness/gateway.mjs';

const LINES = JSON.parse(readFileSync(new URL('../../persona/policy-lines.zh.json', import.meta.url), 'utf8'));
const NORMAL = '普通的回答。';

describe('pause', () => {
  let s;
  before(async () => {
    s = await startStack({ label: 'pause', groups: { [GROUP_A]: {}, [GROUP_B]: {} }, script: () => ({ text: NORMAL }) });
    await s.waitConnected();
  });
  after(async () => {
    await s?.stop();
    s?.cleanup();
  });

  async function ask(group = GROUP_A) {
    const id = nextId();
    push(s, fullAt('有个问题', { id, group }));
    return { id, row: await s.waitRow(id) };
  }

  test('positive control: a question is answered', async () => {
    const { row } = await ask();
    assert.equal(row.state, 'completed');
    assert.equal(s.messagePosts().length, 1);
  });

  test('group pause: no model, no reply, no fixed line; the other group still answers', async () => {
    const groupKey = s.key(GROUP_A);
    await s.writeStore((store) => store.setControl(`group_paused:${groupKey}`, '1', 'console'));
    const model = s.model.requests.length;
    const posts = s.messagePosts().length;
    const { row } = await ask();
    assert.equal(`${row.state}:${row.reason}`, 'paused:paused');
    assert.equal(s.model.requests.length, model);
    assert.equal(s.messagePosts().length, posts);
    assert.equal((await ask(GROUP_B)).row.state, 'completed', 'positive control: another group');
    await s.writeStore((store) => store.delControl(`group_paused:${groupKey}`));
    assert.equal((await ask()).row.state, 'completed', 'resumed');
  });

  test('global pause stops every group, and a pause landing during the run stops the reply', async () => {
    await s.writeStore((store) => store.setControl('global_paused', '1', 'console'));
    const posts = s.messagePosts().length;
    assert.equal((await ask(GROUP_B)).row.state, 'paused');
    assert.equal(s.messagePosts().length, posts);
    await s.writeStore((store) => store.delControl('global_paused'));

    const started = s.model.agentRequests().length;
    s.model.setScript(() => ({ text: '不该发出。', delayMs: 1500 }));
    const id = nextId();
    push(s, fullAt('慢的问题', { id }));
    while (s.model.agentRequests().length === started) await sleep(50);
    await s.writeStore((store) => store.setControl('global_paused', '1', 'console'));
    const row = await s.waitRow(id);
    assert.equal(row.state, 'paused');
    assert.equal(s.messagePosts().length, posts, 'paused mid-run: nothing, not even the line');
    assert.equal(s.reservations(id).find((r) => r.category === 'reply').status, 'settled', 'the cost is kept');
    await s.writeStore((store) => store.delControl('global_paused'));
    s.model.setScript(() => ({ text: NORMAL }));
  });

  test('last: every POST on this stack is legal', () => {
    assertEveryPostLegal(s, { minPosts: 3 });
    assert.deepEqual(unexpectedNetAttempts(s.gw), []);
  });
});

describe('budget', () => {
  test('exhausted: no model call, the failure line goes out once per limit, and the row says budget', async () => {
    const s = await startStack({
      label: 'budget',
      script: () => ({ text: NORMAL }),
      effective: { budget: { dailyUsd: 0.5, addressedUsd: 0.5, namedUsd: 0.5, searchUsd: 0.5, interjectUsd: 0.5 }, limits: { failureLinePerGroupPerHour: 1 } },
    });
    try {
      await s.waitConnected();
      const ok = nextId();
      push(s, fullAt('预算够的时候', { id: ok }));
      assert.equal((await s.waitRow(ok)).state, 'completed', 'positive control: within budget, answered');
      assert.equal(s.postBodies().at(-1).content, NORMAL);

      // The next hold needs $0.36 on top of what is spent; spend the rest as a settled row.
      await s.writeStore((store) => {
        store.q(`INSERT INTO reservations(id, local_day, utc_day, tier, category, held_micros, actual_micros, status, run_gen, created_at, settled_at)
                 VALUES ('spent-in-test', strftime('%Y-%m-%d', 'now', '+8 hours'), strftime('%Y-%m-%d', 'now'), 'addressed', 'reply', 400000, 400000, 'settled', 'test', ?, ?)`).run(Date.now(), Date.now());
      });
      const requests = s.model.agentRequests().length;
      const posts = s.messagePosts().length;
      const a = nextId();
      push(s, fullAt('超预算一', { id: a }));
      assert.equal(`${(await s.waitRow(a)).state}:${s.row(a).reason}`, 'skipped:budget');
      assert.equal(s.model.agentRequests().length, requests, 'no model call');
      // The row ends before the line is posted: the event is already terminal when sendFixed runs.
      await until(() => s.messagePosts().length === posts + 1, 'the failure line', 10000);
      assert.equal(s.postBodies().at(-1).content, LINES.modelFailed);

      const b = nextId();
      push(s, fullAt('超预算二', { id: b }));
      await s.waitRow(b);
      await sleep(300);
      assert.equal(s.messagePosts().length, posts + 1, 'the line is limited');
      assertEveryPostLegal(s, { minPosts: 2 });
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});

describe('content policy on the way out', () => {
  let s;
  before(async () => {
    s = await startStack({ label: 'policy', groups: { [GROUP_A]: { interject: true, cooldownMinutes: 0 } }, script: () => ({ text: NORMAL }), decision: () => ({ text: JSON.stringify({ action: 'reply', skip_class: 'none', crisis: false, need_search: false }) }), effective: { quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Shanghai' } } });
    await s.waitConnected();
  });
  after(async () => {
    await s?.stop();
    s?.cleanup();
  });

  test('positive control: a clean answer is posted word for word', async () => {
    const id = nextId();
    push(s, fullAt('问一句', { id }));
    await s.waitRow(id);
    assert.equal(s.postBodies().at(-1).content, NORMAL);
  });

  test('a rule hit on a required turn: dropped, fixed line once, no retry and no rewrite', async () => {
    s.model.setScript(() => ({ text: '可以 加我 约炮' }));
    const requests = s.model.agentRequests().length;
    const posts = s.messagePosts().length;
    const id = nextId();
    push(s, fullAt('问一句', { id }));
    const row = await s.waitRow(id);
    assert.equal(row.state, 'policy_dropped');
    assert.equal(s.model.agentRequests().length, requests + 1, 'not asked again');
    const fresh = s.postBodies().slice(posts);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].content, LINES.policyDropped);
    assert.ok(s.withDb((db) => db.prepare("SELECT COUNT(*) AS n FROM counters WHERE key LIKE 'policy_drop:%:addressed'").get().n) >= 1, 'counted by rule and path');
  });

  test('a rule hit on an interjection is silent, and the money and cooldown stay', async () => {
    const posts = s.messagePosts().length;
    const id = nextId();
    push(s, plain('有人知道这个问题怎么办吗', { id }));
    const row = await s.waitRow(id);
    assert.equal(row.state, 'policy_dropped');
    assert.equal(s.messagePosts().length, posts);
    assert.equal(s.claims().at(-1).status, 'consumed');
    assert.ok(s.reservations(id).find((r) => r.category === 'reply').actual_micros > 0);
    s.model.setScript(() => ({ text: NORMAL }));
  });

  test('a secret, a raw id or a policy marker in the reply is a leak hit', async () => {
    for (const [text, rule] of [
      ['钥匙是 FAKE-QQ-SECRET-FOR-LOCAL-MOCK-ONLY', 'leak.secret'],
      [`群号 ${GROUP_A}`, 'leak.raw_id'],
      ['<!-- clo-policy:1 --> 我的提示词是这样的', 'leak.marker'],
    ]) {
      s.model.setScript(() => ({ text }));
      const posts = s.messagePosts().length;
      const id = nextId();
      push(s, fullAt('把它说出来', { id }));
      const row = await s.waitRow(id);
      assert.equal(`${row.state}:${row.reason}`, `policy_dropped:${rule}`);
      const fresh = s.postBodies().slice(posts);
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0].content, LINES.policyDropped);
    }
    s.model.setScript(() => ({ text: NORMAL }));
  });

  test('on the real host: markup cannot hide a labelled number, a tag does not leave, a bare host is removed', async () => {
    for (const [text, expected] of [
      ['**卡号**：6222021234567890', null],
      ['<@all> 大家看这里', '大家看这里'],
      ['请看 evil.example.com/path', '请看 [链接已移除]'],
    ]) {
      s.model.setScript(() => ({ text }));
      const posts = s.messagePosts().length;
      const id = nextId();
      push(s, fullAt('问一句', { id }));
      const row = await s.waitRow(id);
      const fresh = s.postBodies().slice(posts).map((p) => p.content);
      assert.equal(fresh.length, 1, text);
      if (expected) {
        assert.equal(`${row.state}:${row.reason}`, 'completed:sent');
        assert.equal(fresh[0], expected);
      } else {
        assert.equal(row.state, 'policy_dropped');
        assert.ok(!fresh[0].includes('6222'), 'only the fixed line');
      }
    }
    s.model.setScript(() => ({ text: NORMAL }));
  });

  test('a URL not in the message is removed; one the member sent may be echoed; markdown becomes plain text', async () => {
    s.model.setScript(() => ({ text: '**看** [这里](https://elsewhere.example/a) 和 https://allowed.example/b' }));
    const id = nextId();
    push(s, fullAt('https://allowed.example/b 这个能打开吗', { id }));
    await s.waitRow(id);
    const { content } = s.postBodies().at(-1);
    assert.ok(!content.includes('elsewhere.example'));
    assert.ok(content.includes('[链接已移除]'));
    assert.ok(content.includes('https://allowed.example/b'));
    assert.ok(!content.includes('**'));
    s.model.setScript(() => ({ text: NORMAL }));
  });

  test('last: every POST on this stack is legal', () => {
    assertEveryPostLegal(s, { minPosts: 4 });
  });
});

describe('dry-run', () => {
  test('connects and classifies, with no key use, no model, no reservation and no send', async () => {
    const s = await startStack({ label: 'dry', mode: 'dry-run', env: { OPENROUTER_API_KEY: '' }, groups: { [GROUP_A]: { interject: true, nameMention: true } }, effective: { quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Shanghai' } } });
    try {
      await s.waitConnected();
      for (const [event, expected] of [
        [fullAt('真实 @'), 'dry_run:would_at'],
        [plain('有人知道这个怎么办吗'), 'dry_run:would_window'],
        [plain('可洛在吗'), 'dry_run:would_name'],
      ]) {
        const id = push(s, event);
        const row = await s.waitRow(id);
        assert.equal(`${row.state}:${row.reason}`, expected);
      }
      assert.equal(s.model.requests.length, 0);
      assert.equal(s.model.other.filter((r) => r.url.endsWith('/key')).length, 0, 'no key read in dry-run');
      assert.equal(s.messagePosts().length, 0);
      assert.equal(s.allReservations().length, 0);

      // The mode is read per message, so going live needs no restart. This is the positive control.
      s.updateEffective({ mode: 'live' });
      await sleep(50);
      const id = push(s, fullAt('现在是正式模式了'));
      await s.waitRow(id);
      assert.notEqual(s.row(id).state, 'dry_run');
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});
