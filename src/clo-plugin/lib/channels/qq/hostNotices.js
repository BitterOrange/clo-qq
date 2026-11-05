// Status text the locked host (OpenClaw 2026.10.9) delivers as an ordinary final payload, not marked
// isError. Its hostNotice flag lives in a WeakMap with no export under plugin-sdk, so text is all there is.
// tests/unit/host-notices.test.mjs checks this against the installed build: re-run it on every host upgrade.
export const EXACT_NOTICES = [
  "⚠️ Reply truncated at the model's output token limit. The text above is partial — ask to continue it.",
  '⚠️ Turn yielded without a continuation source. Send a message to resume.',
  '⚠️ Gateway is restarting. Please wait a few seconds and try again.',
  '⚠️ This conversation changed before your message could start. Check the latest messages, then try again if needed.',
  '⚠️ Previous run is still shutting down. Please try again in a moment.',
  'I generated a reply but could not deliver it to this chat. Please try again.',
];

// The host's own status lines start with one of these and are written in English. Clo writes Chinese, so a
// reply that opens with one and holds no Chinese at all is not hers.
const STATUS_OPENING = /^(?:⚠️?|🧹|↪️?)\s/u;
const HAS_CJK = /[㐀-鿿豈-﫿]/u;

export function isHostNotice(text) {
  const body = String(text ?? '').trim();
  if (EXACT_NOTICES.includes(body)) return true;
  return STATUS_OPENING.test(body) && !HAS_CJK.test(body);
}

// In case the host ever joins a notice onto the text it follows. Returns what is left.
export function withoutHostNotices(text) {
  let body = String(text ?? '');
  for (const notice of EXACT_NOTICES) body = body.split(notice).join('');
  return body.trim();
}
