import type { Connection } from '../core/config.js';

// Official first-run MiniMax Code catalog, pinned in docs/provider-auth.md.
// A preset is a model ID, not a promise of access under a particular plan.
export function minimaxPresetModels(connection: Connection) {
  if (connection.provider !== 'minimax') return undefined;
  const base = connection.baseUrl.replace(/\/+$/, '');
  if (![
    'https://agent.minimax.cn/mavis/api/v1/llm/v1', 'https://agent.minimax.io/mavis/api/v1/llm/v1',
    'https://api.minimaxi.com/anthropic/v1', 'https://api.minimax.io/anthropic/v1',
  ].includes(base)) return undefined;
  return ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'].map(id => ({ id, name: id, contextWindow: id.includes('M3') ? 512000 : 200000, images: false, protocols: ['messages'], tools: true, ...(connection.auth === 'subscription' ? { reasoning: id === 'MiniMax-M3.1-Flash' ? ['medium', 'low', 'high', 'xhigh', 'max'] : id === 'MiniMax-M3' ? ['medium', 'none'] : ['medium'] } : {}) }));
}
