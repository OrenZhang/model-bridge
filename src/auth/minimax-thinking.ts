import { BridgeError } from '../core/config.js';

// The managed MiniMax Code path has different thinking rules from Open Platform.
// See the pinned official payload transform in docs/provider-auth.md.
export function minimaxSubscriptionThinking(payload: any, model: string, selection: { effort?: string; thinking?: any }) {
  const disabled = selection.effort === 'none' || selection.thinking?.type === 'disabled';
  const forcedOn = model === 'MiniMax-M3.1-Flash';
  const switchable = model === 'MiniMax-M3';
  const legacy = /^MiniMax-M2\.7(?:-highspeed)?$/.test(model);
  if (!forcedOn && !switchable && !legacy) return;
  if (disabled && !switchable) throw new BridgeError(400, 'thinking_always_on', 'This MiniMax subscription model does not support disabling thinking.');
  if (forcedOn || legacy) delete payload.thinking;
  else if (switchable) payload.thinking = { type: disabled ? 'disabled' : 'adaptive' };
  // M2.7 retains the provider default; never invent an Anthropic thinking budget.
  const output = { ...payload.output_config }; delete output.effort;
  if (forcedOn && selection.effort && !disabled) {
    const effort = selection.effort === 'minimal' ? 'low' : selection.effort;
    if (!['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new BridgeError(400, 'unsupported_thinking_effort', 'This MiniMax subscription model does not support the selected thinking effort.');
    output.effort = effort;
  }
  if (Object.keys(output).length) payload.output_config = output;
  else delete payload.output_config;
}
