import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ProviderLogin, subscriptionEndpoints } from '../src/auth/provider-login.js';
import { ConnectionSchema } from '../src/core/config.js';
import type { Network } from '../src/core/network.js';
const logins: ProviderLogin[] = [];
afterEach(() => { logins.splice(0).forEach(login => login.close()); vi.useRealTimers(); });
const jwt = (value: unknown) => `fixture.${Buffer.from(JSON.stringify(value)).toString('base64url')}.fixture`;
function setup(provider: 'kimi' | 'minimax', responder: (url: string, init: RequestInit) => Response | Promise<Response>, region: 'cn' | 'global' = 'cn', id = 'a', values = new Map<string, string>()) {
  const connection = ConnectionSchema.parse({ id, name: 'Fixture account', provider, auth: 'subscription', region, baseUrl: subscriptionEndpoints(provider, region).base });
  const request = vi.fn((_connection, url, init) => responder(url, init));
  const login = new ProviderLogin(connection, { request } as unknown as Network, { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } }, (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(undefined); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  }));
  logins.push(login); return { login, request, values, connection };
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
it('completes Kimi device login, honors pending polling and refreshes once for concurrent requests', async () => {
  vi.useFakeTimers();
  let polls = 0; let refreshes = 0;
  const { login, request, values } = setup('kimi', (url, init) => {
    const form = new URLSearchParams(String(init.body));
    expect(new Headers(init.headers).get('user-agent')).toBe('ModelBridge/0.1.0');
    if (url.endsWith('device_authorization')) return json({ device_code: 'private-device', user_code: 'USER', verification_uri_complete: 'https://auth.kimi.com/authorize', interval: 1, expires_in: 600 });
    if (url.endsWith('/me')) return json({ user_id: 'kimi-account', nickname: 'Fixture' });
    if (form.get('grant_type') === 'refresh_token') { refreshes++; expect(form.get('refresh_token')).toBe('private-refresh'); return json({ access_token: 'refreshed', refresh_token: 'rotated', expires_in: 3600 }); }
    expect(form.get('device_code')).toBe('private-device');
    if (++polls === 1) return json({ error: 'authorization_pending' }, 400);
    return json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 61 });
  });
  expect((await login.login()).phase).toBe('waiting');
  expect(JSON.stringify(login.state)).not.toContain('private-device');
  await vi.advanceTimersByTimeAsync(2100);
  expect(login.state).toMatchObject({ phase: 'authenticated', accountId: 'kimi-account', account: 'Fixture' });
  expect(request.mock.calls.map(c => c[1])).toContain('https://api.kimi.com/coding/v1/me');
  await vi.advanceTimersByTimeAsync(2000);
  expect(await Promise.all([login.credentials(), login.credentials()])).toEqual([{ token: 'refreshed' }, { token: 'refreshed' }]);
  expect(refreshes).toBe(1); expect(JSON.parse([...values.values()][0]!).refresh).toBe('rotated');
});
it.each([false, true])('handles MiniMax PKCE and regional token endpoint (account variant=%s)', async accountVariant => {
  vi.useFakeTimers(); let challenge = ''; let polls = 0;
  const access = jwt({ sub: 'minimax-account', scope: 'agent.default', aud: 'agent-backend' });
  const { login, request } = setup('minimax', (url, init) => {
    expect(url.startsWith('https://account.minimax.io/')).toBe(true);
    const form = new URLSearchParams(String(init.body));
    expect(form.get('client_id')).toBe('mcode-public');
    if (url.endsWith('/device/code')) {
      challenge = form.get('code_challenge')!; expect(form.get('code_challenge_method')).toBe('S256'); expect(form.get('audience')).toBe('agent-backend');
      return json(accountVariant ? { user_code: 'USER', expired_in: Date.now() + 600000, interval: 1000, verification_url: 'https://account.minimax.io/device' } : { user_code: 'USER', device_code: 'private-code', expires_in: 600, interval: 1, verification_uri: 'https://account.minimax.io/device' });
    }
    expect(form.has(accountVariant ? 'user_code' : 'device_code')).toBe(true);
    expect(form.has(accountVariant ? 'device_code' : 'user_code')).toBe(false);
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(challenge);
    if (++polls === 1) return json({ status: 'slow_down' });
    return json({ access_token: access, refresh_token: 'private-refresh', expires_in: 3600, token_type: 'Bearer' });
  }, 'global');
  await login.login(); await vi.advanceTimersByTimeAsync(7100);
  expect(login.state).toMatchObject({ phase: 'authenticated', accountId: 'minimax-account' });
  expect(await login.credentials()).toEqual({ token: access });
  expect(request).toHaveBeenCalledTimes(3);
});
it('cancels polling and isolates accounts and regions in the credential vault', async () => {
  vi.useFakeTimers(); const values = new Map<string, string>();
  const responder = () => json({ device_code: 'private', user_code: 'USER', verification_uri: 'https://account.minimax.cn/device', expires_in: 600, interval: 1 });
  const a = setup('minimax', responder, 'cn', 'a', values); const b = setup('minimax', responder, 'cn', 'b', values); const global = setup('minimax', responder, 'global', 'a', values);
  values.set('subscription:minimax:cn:a', JSON.stringify({ access: 'private-a', refresh: 'refresh-a', expires: Date.now() + 3600000 }));
  expect(await a.login.credentials()).toEqual({ token: 'private-a' });
  await expect(b.login.credentials()).rejects.toThrow('请先登录'); await expect(global.login.credentials()).rejects.toThrow('请先登录');
  await b.login.login(); await b.login.cancel(); await vi.advanceTimersByTimeAsync(20000); expect(b.request).toHaveBeenCalledTimes(1); expect(b.login.state.phase).toBe('cancelled');
  await a.login.logout(); await expect(a.login.credentials()).rejects.toThrow('请先登录');
});
it('rejects an unrelated authorization page and wrong token audience without saving credentials', async () => {
  vi.useFakeTimers();
  const badUrl = setup('kimi', () => json({ device_code: 'private', user_code: 'USER', verification_uri_complete: 'https://evil.invalid/authorize' }));
  expect((await badUrl.login.login()).phase).toBe('error'); expect(badUrl.values.size).toBe(0);
  const wrongAudience = setup('minimax', url => url.endsWith('/device/code') ? json({ device_code: 'private', user_code: 'USER', verification_uri: 'https://account.minimax.cn/device', expires_in: 600, interval: 1 }) : json({ access_token: jwt({ aud: 'open-platform', scope: 'agent.default' }), refresh_token: 'private', token_type: 'Bearer', expires_in: 3600 }));
  await wrongAudience.login.login(); await vi.advanceTimersByTimeAsync(1100); expect(wrongAudience.login.state.phase).toBe('error'); expect(wrongAudience.values.size).toBe(0);
  expect(() => ConnectionSchema.parse({ id: 'a', name: 'A', provider: 'minimax', auth: 'subscription', baseUrl: 'https://api.minimax.io/anthropic/v1' })).toThrow('official');
});

