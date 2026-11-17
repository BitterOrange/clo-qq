// The own runtime with search turned on, on both chat kinds (search step 2 and 3: harness, Key and ledger; the gate's
// search step is not written yet). The real bot process, mock QQ, the mock chat provider and, on anthropic, a mock
// OpenRouter of its own for search (decision D5), behind a net guard that lets the bot reach those mocks only.
// What it shows: the effective file with search on is one the bot runs on; the bot holds the search Key under its child
// name only; the ledger reads the search Key, with that Key, at the search mock; an @ is still answered; and nothing
// is searched yet.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fullAt, nextId } from '../fixtures/qq-events.mjs';
import { FAKE_ANTHROPIC_KEY, FAKE_MODEL_KEY, FAKE_SEARCH_KEY, netAttempts, startOwnStack, until } from '../harness/own.mjs';

const stacks = [];
after(async () => {
  for (const s of stacks) {
    await s.stop().catch(() => {});
    s.cleanup();
  }
});

for (const provider of ['openrouter', 'anthropic']) {
  test(`search on, chat on ${provider}: the bot runs, reads the search Key at the search mock with that Key, and still answers`, { timeout: 180000 }, async () => {
    const s = await startOwnStack({ label: `search-${provider}`, provider, search: true, start: false, script: () => ({ text: '可洛的回复。' }) });
    stacks.push(s);
    assert.ok(s.search, 'a mock answers search');
    assert.equal(s.search === s.model, provider === 'openrouter', 'on anthropic, search has a mock OpenRouter of its own');
    // The search Key's limit as the config names it, so the read finds nothing to note.
    s.search.setKey({ limit: 0.5, limit_remaining: 0.5, usage_daily: 0 }, FAKE_SEARCH_KEY);
    assert.equal(s.eff.search.provider, 'openrouter-sonar');
    assert.deepEqual(s.eff.search.price, { inputPerM: 3, outputPerM: 15, requestUsd: 0.005 });
    assert.equal(s.eff.search.baseUrl, s.search.base);
    assert.equal(s.env.CLO_SEARCH_KEY, FAKE_SEARCH_KEY, 'the bot gets the search Key under its child name');
    assert.equal('CLO_SEARCH_API_KEY' in s.env, false, 'never under the .env name');
    assert.notEqual(s.env.CLO_SEARCH_KEY, s.env.OPENROUTER_API_KEY);

    await s.start();
    const reads = await until(() => {
      const r = s.search.keyReads().filter((k) => k.key === FAKE_SEARCH_KEY);
      return r.length >= 1 ? r : null;
    }, 'the ledger to read the search Key', 30000, 50);
    assert.ok(reads.length >= 1);
    if (provider === 'anthropic') {
      assert.deepEqual(s.search.keyReads().filter((k) => k.key !== FAKE_SEARCH_KEY), [], 'nothing else is read at the search mock');
      assert.equal(s.search.keyReads().some((k) => k.key === FAKE_ANTHROPIC_KEY), false);
    } else {
      // Control: on OpenRouter the chat Key is read at the same mock, with its own Key.
      await until(() => s.model.keyReads().some((k) => k.key === FAKE_MODEL_KEY), 'the chat Key read', 30000, 50);
    }

    const id = nextId();
    s.send(fullAt('最近有什么新闻？', { id }));
    const row = await s.waitRow(id);
    assert.equal(row.state, 'completed');
    await s.waitPosts(1);
    assert.equal(s.agentRequests().length, 1, 'control: the @ reached the chat model');
    assert.equal(s.search.searchRequests().length, 0, 'nothing searches before the gate step exists');
    assert.equal(s.control('search_paused'), null, 'a clean search Key read pauses nothing');
    assert.equal(s.control('paid_paused'), null);
    assert.equal(s.alerts().some((a) => a.kind === 'search_key_limit_mismatch'), false);
    assert.deepEqual(netAttempts(s), []);
    assert.equal(s.logs().includes(FAKE_SEARCH_KEY), false, 'the Key is in no output');
  });
}
