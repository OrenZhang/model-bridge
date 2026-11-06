import { expect, it } from 'vitest';
import { updateProxyRules } from '../src/desktop/update-network.js';
it('detects supported system and PAC proxy routes without exposing credentials', () => {
  expect(updateProxyRules('PROXY 127.0.0.1:7890; DIRECT')).toBe('http://127.0.0.1:7890');
  expect(updateProxyRules('SOCKS5 localhost:1080')).toBe('socks5://localhost:1080');
  expect(updateProxyRules('DIRECT')).toBeUndefined();
  expect(updateProxyRules('PROXY user:password@example.com:7890')).toBeUndefined();
});
