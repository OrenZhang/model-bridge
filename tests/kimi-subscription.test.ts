import { expect, it } from 'vitest';
import { kimiSubscriptionModel, kimiSubscriptionThinking } from '../src/auth/kimi-models.js';
const entry = (protocol?: string, mode = 'both') => kimiSubscriptionModel({ id: 'declared-model', display_name: 'Provider label', protocol, reasoning: { type: mode, effort: { valid: ['low', 'high', 'max'], default: 'high' } }, limit: { context: 256000 }, supports_tool_use: true, modalities: { input: ['text', 'image'] } })!;
it('reads Kimi protocol, default effort and on/off support from the model list', () => {
  const model = entry('anthropic'); expect(model.protocols).toEqual(['messages']); expect(model.reasoning).toEqual(['high', 'low', 'max', 'none']);
  expect(model.thinking).toEqual({mode:'both',efforts:['low','high','max'],defaultEffort:'high'});
  expect(model.images).toBe(true); expect(model.contextWindow).toBe(256000);
  expect(entry('response').protocols).toEqual(['responses']); expect(entry().protocols).toEqual(['chat']);
  expect(entry('anthropic', 'only').reasoning).not.toContain('none'); expect(entry('response','none').reasoning).toEqual([]);
});
it.each(['chat','messages','responses'] as const)('uses exact server effort values on %s and leaves signed history untouched', protocol => {
  const model = entry(protocol === 'messages' ? 'anthropic' : protocol === 'responses' ? 'response' : undefined);
  const history = [{role:'assistant',content:[{type:'thinking',thinking:'fixture',signature:'original'}]}];
  const payload: any = { messages: history, thinking: {type:'enabled',budget_tokens:4096,effort:'high'}, reasoning: {effort:'high'}, output_config:{effort:'high'} };
  kimiSubscriptionThinking(payload, protocol, model, {effort:'low'});
  expect(payload.messages).toBe(history);
  if (protocol === 'chat') expect(payload.thinking).toEqual({type:'enabled',keep:'all',effort:'low'});
  if (protocol === 'messages') { expect(payload.thinking).toEqual({type:'adaptive'}); expect(payload.output_config.effort).toBe('low'); }
  if (protocol === 'responses') { expect(payload.reasoning.effort).toBe('low'); expect(payload.thinking).toBeUndefined(); }
  expect(()=>kimiSubscriptionThinking(payload,protocol,model,{effort:'medium'})).toThrow('declared');
  kimiSubscriptionThinking(payload,protocol,model,{effort:'none'});
  expect(protocol === 'responses' ? payload.reasoning.effort : payload.thinking.type).toBe(protocol === 'responses' ? 'none' : 'disabled');
});
it('enforces always-thinking/non-thinking modes and supports thinking without adjustable effort', () => {
  expect(()=>kimiSubscriptionThinking({},'chat',entry(undefined,'only'),{effort:'none'})).toThrow('cannot disable');
  const payload: any = {thinking:{type:'enabled'},output_config:{effort:'high'}};
  expect(()=>kimiSubscriptionThinking(payload,'messages',entry('anthropic','none'),{effort:'high'})).toThrow('does not support');
  kimiSubscriptionThinking(payload,'messages',entry('anthropic','none'),{}); expect(payload.thinking).toBeUndefined(); expect(payload.output_config).toBeUndefined();
  const toggle = kimiSubscriptionModel({id:'toggle',limit:{context:128000},reasoning:{type:'both'}})!;
  expect(toggle.reasoning).toEqual(['medium','none']);
  kimiSubscriptionThinking(payload,'chat',toggle,{effort:'medium'}); expect(payload.thinking).toEqual({type:'enabled',keep:'all'});
});
