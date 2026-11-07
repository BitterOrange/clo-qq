// The adapter for a provider kind. One per kind, fixed here; nothing picks an adapter from a file.
import { anthropicAdapter } from './anthropicAdapter.js';
import { openrouterAdapter } from './openrouterAdapter.js';

const ADAPTERS = Object.freeze({ openrouter: openrouterAdapter, anthropic: anthropicAdapter });

export function adapterFor(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(ADAPTERS, kind)) throw new TypeError('unknown provider kind');
  return ADAPTERS[kind];
}
