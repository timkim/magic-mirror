// The assistant: a chat panel where Claude changes the scene, plus an MCP server for other
// Claude apps. Tools: src/assistant/toolDefs.ts and tools.ts; bridge: tools/assistant.ts.

import type { Feature } from '../core/feature';
import { connect, connectCloud } from '../assistant/client';
import AssistantPanel from './ui/AssistantPanel.svelte';

export const assistantFeature: Feature = {
  id: 'assistant',
  ui: [{ slot: 'right', component: AssistantPanel, title: 'Assistant', order: -20 }],
  init(app) {
    connect(app);
    connectCloud(app); // phone access, if this browser was paired before
  },
};
