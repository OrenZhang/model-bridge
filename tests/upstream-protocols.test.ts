import { expect, it } from 'vitest';
import { defaultUpstreamProtocols, upstreamProtocols } from '../src/shared/upstream-protocols.js';
it('adapts upstream protocols independently of the three public gateway protocols',()=>{
 const source={provider:'deepseek',auth:'api-key',baseUrl:'https://api.deepseek.com'};
 expect(defaultUpstreamProtocols(source)).toEqual(['chat']);
 expect(upstreamProtocols({...source,upstreamProtocols:['responses','messages']})).toEqual(['responses','messages']);
 expect(upstreamProtocols({...source,auth:'chatgpt-device',upstreamProtocols:['chat']})).toEqual(['responses']);
 expect(upstreamProtocols({...source,provider:'kimi',auth:'subscription'},['messages'])).toEqual(['messages']);
 expect(defaultUpstreamProtocols({...source,provider:'custom',baseUrl:'https://service.invalid/anthropic/v1'})).toEqual(['messages']);
});
