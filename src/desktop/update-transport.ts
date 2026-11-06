import { net, type AuthInfo, type Session } from 'electron';
import { updateProxyRoute, type UpdateProxy } from './update-network.js';

export class UpdateTransport {
  private route?: ReturnType<typeof updateProxyRoute>;
  constructor(readonly session: Session) {}
  async apply(proxy?: UpdateProxy) {
    this.route = proxy ? updateProxyRoute(proxy.url) : undefined;
    await this.session.closeAllConnections();
    await this.session.clearAuthCache();
    await this.session.setProxy(this.route ? { mode: 'fixed_servers', proxyRules: this.route.rules } : { mode: 'direct' });
  }
  login = (info: AuthInfo, callback: (username: string, password: string) => void) => {
    const route = this.route;
    if (info.isProxy && route?.username && info.host === route.host && info.port === route.port) callback(route.username, route.password);
    else callback('', '');
  };
  fetch = (url: string, init: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
    const request = net.request({ url, session: this.session, method: init.method ?? 'GET', redirect: 'follow' });
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cleanup = () => init.signal?.removeEventListener('abort', abort);
    const fail = (error: Error) => { cleanup(); const controller = stream; stream = undefined; controller?.error(error); reject(error); };
    const abort = () => { fail(init.signal?.reason ?? new Error('下载已取消')); request.abort(); };
    if (init.signal?.aborted) { abort(); return; }
    init.signal?.addEventListener('abort', abort, { once: true });
    for (const [name, value] of new Headers(init.headers)) request.setHeader(name, value);
    request.on('login', this.login);
    request.on('error', fail);
    request.on('close', () => { if (stream) fail(new Error('下载连接提前关闭')); });
    request.on('response', response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      if ([204, 205, 304].includes(response.statusCode)) { response.on('end', cleanup); resolve(new Response(null, { status: response.statusCode, headers })); return; }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          response.on('end', () => { cleanup(); if (stream) { stream = undefined; controller.close(); } });
          response.on('error', fail);
          response.on('aborted', () => { cleanup(); if (stream) { stream = undefined; controller.error(new Error('下载连接已中断')); } });
          response.on('data', chunk => { if (stream) controller.enqueue(new Uint8Array(chunk)); });
        },
        cancel() { cleanup(); stream = undefined; request.abort(); },
      });
      resolve(new Response(body, { status: response.statusCode, headers }));
    });
    request.end();
  });
}
