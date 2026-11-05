import { BridgeError } from '../core/config.js';

/** ChatGPT plan HTTP accepts a narrower Responses schema than API-key traffic. */
export function chatgptPayload(input: any) {
  if (input.previous_response_id || input.conversation) throw new BridgeError(400, 'chatgpt_history_required', 'ChatGPT HTTP requests require the full conversation in input; previous_response_id and conversation are unavailable.');
  if (input.background) throw new BridgeError(400, 'chatgpt_background_unsupported', 'ChatGPT plan requests do not support background execution.');
  const payload = { ...input, stream: true, store: false, instructions: input.instructions ?? '' };
  for (const key of ['background', 'conversation', 'previous_response_id', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user']) delete payload[key];
  payload.input = typeof input.input === 'string' ? [{ role: 'user', content: [{ type: 'input_text', text: input.input }] }] : input.input?.map((item: any) => item.role === 'system' ? {...item,role:'developer'} : item);
  return payload;
}
