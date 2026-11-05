// The one tool this build registers. It is inert: it exists so tools.allow is never empty.
export const TOOL_NAME = 'clo_feature_status';

export function registerTools(api) {
  api.registerTool({
    name: TOOL_NAME,
    label: 'Clo feature status',
    description: 'Reports that this build has no optional features enabled.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'no optional features enabled' }], details: {} }),
  });
}
