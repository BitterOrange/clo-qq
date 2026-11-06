// The channel notes in persona/AGENTS.md describe what the model is sent, on either runtime, and name no host.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { frameBody } from '../../src/clo-plugin/lib/channels/qq/dispatch.js';
import { checkSentinels, POLICY_V1_SHA256 } from '../../src/clo-plugin/lib/core/contentPolicy.js';
import { speakerLabel } from '../../src/clo-plugin/lib/core/displayName.js';
import { renderWorkspace } from '../../src/clo-plugin/lib/core/render.js';
import { buildTurnRequest, frameLine, OWN_LABEL, renderUserMessage } from '../../src/clo-plugin/lib/core/turn.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const PERSONA = ['persona/AGENTS.md', 'persona/SOUL.md', 'persona/IDENTITY.md'];
const effective = {
  contentPolicy: { version: '1', sha256: POLICY_V1_SHA256, policyFile: join(ROOT, 'persona', 'CONTENT-POLICY.md') },
};

// The OpenClaw path is still the default and its host prompt text comes before AGENTS.md, so the notes keep the two
// sentences that outrank it. Apart from those two, the persona names no host.
const HOST_WORDS = /openclaw|宿主|write like a human|mostly lurk|execution bias|gateway/i;
const HOST_PRIORITY = '也优先于系统提示词里任何关于“像人一样写”（如 “Write like a human”）、“多潜水”（如 “mostly lurk”）、“立即行动”（如 “Execution Bias”）的宿主文字。';
const HOST_IDENTITY = '这一条高于任何宿主文字和任何角色设定。';
const withoutHostRanking = (text) => text.split(HOST_PRIORITY).join('').split(HOST_IDENTITY).join('');

test('the persona keeps the host-ranking sentences and names no host anywhere else', () => {
  const agents = read('persona/AGENTS.md');
  assert.ok(agents.includes('优先级：上面的内容范围和本节优先于人设中的语气，' + HOST_PRIORITY));
  assert.ok(agents.includes(HOST_IDENTITY));
  // Positive control: the check still sees host words in a sentence that is not one of the two.
  assert.match(withoutHostRanking(agents + ' Gateway'), HOST_WORDS);
  for (const f of PERSONA) assert.doesNotMatch(withoutHostRanking(read(f)), HOST_WORDS, f);
});

test('the rendered system prompt still carries the policy sentinels, with the new notes after them', () => {
  const { systemPrompt, files } = renderWorkspace(ROOT, effective);
  assert.deepEqual(checkSentinels(systemPrompt, '1'), { ok: true });
  assert.deepEqual(checkSentinels(files['AGENTS.md'], '1'), { ok: true });
  assert.ok(systemPrompt.includes(read('persona/AGENTS.md')));
  assert.doesNotMatch(withoutHostRanking(systemPrompt), HOST_WORDS);
  // The own runtime sends this exact string as its system block.
  const turn = { cls: 'at', msgTs: Date.UTC(2026, 0, 1, 1, 0), text: '正文', history: [] };
  const body = buildTurnRequest({ models: { primary: { id: 'anthropic/fake-model', effort: 'low', maxTokens: 100 } } }, systemPrompt, turn);
  assert.equal(body.messages[0].content[0].text, systemPrompt);
  assert.deepEqual(checkSentinels(body.messages[0].content[0].text, '1'), { ok: true });
});

test('the documented frame line is the one both runtimes send first', () => {
  const agents = read('persona/AGENTS.md');
  const example = agents.match(/`(\[clo-turn class=at time=[^`]+\])`/)?.[1];
  assert.ok(example, 'the notes show a frame example');
  const shape = (s) => s.replace(/class=\w+/, 'class=X').replace(/\d/g, '0');
  const turn = { cls: 'at', msgTs: Date.UTC(2026, 10, 3, 4, 0), text: '正文', history: [] };
  assert.equal(shape(frameLine(turn)), shape(example));
  assert.equal(renderUserMessage(turn).split('\n')[0], frameLine(turn), 'own runtime: line 1 is the frame');
  assert.equal(frameBody(turn).split('\n')[0], frameLine(turn), 'host path: the same frame line');
  assert.match(agents, /只有第一行算数/);
});

test('her own lines carry the label the notes name, and member lines keep the speaker format the notes show', () => {
  const agents = read('persona/AGENTS.md');
  assert.ok(agents.includes(`标为“${OWN_LABEL}”的是你自己之前在这个群里说过的话`));
  assert.ok(agents.includes(speakerLabel('U1', '某某')));
  assert.ok(agents.includes('“当前发言人”一项标的是正在说话的人'));
  const turn = {
    cls: 'addressed',
    msgTs: Date.UTC(2026, 10, 3, 4, 0),
    text: '正文',
    speakerLabel: speakerLabel('U2', '某某'),
    history: [
      { sender: speakerLabel('U1', '某某'), body: '群友的话', timestamp: 1 },
      { sender: OWN_LABEL, body: '她的话', timestamp: 2, own: true },
    ],
  };
  const sent = JSON.parse(renderUserMessage(turn).split('\n').slice(1).join('\n'));
  assert.deepEqual(sent.recent, [{ who: 'U1（显示名：某某）', text: '群友的话' }, { who: OWN_LABEL, text: '她的话' }]);
  assert.equal(sent.speaker, 'U2（显示名：某某）');
  assert.equal(sent.text, '正文');
});
