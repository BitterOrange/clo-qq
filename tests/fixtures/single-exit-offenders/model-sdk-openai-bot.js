// expect: model-sdk-import as: services.mjs in: bot
import OpenAI from 'openai';
export const client = () => new OpenAI();
