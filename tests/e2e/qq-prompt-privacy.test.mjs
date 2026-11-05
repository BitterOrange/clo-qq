// A3 and the prompt privacy scan. Every model request body in the run is checked for machine and account
// details, with positive controls that the policy and the message did arrive. The second stack records
// what the host prompt leaves when the replacement is off.
import assert from 'node:assert/strict';
import { hostname, userInfo } from 'node:os';
import { describe, test } from 'node:test';
import { fullAt, nextId, plain, push } from '../fixtures/qq-events.mjs';
import { decisionText } from '../harness/mock-openrouter.mjs';
import { APP_ID, assertAgentRequest, BOT_MEMBER, FAKE_MODEL_KEY, FAKE_QQ_SECRET, GROUP_A, MEMBER, ROOT, startStack, unexpectedNetAttempts } from '../harness/gateway.mjs';

const CANARY = '隐私测试金丝雀PRIVACYCANARY5521';
const FORBIDDEN = (s) => [
  ['hostname', hostname()],
  ['windows user', userInfo().username],
  ['project root', ROOT],
  ['temp path', s.tmp],
  ['raw group', GROUP_A],
  ['raw member', MEMBER],
  ['bot member', BOT_MEMBER],
  ['appId', APP_ID],
  ['model key', FAKE_MODEL_KEY],
  ['qq secret', FAKE_QQ_SECRET],
  ['display name', 'SENDER-DISPLAY-NAME'],
  ['windows nt', 'Windows_NT'],
];

async function exercise(s) {
  await s.waitConnected();
  const id = nextId();
  push(s, fullAt(CANARY, { id }));
  await s.waitRow(id);
  const ordinary = nextId();
  push(s, plain('有人知道这个问题怎么办吗', { id: ordinary }));
  await s.waitRow(ordinary);
  return { id };
}

describe('replacement on (default)', () => {
  test('no machine, account or raw ID detail in any model body; policy and canary are present', async () => {
    const s = await startStack({
      label: 'priv-on',
      groups: { [GROUP_A]: { interject: true, cooldownMinutes: 0 } },
      script: () => ({ text: '好的。' }),
      decision: () => ({ text: decisionText({ action: 'reply' }) }),
      effective: { quietHours: { start: '00:00', end: '00:00', timezone: 'Asia/Shanghai' } },
    });
    try {
      await exercise(s);
      const bodies = s.model.requests.map((r) => JSON.stringify(r.body));
      assert.ok(bodies.length >= 3, `requests: ${bodies.length}`);
      const agent = s.model.agentRequests();
      assert.ok(agent.length >= 2);
      for (const r of agent) assertAgentRequest(r);
      const joined = bodies.join('\n');
      assert.ok(joined.includes('clo-policy:1') && joined.includes('clo-policy-end:1'), 'positive control: the policy block');
      assert.ok(joined.includes(CANARY), 'positive control: the message');
      for (const [what, needle] of FORBIDDEN(s)) {
        // A short machine name could appear by chance as a word; these are long enough here.
        assert.ok(!joined.includes(needle), `${what} reached a model`);
        assert.ok(!joined.toLowerCase().includes(String(needle).toLowerCase().replaceAll('\\', '\\\\')), `${what} reached a model (case or escape)`);
      }
      const system = agent[0].body.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      // persona/AGENTS.md names those phrases to rank above them, so the host's own section headers are what is checked.
      assert.doesNotMatch(system, /^#+\s*(Tooling|Execution Bias|Runtime Context|OpenClaw Control|Documentation)\b/m, 'the host sections are gone');
      assert.doesNotMatch(system, /Your text replies are automatically sent/);
      assert.deepEqual(unexpectedNetAttempts(s.gw), []);
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});

describe('replacement off', () => {
  test('records what the host prompt carries, and the policy is still present', async () => {
    const s = await startStack({
      label: 'priv-off',
      effective: { privacy: { replaceSystemPrompt: false } },
      script: () => ({ text: '好的。' }),
    });
    try {
      await s.waitConnected();
      const id = nextId();
      push(s, fullAt(CANARY, { id }));
      await s.waitRow(id);
      const body = JSON.stringify(s.model.agentRequests()[0].body);
      assert.ok(body.includes('clo-policy:1'), 'AGENTS.md carried the block');
      assert.ok(body.includes(CANARY));
      const remains = FORBIDDEN(s).filter(([, needle]) => body.includes(needle) || body.includes(String(needle).replaceAll('\\', '\\\\'))).map(([what]) => what);
      // Not a pass or fail on the host's text: this says what DEPLOYMENT.md must disclose for this mode.
      process.stdout.write(`# fallback prompt still carries: ${remains.join(', ') || 'none of the scanned values'}\n`);
      assert.ok(!remains.includes('raw group') && !remains.includes('raw member'), 'our own IDs stay out either way');
      assert.ok(!remains.includes('model key') && !remains.includes('qq secret'));
    } finally {
      await s.stop();
      s.cleanup();
    }
  });
});
