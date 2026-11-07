import { registerTaskAgents } from '../../src/extension.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function probe(pi: ExtensionAPI) {
  pi.registerProvider('owned-local', { baseUrl: 'http://127.0.0.1:9', api: 'openai-completions', apiKey: '$OWNED_FIXTURE_API_KEY',
    models: [{ id: 'scripted', name: 'Owned scripted provider', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const child = JSON.stringify(context).includes('## Delegated Task Contract');
      const done = context.messages.some(message => message.role === 'toolResult' && message.toolName === (child ? 'write' : 'task'));
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: done ? 'stop' : 'toolUse',
        content: done ? [{ type: 'text', text: child ? 'OFFICIAL_CHILD_OK' : 'OFFICIAL_PARENT_OK' }] : [{ type: 'toolCall',
          id: child ? 'owned-write' : 'owned-task', name: child ? 'write' : 'task', arguments: child
            ? { path: 'official-child.txt', content: 'OFFICIAL_WRITTEN' }
            : { agent_name: 'worker', description: 'Official CLI task', prompt: 'Write only official-child.txt with the owned marker.' } }],
      };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: message.stopReason, message }; }, result: async () => message } as any;
    },
  });
  pi.on('tool_call', event => {
    if (event.toolName === 'write' && process.env.OWNED_DENY_WRITE === '1') return { block: true, reason: 'OWNED_CLI_DENIAL' };
  });
  registerTaskAgents(pi);
}
