// The OpenRouter chat client, shared by the decision call and the main turn: the common transport in
// providers/modelChat.js with the OpenRouter adapter. Kept under this name so its callers and their tests stay as they
// were. It never fetches by itself.
import { createChatClient, isConnectFailure } from './providers/modelChat.js';
import { mapUsage, openrouterAdapter } from './providers/openrouterAdapter.js';

export { isConnectFailure, mapUsage };

// The adapter is fixed: options can never point this client at another provider's shapes.
export function createOpenRouterClient(options = {}) {
  return createChatClient({ ...options, adapter: openrouterAdapter });
}
