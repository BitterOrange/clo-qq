// Slash text on the real host. The host takes its own command words at the start of a message, with or without arguments,
// and starts no model for them when the sender is not authorized: an @ like that ends required_no_text with the failure
// line. Any other slash text it hands to the model. So the gate keeps a first word shaped like a command away from the
// host, passes the rest as plain text, and does not let a slash word cost a person in danger their answer.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, MEMBER, OWNER, sleep, startStack, unexpectedNetAttempts } from '../harness/gateway.mjs';

const REPLY = '普通回答。';
const CRISIS = '我真的不想活了';
const PLAIN_SLASH = [`/(ㄒoㄒ)/~~ ${CRISIS}`, '/usr/bin 是什么', '/usr/bin', '/开始 帮我看看', '/ status', '/', '//注释 是什么', '/stop了', '/stop!', '/new。'];
const SHAPED = ['/help', '/foo bar', '/new@bot', '/think:high 你好', '/think high 你好', '/model x', '/new 你好'];
// Unsettled holds pile up where the host runs no model, and this file is not about the budget.
const roomy = { budget: { dailyUsd: 1000, addressedUsd: 1000, namedUsd: 1000, interjectUsd: 1000, searchUsd: 1000 } };
const end = (row) => `${row.state}:${row.reason}`;
let s;

before(async () => {
  s = await startStack({ label: 'slash', groups: { [GROUP_A]: { owners: [OWNER] } }, script: () => ({ text: REPLY }), effective: roomy });
  await s.waitConnected();
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

async function ask(text, member) {
  const id = nextId();
  const posts = s.postBodies().length;
  const requests = s.model.agentRequests().length;
  const alerts = s.alerts().length;
  push(s, fullAt(text, { id, member }));
  const row = await s.waitRow(id, 150000);
  await sleep(200);
  const asked = s.model.agentRequests().slice(requests);
  return {
    row,
    asked: asked.length,
    inPrompt: asked.length > 0 && JSON.stringify(asked.at(-1).body.messages).includes(JSON.stringify(text).slice(1, -1)),
    posts: s.postBodies().slice(posts).map((p) => p.content),
    alerts: s.alerts().slice(alerts).map((a) => a.kind),
  };
}

for (const [who, member] of [['member', MEMBER], ['owner', OWNER]]) {
  describe(who, () => {
    test('slash text with no command-shaped first word reaches the model and is answered', async () => {
      for (const text of PLAIN_SLASH) {
        const r = await ask(text, member);
        assert.equal(end(r.row), 'completed:sent', text);
        assert.equal(r.row.cls, 'at', text);
        assert.equal(r.asked, 1, text);
        assert.equal(r.inPrompt, true, text);
        assert.deepEqual(r.posts, [REPLY], text);
      }
    });

    test('a command-shaped first word stays away from the host: no model, no reply', async () => {
      for (const text of SHAPED) {
        const r = await ask(text, member);
        assert.equal(end(r.row), `ignored:${member === OWNER ? 'cmd_unknown' : 'cmd_non_owner'}`, text);
        assert.equal(r.asked, 0, text);
        assert.deepEqual(r.posts, [], text);
      }
    });

    test('danger words after a word the host hands on: the model answers', async () => {
      const r = await ask(`/help ${CRISIS}`, member);
      assert.equal(end(r.row), 'completed:sent');
      assert.equal(r.asked, 1);
      assert.equal(r.inPrompt, true);
      assert.deepEqual(r.posts, [REPLY]);
    });

    test('danger words after a word the host keeps: no model, but the failure line says where to find help', async () => {
      const r = await ask(`/think high ${CRISIS}`, member);
      assert.equal(end(r.row), 'failed:required_no_text');
      assert.equal(r.asked, 0);
      assert.equal(r.posts.length, 1);
      assert.match(r.posts[0], /急救|报警/);
      assert.deepEqual(r.alerts, ['model_failed']);
    });
  });
}

test('plain slash text with no @ goes the ordinary way, not the command way', async () => {
  const id = nextId();
  const requests = s.model.requests.length;
  push(s, plain('/usr/bin 是什么东西', { id, member: MEMBER }));
  const row = await s.waitRow(id, 60000);
  assert.equal(end(row), 'skipped:interject_off');
  assert.equal(row.cls, 'ordinary');
  assert.equal(s.model.requests.length, requests);
});

test('positive control: the owner\'s real command still works after all of the above', async () => {
  const r = await ask('/status', OWNER);
  assert.equal(r.row.reason, 'cmd_owner');
  assert.equal(r.asked, 0);
  assert.match(r.posts[0], /模式/);
});

test('last: every POST on this stack is legal', () => {
  assertEveryPostLegal(s, { minPosts: 6 });
  assert.deepEqual(unexpectedNetAttempts(s.gw), []);
});
