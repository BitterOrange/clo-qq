// Fake model Keys for offline tests. None of them works anywhere. Tests check that no Key, fake or real, reaches a log,
// a command line, an Error or test output, so assertions name these constants and never print them.
export { FAKE_MODEL_KEY, FAKE_MODEL_KEY as FAKE_OPENROUTER_KEY } from './gateway.mjs';

export const FAKE_ANTHROPIC_KEY = 'sk-ant-FAKE-KEY-FOR-LOCAL-MOCK-ONLY';
// For the Anthropic probe's own Key name, so a probe test can tell the two Anthropic Keys apart.
export const FAKE_ANTHROPIC_PROBE_KEY = 'sk-ant-FAKE-PROBE-KEY-FOR-LOCAL-MOCK-ONLY';
