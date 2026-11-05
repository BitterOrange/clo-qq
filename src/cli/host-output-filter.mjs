// Loaded into the Gateway with --import. The host writes provider error text straight to the console
// (defaultRuntime.error in the locked 2026.10.9), which no logging level reaches. One console call is one
// write, so a whole message goes, including any lines a provider's text put inside it.
const WITHHELD = /Embedded agent failed before reply:|lane task error:|Auto-compaction failed \(|Live model switch failed|LLM request|flagged_input/u;
const NOTE = '[clo] a host error line was withheld: it can carry provider text. See events.jsonl.\n';

export function shouldWithhold(chunk) {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  return WITHHELD.test(text);
}

function wrap(stream) {
  const real = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    if (!shouldWithhold(chunk)) return real(chunk, encoding, callback);
    const done = typeof encoding === 'function' ? encoding : callback;
    return real(NOTE, done);
  };
}

wrap(process.stdout);
wrap(process.stderr);