it('keeps the Kimi profile identity distinct from JWT subject during refresh and restore', async () => {
  vi.useFakeTimers();
  const access = jwt({sub:'jwt-subject',email:'fixture@example.invalid'});
  const {login,values,connection}=setup('kimi',()=>json({access_token:access,refresh_token:'rotated-refresh',expires_in:3600}));
  values.set('subscription:kimi:cn:a',JSON.stringify({access:jwt({sub:'jwt-subject'}),refresh:'original-refresh',expires:Date.now()-1,accountId:'profile-user-id',account:'Profile label'}));
  login.updateConnection({...connection,accountId:'profile-user-id'});
  expect(await login.credentials()).toEqual({token:access});
  const saved=JSON.parse(values.get('subscription:kimi:cn:a')!);expect(saved.accountId).toBe('profile-user-id');expect(saved.subject).toBe('jwt-subject');expect(saved.account).toBe('Profile label');
  const authorized=vi.fn();login.on('authorized',authorized);await login.restore();
  expect(login.state).toMatchObject({phase:'authenticated',accountId:'profile-user-id'});expect(authorized).not.toHaveBeenCalled();
});
it('does not save a rotated Kimi token with a changed principal or missing refresh token', async () => {
  vi.useFakeTimers();
  for(const result of [{access_token:jwt({sub:'different'}),refresh_token:'other-refresh',expires_in:3600},{access_token:jwt({sub:'same'}),expires_in:3600}]){
    const {login,values}=setup('kimi',()=>json(result));
    const original=JSON.stringify({access:jwt({sub:'same'}),refresh:'private-refresh',expires:Date.now()-1,accountId:'profile-user'});
    values.set('subscription:kimi:cn:a',original);await expect(login.credentials()).rejects.toThrow();expect(values.get('subscription:kimi:cn:a')).toBe(original);
  }
});
it('retries transient Kimi refresh failures once per shared refresh and never retries invalid_grant', async () => {
  vi.useFakeTimers();let attempts=0;
  const {login,values,request}=setup('kimi',()=>++attempts===1?json({},503):json({access_token:'refreshed',refresh_token:'rotated',expires_in:3600}));
  values.set('subscription:kimi:cn:a',JSON.stringify({access:'old',refresh:'private-refresh',expires:Date.now()-1}));
  const pending=Promise.all([login.credentials(),login.credentials()]);await vi.advanceTimersByTimeAsync(1100);
  expect(await pending).toEqual([{token:'refreshed'},{token:'refreshed'}]);expect(request).toHaveBeenCalledTimes(2);
  const rejected=setup('kimi',()=>json({error:'invalid_grant'},401));
  rejected.values.set('subscription:kimi:cn:a',JSON.stringify({access:'old',refresh:'private-refresh',expires:Date.now()-1}));
  await expect(rejected.login.credentials()).rejects.toThrow('刷新失败');expect(rejected.request).toHaveBeenCalledTimes(1);
});
it('cancels Kimi refresh retry backoff when the account session closes', async()=>{
  vi.useFakeTimers();const{login,values,request}=setup('kimi',()=>json({},503));values.set('subscription:kimi:cn:a',JSON.stringify({access:'old',refresh:'private-refresh',expires:Date.now()-1}));
  const result=login.credentials().catch(error=>error);await vi.advanceTimersByTimeAsync(1);login.close();await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toBeInstanceOf(Error);expect(request).toHaveBeenCalledTimes(1);
});
