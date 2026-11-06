// On the own runtime: a line with its own turn still to come is not in the prompt of the turn before it. Two name
// messages in separate windows with a slow decision, read off the request the model provider actually receives.
// There is no host transcript, so the single user message, its recent list and its text, is the whole prompt.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { nextId, plain, push } from '../fixtures/qq-events.mjs';
import { decisionText } from '../harness/mock-openrouter.mjs';
import { assertAgentRequest } from '../harness/gateway.mjs';
import { assertEveryPostLegal, GROUP_A, MEMBER, MEMBER2, netAttempts, startOwnStack, until } from '../harness/own.mjs';

const REPLY = decisionText({ action: 'reply' });
const SLOW_MS = 2500;
const promptOf = (rec) => JSON.stringify(rec.body.messages);
const payloadOf = (rec) => {
  const c = rec.body.messages.find((m) => m.role === 'user').content;
  return JSON.parse(c.slice(c.indexOf('\n') + 1));
};
const recentOf = (rec) => JSON.stringify(payloadOf(rec).recent);

let s;
// How many of the coming decisions are slow.
let slow = 0;

before(async () => {
  s = await startOwnStack({
    label: 'pending',
    groups: { [GROUP_A]: { nameMention: true } },
    decision: () => {
      if (slow > 0) {
        slow -= 1;
        return { text: REPLY, delayMs: SLOW_MS };
      }
      return { text: REPLY };
    },
    script: () => ({ text: '看过了。' }),
  });
});

after(async () => {
  await s?.stop();
  s?.cleanup();
});

test('two name messages in separate windows: the first request lacks the second message, and the second request has the first', async () => {
  const FIRST = '可洛，今天星期几 PENDINGFIRST4471';
  const SECOND = '可洛，算了，直接告诉我 12 乘 12 等于几 PENDINGSECOND4471';
  const a = nextId();
  const b = nextId();
  slow = 1;
  push(s, plain(FIRST, { id: a, member: MEMBER }));
  // The first window has closed and its decision is out, so the second opens a window of its own.
  await until(() => s.model.decisionRequests().length === 1, 'the first decision');
  push(s, plain(SECOND, { id: b, member: MEMBER }));
  await until(() => s.row(b)?.state === 'queued', 'the second message waiting');
  // Queued means it is in the buffer. With the decision unanswered, the first turn cannot have been built yet.
  assert.equal(s.model.decisionRequests()[0].answeredAt, undefined, 'the second was buffered before the first turn could be built');
  const [first, second] = await Promise.all([s.waitRow(a), s.waitRow(b)]);
  assert.equal(first.cls, 'name_addressed');
  assert.equal(second.cls, 'name_addressed');
  assert.equal(`${first.state}:${first.reason}`, 'completed:sent');
  assert.equal(`${second.state}:${second.reason}`, 'completed:sent');

  assert.equal(s.model.decisionRequests().length, 2, 'one decision each: separate windows');
  const requests = s.model.agentRequests();
  assert.equal(requests.length, 2, 'one turn each');
  assertAgentRequest(requests[0]);
  assert.ok(payloadOf(requests[0]).text.includes('PENDINGFIRST4471'), 'positive control: the first turn is about the first');
  assert.ok(!promptOf(requests[0]).includes('PENDINGSECOND4471'), 'the second has its own turn coming');
  assert.ok(payloadOf(requests[1]).text.includes('PENDINGSECOND4471'), 'positive control: the second turn is about the second');
  assert.ok(recentOf(requests[1]).includes('PENDINGFIRST4471'), 'the first has ended, so it is context');
  assert.ok(payloadOf(requests[1]).recent.some((r) => r.who === '可洛'), 'and so is her answer to it');
  assert.equal(s.messagePosts().length, 2);
});

test('plain chat arriving during the decision does reach the prompt', async () => {
  const QUESTION = '可洛，帮我看看退货 CHATQUESTION4471';
  const CHATTER = '不对，我说的是换货 CHATLINE4471';
  const a = nextId();
  const c = nextId();
  const turns = s.model.agentRequests().length;
  const decisions = s.model.decisionRequests().length;
  slow = 1;
  push(s, plain(QUESTION, { id: a, member: MEMBER }));
  await until(() => s.model.decisionRequests().length === decisions + 1, 'the decision');
  push(s, plain(CHATTER, { id: c, member: MEMBER2 }));
  await Promise.all([s.waitRow(a), s.waitRow(c)]);
  const fresh = s.model.agentRequests().slice(turns);
  assert.equal(fresh.length, 1, 'chat has no turn of its own here');
  assert.ok(payloadOf(fresh[0]).text.includes('CHATQUESTION4471'), 'positive control');
  assert.ok(recentOf(fresh[0]).includes('CHATLINE4471'));
});

test('three lines in one window: another person\'s request lacks the line merged into a turn still to come, and that turn has it', async () => {
  const QUESTION = '可洛，今天星期几 MERGEDFIRST4471';
  const OTHER = '可洛今天开会是几点 MERGEDOTHER4471';
  const WITHDRAW = '可洛，算了，直接告诉我 12 乘 12 等于几 MERGEDLAST4471';
  const a = nextId();
  const b = nextId();
  const c = nextId();
  const turns = s.model.agentRequests().length;
  push(s, plain(QUESTION, { id: a, member: MEMBER }));
  push(s, plain(OTHER, { id: b, member: MEMBER2 }));
  push(s, plain(WITHDRAW, { id: c, member: MEMBER }));
  const [first] = await Promise.all([s.waitRow(a), s.waitRow(b), s.waitRow(c)]);
  assert.equal(first.state, 'merged', 'three lines reached one window');
  const fresh = s.model.agentRequests().slice(turns);
  assert.equal(fresh.length, 2);
  assert.ok(payloadOf(fresh[0]).text.includes('MERGEDOTHER4471'), 'positive control: the other person leads');
  assert.ok(!promptOf(fresh[0]).includes('MERGEDFIRST4471'));
  assert.ok(!promptOf(fresh[0]).includes('MERGEDLAST4471'));
  assert.ok(payloadOf(fresh[1]).text.includes('MERGEDLAST4471'), 'positive control');
  assert.ok(recentOf(fresh[1]).includes('MERGEDFIRST4471'), 'its target stands on it');
});

test('last: every POST on this stack is legal, and nothing left the two mocks', () => {
  assertEveryPostLegal(s, { minPosts: 5 });
  assert.deepEqual(netAttempts(s), []);
});
