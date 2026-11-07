// expect: model-sdk-import as: lib/core/providers/anthropicAdapter.js
import Anthropic from '@anthropic-ai/sdk';
export const client = () => new Anthropic({ maxRetries: 0 });
