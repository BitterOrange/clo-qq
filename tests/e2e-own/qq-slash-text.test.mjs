// Slash text on the own runtime. There is no host command parser any more, so only the listed owner commands are
// commands (contract 9). Every other slash text, whatever its first word looks like, is ordinary text: an @ like that
// is answered by the model, and a slash word in front of danger words never costs the person their answer.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { assertEveryPostLegal, GROUP_A, MEMBER, netAttempts, OWNER, sleep, startOwnStack } from '../harness/own.mjs';

const REPLY = '普通回答。';
const CRISIS = '我真的不想活了';
const PLAIN_SLASH = [`/(ㄒoㄒ)/~~ ${CRISIS}`, '/usr/bin 是什么', '/usr/bin', '/开始 帮我看看', '/ status', '/', '//注释 是什么', '/stop了', '/stop!', '/new。'];
// Words the host used to keep from the model. With no host they are just words.
const SHAPED = ['/help', '/foo bar', '/new@bot', '/think:high 你好', '/think high 你好', '/model x', '/new 你好'];
// Listed command words with danger words after them: the arguments make them no command, so the model answers.
const DANGER = [`/help ${CRISIS}`, `/think high ${CRISIS}`, `/stop ${CRISIS}`, `/clo pause ${CRISIS}`];
const roomy = { budget: { dailyUsd: 1000, addressedUsd: 1000, namedUsd: 1000, interjectUsd: 1000, searchUsd: 1000 } };
const end = (row) => `${row.state}:${row.reason}`;
const payloadOf = (rec) => {
  const c = rec.body.messages.find((m) => m.role === 'user').content;
  return JSON.parse(c.slice(c.indexOf('\n') + 1));
};
let s;

before(async () => {
  s = await startOwnStack({ label: 'slash', groups: { [GROUP_A]: { owners: [OWNER] } }, script: () => ({ text: REPLY }), effective: roomy });
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
    inPrompt: asked.length > 0 && payloadOf(asked.at(-1)).text === text,
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

    test('a command-shaped first word that is not a listed command is ordinary text too: answered once', async () => {
      for (const text of SHAPED) {
        const r = await ask(text, member);
        assert.equal(end(r.row), 'completed:sent', text);
        assert.equal(r.row.cls, 'at', text);
        assert.equal(r.asked, 1, text);
        assert.equal(r.inPrompt, true, text);
        assert.deepEqual(r.posts, [REPLY], text);
      }
    });

    test('danger words after any slash word: the model answers, no failure line', async () => {
      for (const text of DANGER) {
        const r = await ask(text, member);
        assert.equal(end(r.row), 'completed:sent', text);
        assert.equal(r.asked, 1, text);
        assert.equal(r.inPrompt, true, text);
        assert.deepEqual(r.posts, [REPLY], text);
        assert.deepEqual(r.alerts.filter((a) => a === 'model_failed'), [], text);
      }
    });
  });
}

test('a listed command from a member stays a command: ignored, no model (the control for the rows above)', async () => {
  const r = await ask('/clo pause', MEMBER);
  assert.equal(end(r.row), 'ignored:cmd_non_owner');
  assert.equal(r.asked, 0);
  assert.deepEqual(r.posts, []);
  assert.equal(s.control(`group_paused:${s.key(GROUP_A)}`), null);
});

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
  assert.deepEqual(netAttempts(s), []);
});
