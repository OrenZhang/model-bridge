import { expect, it } from 'vitest';
import { minimaxSubscriptionThinking } from '../src/auth/minimax-thinking.js';
import { minimaxPresetModels } from '../src/auth/provider-models.js';
import { ConnectionSchema } from '../src/core/config.js';
it('uses the official forced-on payload and keeps independent output settings and signed history intact', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'fixture', signature: 'original-signature' }] }];
  const payload: any = { messages, thinking: { type: 'adaptive', budget_tokens: 4096 }, output_config: { effort: 'high', format: { type: 'json_schema' } } };
  minimaxSubscriptionThinking(payload, 'MiniMax-M3.1-Flash', { effort: 'low' });
  expect(payload.thinking).toBeUndefined(); expect(payload.output_config).toEqual({ effort: 'low', format: { type: 'json_schema' } });
  expect(payload.messages).toBe(messages);
  minimaxSubscriptionThinking(payload, 'MiniMax-M3.1-Flash', {effort:'default'});
  expect(payload.output_config.effort).toBe('default');
  minimaxSubscriptionThinking(payload, 'MiniMax-M3.1-Flash', {});
  expect(payload.output_config).toEqual({ format: { type: 'json_schema' } });
  expect(() => minimaxSubscriptionThinking(payload, 'MiniMax-M3.1-Flash', { effort: 'none' })).toThrow('disabling');
  expect(() => minimaxSubscriptionThinking(payload, 'MiniMax-M3.1-Flash', { effort: 'ultra' })).toThrow('selected thinking effort');
});
it.each([['medium', 'adaptive'], ['none', 'disabled']])('maps M3 %s to its official thinking toggle without a budget or effort', (effort, type) => {
  const payload: any = { thinking: { type: 'enabled', budget_tokens: 4096 }, output_config: { effort: 'high' } };
  minimaxSubscriptionThinking(payload, 'MiniMax-M3', { effort });
  expect(payload.thinking).toEqual({ type }); expect(payload.output_config).toBeUndefined();
});
it('leaves the M2.7 thinking default intact and only advertises supported subscription controls', () => {
  const payload = { model: 'MiniMax-M2.7', messages: [] };
  minimaxSubscriptionThinking(payload, payload.model, { effort: 'medium' });
  expect(payload).toEqual({ model: 'MiniMax-M2.7', messages: [] });
  const c = ConnectionSchema.parse({ id: 'mm', name: 'MiniMax', provider: 'minimax', auth: 'subscription', baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm/v1' });
  const models = minimaxPresetModels(c)!;
  expect(models.find(m => m.id === 'MiniMax-M3.1-Flash')!.reasoning).toEqual(['medium', 'low', 'high', 'xhigh', 'max']);
  expect(models.find(m => m.id === 'MiniMax-M3')!.reasoning).toEqual(['medium', 'none']);
  expect(models.find(m => m.id === 'MiniMax-M2.7')!.reasoning).toEqual(['medium']);
});
