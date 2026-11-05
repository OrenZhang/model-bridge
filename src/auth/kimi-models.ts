import { BridgeError, ModelSchema, type Model } from '../core/config.js';

/** The model-list contract is owned by Kimi; do not infer capabilities from names. */
export function kimiSubscriptionModel(item: any): Model | undefined {
  if (typeof item?.id !== 'string' || !item.id) return;
  const context = Number(item.limit?.context);
  if (!Number.isInteger(context) || context < 4096) throw new Error('Kimi 模型目录缺少有效的 limit.context。');
  const mode = item.reasoning?.type;
  const efforts: string[] = Array.isArray(item.reasoning?.effort?.valid) ? [...new Set(item.reasoning.effort.valid.filter((v: unknown) => typeof v === 'string' && v))] as string[] : [];
  const declaredDefault = typeof item.reasoning?.effort?.default === 'string' ? item.reasoning.effort.default : undefined;
  const defaultEffort = declaredDefault && efforts.includes(declaredDefault) ? declaredDefault : efforts[Math.floor(efforts.length / 2)];
  const thinking = ['only', 'both', 'none'].includes(mode) ? { mode, efforts, ...(defaultEffort ? { defaultEffort } : {}) } : !item.reasoning ? { mode: 'none' as const, efforts: [] } : undefined;
  if (!thinking) throw new Error('Kimi 返回了未识别的 thinking 能力，请更新适配器。');
  const known = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  const reasoning = mode === 'none' || !item.reasoning ? [] : efforts.length ? efforts.filter(e => known.has(e)) : ['medium'];
  if (defaultEffort && reasoning.includes(defaultEffort)) { reasoning.splice(reasoning.indexOf(defaultEffort), 1); reasoning.unshift(defaultEffort); }
  if (mode === 'both') reasoning.push('none');
  return ModelSchema.parse({ id: item.id, name: item.display_name || item.id, upstreamId: item.id, protocols: [item.protocol === 'response' ? 'responses' : item.protocol === 'anthropic' ? 'messages' : 'chat'], contextWindow: context, tools: item.supports_tool_use !== false, images: item.modalities?.input?.includes('image') === true, reasoning, thinking });
}

export function kimiSubscriptionThinking(payload: any, protocol: 'responses' | 'messages' | 'chat', model: Model, selection: { effort?: string; thinking?: any }) {
  const metadata = model.thinking;
  // Old manually configured entries keep the legacy adapter until their next model sync.
  if (!metadata) return;
  const off = selection.effort === 'none' || selection.thinking?.type === 'disabled';
  if (off && metadata.mode === 'only') throw new BridgeError(400, 'thinking_always_on', 'This Kimi model cannot disable thinking.');
  if (metadata.mode === 'none') {
    if (selection.effort && !off || selection.thinking?.type && !off) throw new BridgeError(400, 'thinking_unsupported', 'This Kimi model does not support thinking.');
    delete payload.thinking; delete payload.reasoning_effort;
    if (protocol === 'responses') delete payload.reasoning;
    if (payload.output_config) { delete payload.output_config.effort; if (!Object.keys(payload.output_config).length) delete payload.output_config; }
    return;
  }
  let effort = selection.effort ?? selection.thinking?.effort ?? metadata.defaultEffort;
  if (effort && !off && metadata.efforts.length && !metadata.efforts.includes(effort)) throw new BridgeError(400, 'unsupported_thinking_effort', 'Choose a thinking effort declared by the Kimi model catalog.');
  if (!metadata.efforts.length || off) effort = undefined;
  if (protocol === 'responses') {
    delete payload.thinking; delete payload.reasoning_effort;
    payload.reasoning = { ...payload.reasoning, ...(off ? { effort: 'none' } : effort ? { effort } : {}) };
  } else if (protocol === 'messages') {
    payload.thinking = { type: off ? 'disabled' : 'adaptive' };
    const output = { ...payload.output_config }; delete output.effort;
    if (effort) output.effort = effort;
    if (Object.keys(output).length) payload.output_config = output; else delete payload.output_config;
  } else {
    payload.thinking = off ? { type: 'disabled' } : { type: 'enabled', keep: 'all', ...(effort ? { effort } : {}) };
    delete payload.reasoning_effort;
  }
}
