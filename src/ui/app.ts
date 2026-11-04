declare global { interface Window { modelBridge: { call: (operation: string, payload?: unknown) => Promise<any> } } }
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const number = (n: number) => new Intl.NumberFormat('zh-CN', { notation: n >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const providerNames: Record<string, string> = { openai: 'ChatGPT / OpenAI', kimi: 'Kimi', minimax: 'MiniMax', anthropic: 'Anthropic', custom: '自定义服务' };
const titles: Record<string, string> = { overview: '总览', connections: '账号与连接', models: '模型目录', clients: '接入客户端', usage: '用量统计' };
let state: any; let page = 'overview'; let days = 7; let editing: any; let activeLogin: string | undefined; let previewId: string | undefined; let toastTimer: ReturnType<typeof setTimeout>; let refreshing = false;
const usageFilters: Record<string, string> = {};
let editingModel: { connectionId: string; modelId: string } | undefined;
async function call(operation: string, payload?: unknown) { return window.modelBridge.call(operation, payload); }
function toast(message: string, error = false) { const element = $('#toast'); element.textContent = message.replace(/^Error invoking remote method '[^']+': Error: /, ''); element.classList.toggle('error', error); element.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => element.hidden = true, error ? 9000 : 4500); }
async function action(operation: string, payload?: unknown, message?: string) { try { const result = await call(operation, payload); if (message) toast(message); await refresh(); return result; } catch (e: any) { toast(e.message ?? String(e), true); throw e; } }
const activeModels = () => state.config.connections.filter((c: any) => c.enabled).flatMap((connection: any) => connection.models.filter((m: any) => m.enabled).map((model: any) => ({ connection, model })));
const proxyName = (choice: any) => choice.mode === 'inherit' ? '默认网络' : choice.mode === 'direct' ? '直连' : choice.mode === 'system' ? '系统网络' : state.config.proxies.find((p: any) => p.id === choice.profileId)?.name ?? '代理已移除';
const proxyOptions = (inherit = true) => `${inherit ? '<option value="inherit">默认网络</option>' : ''}<option value="direct">不使用代理</option><option value="system">跟随系统网络</option>${state.config.proxies.map((p: any) => `<option value="${escape(p.id)}">独立代理 · ${escape(p.name)}</option>`).join('')}`;
const choiceValue = (choice: any) => choice.mode === 'proxy' ? choice.profileId : choice.mode;
const proxyChoice = (value: string) => ['inherit', 'direct', 'system'].includes(value) ? { mode: value } : { mode: 'proxy', profileId: value };
function stats() {
  const s = page === 'usage' ? state.filteredSummary : state.summary;
  return `<div class="stats"><div class="stat"><div class="label">请求次数</div><div class="number">${number(s.requests)}</div><div class="sub">近 ${days} 天 · 经过本网关</div></div><div class="stat"><div class="label">输入 / 输出 Token</div><div class="number">${number(s.inputTokens)} <span style="font-size:17px;color:#9aa796">/</span> ${number(s.outputTokens)}</div><div class="sub">${s.unknownUsage ? `${s.unknownUsage} 次用量未知` : '以厂商返回用量为准'}</div></div><div class="stat"><div class="label">成功率</div><div class="number">${s.requests ? Math.round(s.successful / s.requests * 100) + '%' : '—'}</div><div class="sub">${s.requests ? `${s.successful} 次请求成功` : '暂无请求记录'}</div></div><div class="stat"><div class="label">估算费用</div><div class="number">${s.requests && s.unpricedRequests < s.requests ? '$' + s.estimatedCostUsd.toFixed(4) : '—'}</div><div class="sub">${s.unpricedRequests ? `${s.unpricedRequests} 次请求未计价` : '配置价格后显示估算'}</div></div></div>`;
}
function connections() {
  if (!state.config.connections.length) return `<div class="panel empty"><div class="empty-symbol">⇄</div><h3>把你的模型连接到这里</h3><p>使用 ChatGPT 设备码登录，或添加 Kimi、MiniMax 和其他服务的 API Key。</p><button class="primary" data-action="add-connection">＋ 添加第一个连接</button></div>`;
  return `<div class="connection-grid">${state.config.connections.map((c: any) => `<div class="connection-card"><div class="connection-top"><div class="provider-icon ${escape(c.provider)}">${escape(c.name[0].toUpperCase())}</div><div><h3>${escape(c.name)}</h3><small>${escape(providerNames[c.provider])} · ${c.auth === 'chatgpt-device' ? '设备码登录' : c.auth === 'api-key' ? 'API Key' : '本地服务'}</small></div></div><div class="meta"><span>${c.models.length} 个模型</span><span>${escape(proxyName(c.proxy))}</span></div><div class="meta"><span>${c.enabled ? '连接已启用' : '连接已停用'}</span><span>${c.auth === 'chatgpt-device' ? escape(state.logins[c.id]?.account ?? '授权状态待检测') : '权限以实际调用为准'}</span></div><div class="connection-actions">${c.auth === 'chatgpt-device' ? `<button class="plain" data-action="login" data-id="${escape(c.id)}">设备码登录</button>` : ''}<button class="plain" data-action="discover" data-id="${escape(c.id)}">同步模型</button><button class="plain" data-action="edit" data-id="${escape(c.id)}">设置</button><button class="plain danger" data-action="delete" data-id="${escape(c.id)}">移除</button></div></div>`).join('')}</div>`;
}
function modelsTable() {
  const entries = page === 'models' ? state.config.connections.flatMap((connection: any) => connection.models.map((model: any) => ({ connection, model }))) : activeModels();
  if (!entries.length) return '<div class="panel empty"><div class="empty-symbol">◇</div><h3>模型目录还是空的</h3><p>添加连接后同步模型，或手动填写模型 ID。</p></div>';
  return `<div class="panel table-wrap"><table><thead><tr><th>模型</th><th>连接</th><th>上下文配置</th><th>能力</th><th></th></tr></thead><tbody>${entries.map(({ connection: c, model: m }: any) => `<tr><td><strong>${escape(m.name)}</strong><small>${escape(c.id + '/' + m.id)}</small></td><td>${escape(c.name)}</td><td>${number(m.contextWindow)}</td><td>${!m.enabled ? '<span class="tag">已停用</span> ' : ''}${m.tools ? '<span class="tag">工具调用</span> ' : ''}${m.images ? '<span class="tag">图片</span> ' : ''}${m.reasoning.length ? '<span class="tag">推理</span>' : ''}</td><td><button class="plain" data-action="model-edit" data-id="${escape(c.id)}" data-model="${escape(m.id)}">设置</button></td></tr>`).join('')}</tbody></table></div>`;
}
function render() {
  $('#page-title').textContent = titles[page]!;
  $('#service-status').innerHTML = '<i></i> 本地网关运行中';
  let html = '';
  if (page === 'overview') html = `<p class="intro">所有模型，一个入口。在熟悉的客户端里自由选择。</p><div class="endpoint-card"><div><div class="eyebrow">统一服务地址</div><div class="endpoint">${escape(state.address)}</div><div class="badges"><span class="badge">Responses</span><span class="badge">Messages</span><span class="badge">Chat Completions</span></div></div><div class="bridge-art" aria-hidden="true"></div></div>${stats()}<div class="section-heading"><div><h3>我的连接 <span class="tag">${state.config.connections.length}</span></h3><p>账号与代理分别管理，模型自动汇总</p></div><button class="primary" data-action="add-connection">＋ 添加连接</button></div>${connections()}<div class="section-heading"><h3>可用模型 <span class="tag">${activeModels().length}</span></h3><button class="plain" data-go="models">查看模型目录 →</button></div>${modelsTable()}`;
  if (page === 'connections') html = `<div class="row intro"><p>管理账号、API Key 和每个连接的网络设置。</p><button class="primary" data-action="add-connection">＋ 添加连接</button></div>${connections()}`;
  if (page === 'models') html = `<p class="intro">这些模型通过同一个网关提供服务。客户端根据各自能力加载模型目录。</p>${modelsTable()}<p class="hint">模型列表不等于调用权限。首次接入请验证实际调用；自定义模型的上下文和能力需要与服务商说明核对。</p>`;
  if (page === 'clients') html = `<p class="intro">连接一次，直接在客户端选择模型。应用配置前会展示预览并备份原文件。</p><div class="panel">${[['codex', 'Codex', '桌面端与 CLI 共用模型配置。加载聚合目录，使用 Responses 接口。', '⌘'], ['claude', 'Claude Code', '使用 Messages 接口接入。模型请求由网关自动转换和分发。', '✳']].map(([id, name, description, icon]) => `<div class="client-card"><div class="provider-icon">${icon}</div><div><h3>${name}</h3><p>${description}</p></div><div class="client-actions"><button class="secondary" data-action="restore" data-id="${id}">恢复配置</button><button class="primary" data-action="preview" data-id="${id}">预览接入</button></div></div>`).join('')}<div class="client-card"><div class="provider-icon">＋</div><div><h3>其他 Agent</h3><p>Base URL：${escape(state.address)}/v1<br>使用独立访问密钥统计此类客户端的调用。</p></div><button class="secondary" data-action="copy-key">复制访问密钥</button></div></div><p class="hint">Codex 本地目录在配置变化后自动更新，客户端是否需要重启取决于其版本。不会替换已有 ChatGPT 登录文件。</p>`;
  if (page === 'usage') {
    const daily: { date: string; count: number }[] = state.daily;
    const max = Math.max(1, ...daily.map(x => x.count));
    html = `<div class="row intro"><p>调用元数据保存在本机，不记录提示词和回复正文。</p><div><select id="days" class="compact"><option value="1">最近 1 天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select></div></div>${stats()}${state.usageWriteFailed ? '<div class="notice">部分统计写入失败，请检查本地磁盘空间和目录权限。</div>' : ''}<div class="panel"><div class="chart">${daily.map(x => `<div class="bar-group"><small>${x.count || ''}</small><div class="bar" style="height:${Math.max(2, x.count / max * 80)}px"></div><small>${x.date.slice(5)}</small></div>`).join('')}</div></div><div class="section-heading"><h3>请求明细</h3><button class="secondary" data-action="export">导出 CSV</button></div><div class="panel table-wrap">${state.records.length ? `<table><thead><tr><th>时间</th><th>客户端 / 模型</th><th>输入 / 输出</th><th>耗时</th><th>结果</th></tr></thead><tbody>${state.records.map((r: any) => `<tr><td>${escape(new Date(r.startedAt).toLocaleString())}</td><td><strong>${escape(r.clientId)}</strong><small>${escape(r.model)}</small></td><td>${r.tokens.input ?? '未知'} / ${r.tokens.output ?? '未知'}</td><td>${r.durationMs} ms</td><td><span class="tag ${r.status === 'success' ? '' : 'error'}">${r.status === 'success' ? '成功' : r.status === 'cancelled' ? '已取消' : '失败'}</span></td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无调用记录。接入客户端并发送请求后，这里会自动更新。</div>'}</div><p class="hint">明细显示最近 200 条；导出包含最近 90 天。套餐总额度查询尚未接入，当前仅统计经过本地网关的请求。</p>`;
  }
  $('#content').innerHTML = html;
  if (page === 'usage') {
    const filters = document.createElement('div'); filters.className = 'usage-filters';
    filters.innerHTML = Object.entries({ clientId: '客户端', provider: '服务商', connectionId: '账号', model: '模型' }).map(([key, name]) => `<label>${name}<select data-filter="${key}"><option value="">全部</option>${state.usageOptions[key].map((v: string) => `<option value="${escape(v)}">${escape(key === 'provider' ? providerNames[v] ?? v : key === 'connectionId' ? state.config.connections.find((c: any) => c.id === v)?.name ?? v : v)}</option>`).join('')}</select></label>`).join('');
    $('#content .intro').after(filters);
    filters.querySelectorAll<HTMLSelectElement>('select').forEach(select => { select.value = usageFilters[select.dataset.filter!] ?? ''; select.onchange = () => { usageFilters[select.dataset.filter!] = select.value; void refresh(); }; });
  }
  if (page === 'usage') { const select = $<HTMLSelectElement>('#days'); select.value = String(days); select.onchange = () => { days = Number(select.value); void refresh(); }; }
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try { state = await call('state', { days, filters: usageFilters }); render(); updateLogin(); }
  catch (e: any) { $('#service-status').textContent = '网关连接异常'; toast(e.message, true); }
  finally { refreshing = false; }
}
function updateLogin() {
  if (!activeLogin || !$<HTMLDialogElement>('#login-dialog').open) return;
  const login = state.logins[activeLogin] ?? { phase: 'starting' };
  $('#login-content').innerHTML = login.phase === 'waiting' ? `<p class="hint">打开授权页面，登录 ChatGPT 并输入以下设备码。</p><div class="device-code">${escape(login.userCode)}</div><p class="hint">${escape(login.verificationUrl)}<br>如果设备码登录未启用，请在 ChatGPT 安全设置或工作区权限中开启。</p>` : login.phase === 'authenticated' ? `<div class="empty"><h3>账号已连接</h3><p>${escape(login.account)}</p><p>关闭窗口后点击“同步模型”加载目录。</p></div>` : `<div class="empty">${escape(login.error ?? (login.phase === 'cancelled' ? '登录已取消' : '正在启动设备码登录…'))}</div>`;
  $<HTMLButtonElement>('#open-login').disabled = login.phase !== 'waiting';
}
function openConnection(id?: string) {
  editing = id ? state.config.connections.find((c: any) => c.id === id) : undefined;
  const form = $<HTMLFormElement>('#connection-form'); form.reset();
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  field('proxy').innerHTML = proxyOptions();
  if (editing) { for (const name of ['name', 'provider', 'auth', 'baseUrl']) field(name).value = editing[name]; field('proxy').value = choiceValue(editing.proxy); field('modelIds').value = editing.models.map((m: any) => m.upstreamId).join('\n'); field('protocol').value = editing.models[0]?.protocols.length === 3 ? 'all' : editing.models[0]?.protocols[0] ?? 'chat'; }
  else providerChanged();
  $('#api-fields').hidden = field('auth').value === 'chatgpt-device';
  $<HTMLDialogElement>('#connection-dialog').showModal();
}
function providerChanged() {
  const form = $<HTMLFormElement>('#connection-form'); const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const provider = field('provider').value;
  const defaults: Record<string, [string, string]> = { openai: ['https://api.openai.com/v1', 'responses'], kimi: ['https://api.kimi.com/coding/v1', 'all'], minimax: ['https://api.minimax.io/anthropic/v1', 'messages'], anthropic: ['https://api.anthropic.com/v1', 'messages'], custom: ['', 'chat'] };
  field('baseUrl').value = defaults[provider]![0]; field('protocol').value = defaults[provider]![1];
  field('auth').value = provider === 'openai' ? 'chatgpt-device' : 'api-key';
  const option = $<HTMLOptionElement>('select[name="auth"] option[value="chatgpt-device"]'); option.disabled = provider !== 'openai';
  $('#api-fields').hidden = field('auth').value === 'chatgpt-device';
}
document.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!target) return;
  if (target.dataset.close) { $<HTMLDialogElement>('#' + target.dataset.close).close(); return; }
  const next = target.dataset.page ?? target.dataset.go;
  if (next) { page = next; document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.page === page)); render(); return; }
  const operation = target.dataset.action; const id = target.dataset.id;
  void (async () => {
    target.setAttribute('disabled', '');
    try {
      if (operation === 'add-connection') openConnection();
      if (operation === 'edit') openConnection(id);
      if (operation === 'model-edit') {
        editingModel = { connectionId: id!, modelId: target.dataset.model! };
        const model = state.config.connections.find((c: any) => c.id === id).models.find((m: any) => m.id === editingModel!.modelId);
        const form = $<HTMLFormElement>('#model-form'); form.reset();
        const values = { name: model.name, contextWindow: model.contextWindow, enabled: model.enabled, tools: model.tools, images: model.images, reasoning: model.reasoning.join(','), priceInput: model.price?.input ?? '', priceOutput: model.price?.output ?? '', priceCached: model.price?.cachedInput ?? '' };
        for (const [key, value] of Object.entries(values)) (form.elements.namedItem(key) as HTMLInputElement).value = String(value);
        $<HTMLDialogElement>('#model-dialog').showModal();
      }
      if (operation === 'add-proxy') $<HTMLDialogElement>('#proxy-dialog').showModal();
      if (operation === 'discover') await action('connection.discover', { id }, '模型目录已同步');
      if (operation === 'login') { activeLogin = id; $<HTMLDialogElement>('#login-dialog').showModal(); updateLogin(); await action('device.login', { id }); }
      if (operation === 'delete' && confirm('移除此连接及其模型？已有客户端请求可能受到影响。')) await action('connection.delete', { id }, '连接已移除');
      if (operation === 'preview') { const result = await action('client.preview', { client: id }); previewId = result.id; $('#preview-path').textContent = result.path; $('#preview-code').textContent = result.preview; $<HTMLDialogElement>('#preview-dialog').showModal(); }
      if (operation === 'restore' && confirm('恢复上次接入前的客户端配置？')) await action('client.restore', { client: id }, '原配置已恢复');
      if (operation === 'copy-key') await action('client.copy-key', {}, '访问密钥已复制');
      if (operation === 'export') await action('usage.export', {}, '导出操作已完成');
    } catch { /* action displays a safe error message */ } finally { target.removeAttribute('disabled'); }
  })();
});
$<HTMLSelectElement>('select[name="provider"]').onchange = providerChanged;
$<HTMLSelectElement>('select[name="auth"]').onchange = event => $('#api-fields').hidden = (event.target as HTMLSelectElement).value === 'chatgpt-device';
$<HTMLFormElement>('#connection-form').onsubmit = event => {
  event.preventDefault();
  void (async () => {
    const form = new FormData(event.target as HTMLFormElement); const field = (name: string) => String(form.get(name) ?? '').trim();
    const id = editing?.id ?? `account-${crypto.randomUUID().slice(0, 8)}`; const auth = field('auth'); const protocol = field('protocol');
    const existing = new Map((editing?.models ?? []).map((m: any) => [m.upstreamId, m]));
    const models = [...new Set(field('modelIds').split('\n').map(x => x.trim()).filter(Boolean))].map(model => ({ ...(existing.get(model) as object ?? { id: model, name: model, upstreamId: model }), protocols: auth === 'chatgpt-device' ? ['responses'] : protocol === 'all' ? ['responses', 'messages', 'chat'] : [protocol] }));
    try { await action('connection.save', { connection: { ...editing, id, name: field('name'), provider: field('provider'), auth, baseUrl: auth === 'chatgpt-device' ? 'https://chatgpt.com/backend-api/codex' : field('baseUrl'), proxy: proxyChoice(field('proxy')), models }, apiKey: field('apiKey') }, '连接已保存'); $<HTMLDialogElement>('#connection-dialog').close(); } catch { /* shown */ }
  })();
};
$<HTMLFormElement>('#proxy-form').onsubmit = event => {
  event.preventDefault(); const form = new FormData(event.target as HTMLFormElement); const field = (key: string) => String(form.get(key) ?? '').trim();
  const id = `proxy-${crypto.randomUUID().slice(0, 8)}`;
  void action('proxy.save', { profile: { id, name: field('name'), url: field('url') }, ...(field('username') ? { credentials: { username: field('username'), password: String(form.get('password') ?? '') } } : {}) }, '代理已保存').then(() => { $<HTMLDialogElement>('#proxy-dialog').close(); $<HTMLFormElement>('#proxy-form').reset(); const select = $<HTMLSelectElement>('select[name="proxy"]'); select.innerHTML = proxyOptions(); select.value = id; }).catch(() => {});
};
$('#open-login').onclick = () => void action('device.open', { id: activeLogin }).catch(() => {});
$<HTMLFormElement>('#model-form').onsubmit = event => {
  event.preventDefault(); if (!editingModel) return;
  const fields = new FormData(event.target as HTMLFormElement); const value = (key: string) => String(fields.get(key) ?? '').trim();
  const connection = structuredClone(state.config.connections.find((c: any) => c.id === editingModel!.connectionId));
  const model = connection.models.find((m: any) => m.id === editingModel!.modelId);
  if ((value('priceInput') === '') !== (value('priceOutput') === '')) { toast('请同时填写输入和输出价格，或全部留空。', true); return; }
  Object.assign(model, { name: value('name'), contextWindow: Number(value('contextWindow')), enabled: value('enabled') === 'true', tools: value('tools') === 'true', images: value('images') === 'true', reasoning: value('reasoning').split(',').map(s => s.trim()).filter(Boolean), price: value('priceInput') === '' ? undefined : { input: Number(value('priceInput')), output: Number(value('priceOutput')), ...(value('priceCached') !== '' ? { cachedInput: Number(value('priceCached')) } : {}) } });
  void action('connection.save', { connection }, '模型设置已保存').then(() => $<HTMLDialogElement>('#model-dialog').close()).catch(() => {});
};
$('#cancel-login').onclick = () => void action('device.cancel', { id: activeLogin }).catch(() => {});
$('#apply-client').onclick = () => void action('client.apply', { id: previewId }, '配置已应用，请重新启动客户端').then(() => $<HTMLDialogElement>('#preview-dialog').close()).catch(() => {});
void refresh(); setInterval(() => { if (!document.querySelector('select:focus')) void refresh(); }, 4000);
export {};
