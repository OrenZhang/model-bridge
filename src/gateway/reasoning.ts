import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { BridgeError, type Protocol } from '../core/config.js';

export interface ReasoningRecord { protocol: Protocol; value: any; }
export interface ReasoningContext {
  upstream: Protocol; provider?: string; model?: string;
  seal(record: ReasoningRecord): string;
  open(token: string): ReasoningRecord;
}
export const reasoningPrefix = 'mb_r1.';
const maximumBytes = 2 * 1024 * 1024;
export const isGatewayReasoning = (value: unknown): value is string => typeof value === 'string' && value.startsWith(reasoningPrefix);
export function hasGatewayReasoning(body: any): boolean {
  return (Array.isArray(body?.input) && body.input.some((item: any) => isGatewayReasoning(item?.encrypted_content))) ||
    (Array.isArray(body?.messages) && body.messages.some((message: any) =>
      message?.reasoning_details?.some?.((item: any) => item?.type === 'model_bridge.reasoning' && isGatewayReasoning(item.data)) ||
      Array.isArray(message?.content) && message.content.some((block: any) => isGatewayReasoning(block?.signature) || isGatewayReasoning(block?.data))));
}
export class ReasoningVault {
  private readonly key: Buffer;
  constructor(key: Uint8Array = randomBytes(32)) {
    if (key.byteLength !== 32) throw new Error('The reasoning key must be 32 bytes.');
    this.key = Buffer.from(key);
  }
  context(scope: string, upstream: Protocol, provider?: string, model?: string): ReasoningContext {
    const aad = Buffer.from(JSON.stringify(['model-bridge/reasoning/v1', scope, upstream, provider ?? '', model ?? '']));
    return { upstream, provider, model,
      seal: record => {
        const plaintext = Buffer.from(JSON.stringify(record));
        if (plaintext.byteLength > maximumBytes) throw new BridgeError(502, 'reasoning_too_large', 'Reasoning history exceeds the size limit.');
        const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return reasoningPrefix + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
      },
      open: token => {
        try {
          if (!isGatewayReasoning(token) || token.length > Math.ceil(maximumBytes * 4 / 3) + 128 || !/^[A-Za-z0-9_-]+$/.test(token.slice(reasoningPrefix.length))) throw new Error();
          const bytes = Buffer.from(token.slice(reasoningPrefix.length), 'base64url'); if (bytes.length < 29) throw new Error();
          const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12)); decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(12, 28));
          const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
          if (!['responses', 'messages', 'chat'].includes(value?.protocol) || value.protocol !== upstream || !value.value || typeof value.value !== 'object') throw new Error();
          return value;
        } catch { throw new BridgeError(400, 'invalid_reasoning_state', 'Reasoning history is invalid or belongs to a different client or model route. Start a new conversation.'); }
      },
    };
  }
}
export function reasoningText(record: ReasoningRecord): string {
  if (record.protocol === 'chat') return typeof record.value.reasoning_content === 'string' ? record.value.reasoning_content : '';
  if (record.protocol === 'messages') return record.value.type === 'thinking' ? record.value.thinking ?? '' : '';
  return (record.value.summary ?? []).filter((part: any) => part.type === 'summary_text').map((part: any) => part.text ?? '').join('\n');
}
