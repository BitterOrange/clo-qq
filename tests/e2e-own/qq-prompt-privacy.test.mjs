// The own runtime counterpart of tests/e2e/qq-prompt-privacy.test.mjs. Every request the bot makes to the model, the
// main turns and the judging calls, is scanned for machine, account and raw ID details and for attribution headers,
// with positive controls that the policy, the message and her own earlier line did arrive. The host's fallback prompt
// has no counterpart: with privacy.replaceSystemPrompt off the bot still sends only its own prompt.
// On either provider kind: the body is read through the model view, and each kind's Key header is checked by name.
import assert from 'node:assert/strict';
import { hostname, userInfo } from 'node:os';
import { describe, test } from 'node:test';
import { fullAt, nextId, plain } from '../fixtures/qq-events.mjs';
import { decisionText } from '../harness/model-view.mjs';
import {
  APP_ID, BOT_MEMBER, FAKE_ANTHROPIC_KEY, FAKE_MODEL_KEY, FAKE_QQ_SECRET, GROUP_A, MEMBER, netAttempts, OWNER, PROVIDER, ROOT, sleep, startOwnStack,
} from '../harness/own.mjs';

const CANARY = '隐私测试金丝雀PRIVACYCANARY5521';
const FIRST_REPLY = '第一条回复OWNLINE7731。';
const FORBIDDEN = (s) => [
  ['hostname', hostname()],
  ['windows user', userInfo().username],
  ['project root', ROOT],
  ['temp path', s.tmp],
  ['raw group', GROUP_A],
  ['raw member', MEMBER],
  ['raw owner', OWNER],
  ['bot member', BOT_MEMBER],
  ['appId', APP_ID],
  ['model key', FAKE_MODEL_KEY],
  ['anthropic key', FAKE_ANTHROPIC_KEY],
  ['qq secret', FAKE_QQ_SECRET],
  ['display name', 'SENDER-DISPLAY-NAME'],
  ['bot display name', 'BOT-DISPLAY-NAME'],
  ['windows nt', 'Windows_NT'],
];
// Header names a client library or the host would add to say who is calling. The bot sends none of them.
const ATTRIBUTION = /^(http-referer|referer|x-title|x-stainless-.*|x-openclaw-.*|openai-.*|user-agent-openclaw)$/i;

function scan(s, bodies) {
  const joined = bodies.join('\n');
  for (const [what, needle] of FORBIDDEN(s)) {
    assert.ok(!joined.includes(needle), `${what} reached a model`);
    assert.ok(!joined.toLowerCase().includes(String(needle).toLowerCase().replaceAll('\\', '\\\\')), `${what} reached a model (case or escape)`);
  }
}

async function exercise(s) {
  const first = nextId();
  s.send(fullAt(CANARY, { id: first }));
  await s.waitRow(first);
  await s.waitPosts(1);
  // Her reply is now in the group's memory, so the next turn's history carries her own line.
  const second = nextId();
  s.send(fullAt('刚才说的是什么意思', { id: second }));
  await s.waitRow(second);
  const ordinary = nextId();
  s.send(plain('有人知道这个问题怎么办吗', { id: ordinary }));
  await s.waitRow(ordinary);
  await sleep(300);
}

describe('the own runtime prompt', () => {
  test('no machine, account or raw ID detail in any model body or header; policy, canary and her line are present', async () => {
    let n = 0;
    const s = await startOwnStack({
      provider: PROVIDER,
      label: 'priv',
      groups: { [GROUP_A]: { interject: true, cooldownMinutes: 0 } },
      script: () => {
        n += 1;
        return { text: n === 1 ? FIRST_REPLY : '好的。' };
      },
      decision: () => ({ text: decisionText({ action: 'reply' }) }),
      effective: { quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Shanghai' } },
    });
    try {
      await exercise(s);
      const agent = s.agentRequests();
      assert.ok(agent.length >= 3, `main turns: ${agent.length}`);
      assert.ok(s.decisionRequests().length >= 1, 'positive control: the judging model was called too');
      const bodies = s.modelRequests().map((r) => JSON.stringify(r.body));
      const joined = bodies.join('\n');
      assert.ok(joined.includes('clo-policy:1') && joined.includes('clo-policy-end:1'), 'positive control: the policy block');
      assert.ok(joined.includes(CANARY), 'positive control: the message');
      const user = s.view(agent[1]).user;
      const recent = JSON.parse(user.slice(user.indexOf('\n') + 1)).recent;
      assert.ok(recent.some((h) => h.who === '可洛' && h.text === FIRST_REPLY), 'positive control: her own line is in the history');
      assert.ok(recent.some((h) => h.text === CANARY && h.who !== '可洛'), 'and the member line before it');
      scan(s, bodies);
      for (const r of agent) assert.equal(r.body.user, undefined, 'no user field');
      for (const r of s.modelRequests()) {
        if (s.kind === 'openrouter') {
          assert.equal(r.headers.authorization, `Bearer ${FAKE_MODEL_KEY}`, 'positive control: the headers were recorded');
        } else {
          assert.ok(s.keySent(r, FAKE_ANTHROPIC_KEY), 'positive control: the headers were recorded');
          assert.equal(r.headers.authorization, undefined);
        }
        assert.deepEqual(Object.keys(r.headers).filter((h) => ATTRIBUTION.test(h)), [], 'no attribution header');
        // The one header that may carry the active Key is left out; every other Key and detail is scanned for.
        scan(s, [JSON.stringify({ ...r.headers, authorization: undefined, 'x-api-key': undefined }), r.url]);
      }
      const system = s.kind === 'openrouter' ? agent[0].body.messages.filter((m) => m.role === 'system').map((m) => JSON.stringify(m.content)).join('\n') : s.view(agent[0]).system;
      assert.doesNotMatch(system, /^#+\s*(Tooling|Execution Bias|Runtime Context|OpenClaw Control|Documentation)\b/m, 'no host sections');
      assert.doesNotMatch(system, /Your text replies are automatically sent/);
      assert.deepEqual(netAttempts(s), []);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });

  test('privacy.replaceSystemPrompt off: the system text is still the rendered file, and the scan still holds', async () => {
    const s = await startOwnStack({ provider: PROVIDER, label: 'priv-off', effective: { privacy: { replaceSystemPrompt: false } }, script: () => ({ text: '好的。' }) });
    try {
      const id = nextId();
      s.send(fullAt(CANARY, { id }));
      await s.waitRow(id);
      const req = s.agentRequests()[0];
      assert.ok(req, 'the model was called');
      const system = s.kind === 'openrouter' ? req.body.messages.find((m) => m.role === 'system').content.map((c) => c.text).join('') : s.view(req).system;
      assert.equal(system, s.systemPrompt, 'the same prompt: there is no host prompt to fall back to');
      assert.ok(JSON.stringify(req.body).includes(CANARY));
      scan(s, [JSON.stringify(req.body)]);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});
