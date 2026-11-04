declare global { interface Window { modelBridge: { call: (operation: string, payload?: unknown) => Promise<any> } } }
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const number = (n: number) => new Intl.NumberFormat('zh-CN', { notation: n >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const providerNames: Record<string, string> = { openai: 'ChatGPT / OpenAI', kimi: 'Kimi', minimax: 'MiniMax', anthropic: 'Anthropic', custom: '自定义服务' };
const titles: Record<string, string> = { overview: '总览', connections: '账号与连接', models: '模型目录', clients: '客户端与服务', usage: '用量统计' };
let state: any; let page = 'overview'; let days = 7; let editing: any; let activeLogin: string | undefined; let previewId: string | undefined; let toastTimer: ReturnType<typeof setTimeout>; let refreshing = false;
const usageFilters: Record<string, string> = {};
let editingModel: { connectionId: string; modelId: string } | undefined;
let selectedAddress = ''; const clientModels: Record<string, string> = {};
const clientTabs = [
  { id: 'codex', name: 'Codex', provider: 'openai' },
  { id: 'claude', name: 'Claude Code', provider: 'anthropic' },
  { id: 'kimi', name: 'Kimi', provider: 'kimi' },
  { id: 'minimax', name: 'MiniMax', provider: 'minimax' },
  { id: 'generic', name: '其他 Agent', provider: 'custom' },
];
let clientTab = 'codex'; let clientPane = 'accounts'; let providerTarget = 'codex'; let genericProtocol = 'responses';
let generatedPlan: { key: string; status: 'loading' | 'ready' | 'error'; result?: any; error?: string } | undefined;
let clientBusy = false;
const selectedClientTab = () => clientTabs.find(tab => tab.id === clientTab)!;
const targetClient = () => ['kimi', 'minimax'].includes(clientTab) ? providerTarget : clientTab;
const configAddress = () => [state.address, ...(state.lanAddresses ?? [])].includes(selectedAddress) ? selectedAddress : state.address;
const configModelEntries = () => activeModels().filter(({ connection, model }: any) =>
  (!['kimi', 'minimax'].includes(clientTab) || connection.provider === selectedClientTab().provider) && (targetClient() === 'generic' || model.tools));
const modelSelectionKey = () => clientTab + ':' + targetClient();
function selectedConfigModel() {
  const entries = configModelEntries(); const key = modelSelectionKey();
  if (!entries.some(({ connection, model }: any) => connection.id + '/' + model.id === clientModels[key])) clientModels[key] = entries[0] ? entries[0].connection.id + '/' + entries[0].model.id : '';
  return clientModels[key] ?? '';
}
function planKey() { return JSON.stringify([targetClient(), selectedConfigModel(), state.address, state.config.connections]); }
async function prepareClientConfig(force = false) {
  if (targetClient() === 'generic' || !selectedConfigModel()) return;
  const key = planKey();
  if (!force && generatedPlan?.key === key) return generatedPlan.result;
  const request = { key, status: 'loading' as const }; generatedPlan = request;
  try {
    const result = await call('client.preview', { client: targetClient(), model: selectedConfigModel() });
    if (generatedPlan === request) generatedPlan = { key, status: 'ready', result };
    return result;
  } catch (error: any) {
    if (generatedPlan === request) generatedPlan = { key, status: 'error', error: error.message };
  } finally { if (page === 'clients' && clientPane === 'config') render(); }
}

async function call(operation: string, payload?: unknown) { return window.modelBridge.call(operation, payload); }
function toast(message: string, error = false) { const element = $('#toast'); element.textContent = message.replace(/^Error invoking remote method '[^']+': Error: /, ''); element.classList.toggle('error', error); element.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => element.hidden = true, error ? 9000 : 4500); }
async function action(operation: string, payload?: unknown, message?: string) { try { const result = await call(operation, payload); if (message) toast(message); await refresh(); return result; } catch (e: any) { toast(e.message ?? String(e), true); throw e; } }
const activeModels = () => state.config.connections.filter((c: any) => c.enabled).flatMap((connection: any) => connection.models.filter((m: any) => m.enabled).map((model: any) => ({ connection, model })));
const proxyName = (choice: any) => choice.mode === 'inherit' ? '默认网络' : choice.mode === 'direct' ? '直连' : choice.mode === 'system' ? '系统网络' : (choice.mode === 'managed' ? state.config.networkProfiles ?? [] : state.config.proxies).find((p: any) => p.id === choice.profileId)?.name ?? '网络配置已移除';
const proxyOptions = (inherit = true) => `${inherit ? '<option value="inherit">默认网络</option>' : ''}<option value="direct">不使用代理</option><option value="system">跟随系统网络</option>${(state.config.networkProfiles ?? []).map((p: any) => `<option value="managed:${escape(p.id)}">订阅 · ${escape(p.name)} / ${escape(p.selected)}</option>`).join('')}${state.config.proxies.map((p: any) => `<option value="${escape(p.id)}">独立代理 · ${escape(p.name)}</option>`).join('')}`;
const choiceValue = (choice: any) => choice.mode === 'managed' ? `managed:${choice.profileId}` : choice.mode === 'proxy' ? choice.profileId : choice.mode;
const proxyChoice = (value: string) => value.startsWith('managed:') ? { mode: 'managed', profileId: value.slice(8) } : ['inherit', 'direct', 'system'].includes(value) ? { mode: value } : { mode: 'proxy', profileId: value };
function stats() {
  const s = page === 'usage' ? state.filteredSummary : state.summary;
  return `<div class="stats"><div class="stat"><div class="label">请求次数</div><div class="number">${number(s.requests)}</div><div class="sub">近 ${days} 天 · 经过本网关</div></div><div class="stat"><div class="label">输入 / 输出 Token</div><div class="number">${number(s.inputTokens)} <span style="font-size:17px;color:#9aa796">/</span> ${number(s.outputTokens)}</div><div class="sub">${s.unknownUsage ? `${s.unknownUsage} 次用量未知` : '以厂商返回用量为准'}</div></div><div class="stat"><div class="label">成功率</div><div class="number">${s.requests ? Math.round(s.successful / s.requests * 100) + '%' : '—'}</div><div class="sub">${s.requests ? `${s.successful} 次请求成功` : '暂无请求记录'}</div></div><div class="stat"><div class="label">估算费用</div><div class="number">${s.requests && s.unpricedRequests < s.requests ? '$' + s.estimatedCostUsd.toFixed(4) : '—'}</div><div class="sub">${s.unpricedRequests ? `${s.unpricedRequests} 次请求未计价` : '配置价格后显示估算'}</div></div></div>`;
}
function endpointCards() {
  const addresses = [state.address, ...(state.lanAddresses ?? [])];
  if (!addresses.includes(selectedAddress)) selectedAddress = state.address;
  return `<div class="panel endpoint-panel"><div class="endpoint-toolbar"><strong>统一接口</strong><div class="endpoint-controls"><label class="toggle"><input id="lan-access" type="checkbox" ${state.config.listenHost === '0.0.0.0' ? 'checked' : ''} />局域网访问</label><select id="service-address" aria-label="服务地址">${addresses.map((address: string) => `<option value="${escape(address)}">${escape(address)}${address === state.address ? ' · 本机' : ' · 局域网'}</option>`).join('')}</select><button class="plain" data-action="copy-key">复制密钥</button></div></div><div class="table-wrap"><table class="endpoint-table"><thead><tr><th>接口</th><th>客户端 Base URL</th><th>请求路径</th></tr></thead><tbody>${[['responses', 'Responses', '/v1', '/v1/responses'], ['messages', 'Messages', '', '/v1/messages'], ['chat', 'Chat Completions', '/v1', '/v1/chat/completions']].map(([id, name, base, endpoint]) => `<tr><td><strong>${name}</strong></td><td><div class="address-cell"><code>${escape(selectedAddress + base)}</code><button class="copy-button" data-action="copy-address" data-id="${id}" data-kind="base" aria-label="复制 ${name} 基础地址" title="复制基础地址">复制</button></div></td><td><div class="address-cell"><code>${endpoint}</code><button class="copy-button" data-action="copy-address" data-id="${id}" data-kind="endpoint" aria-label="复制 ${name} 完整请求地址" title="复制完整请求地址">复制</button></div></td></tr>`).join('')}</tbody></table></div>${state.config.listenHost === '0.0.0.0' ? '<div class="endpoint-note">监听 0.0.0.0 · 其他设备使用网卡地址和访问密钥连接，系统防火墙需允许该端口。</div>' : ''}</div>`;
}
function localAccountPanel() {
  return `<div class="section-heading"><h3>本机 Codex 登录</h3><button class="secondary" data-action="detect-local">重新检测</button></div><div class="panel local-accounts">${(state.localAccounts ?? []).map((account: any) => `<div class="local-account"><div><strong>${escape(account.email ?? (account.kind === 'api-key' ? 'OpenAI API Key 登录' : '未检测到可复用账号'))}</strong>${account.plan ? `<span class="tag">${escape(account.plan)}</span>` : ''}<p>当前连接：${escape(account.provider === 'model_bridge' ? 'Model Bridge' : account.provider === 'openai' ? '官方 OpenAI / ChatGPT' : account.provider)}${account.model ? ' · ' + escape(account.model) : ''}</p><small>${escape(account.directory)}</small>${account.message ? `<p class="hint">${escape(account.message)}</p>` : ''}</div><button class="${account.imported ? 'secondary' : 'primary'}" data-action="import-local" data-id="${escape(account.id)}" ${!account.canImport || account.imported ? 'disabled' : ''}>${account.imported ? '已接入账号' : '复用此账号'}</button></div>`).join('') || '<div class="empty">正在检测本机 Codex 配置与登录状态…</div>'}</div><p class="hint">复用会保存独立登录副本，原 Codex 配置保持不变。若账号刷新后失效，可重新设备授权。接入后可按账号 / 模型切换，也可恢复接入前的客户端配置。</p>`;
}
function updateNetworks() {
  if (!$<HTMLDialogElement>('#network-dialog').open) return;
  const overview = state.managedNetworks ?? { core: {}, profiles: [] };
  $('#network-core-status').innerHTML = `<div class="notice">mihomo ${escape(overview.core.version ?? '')} · ${overview.core.downloading ? '下载中…' : overview.core.installed ? '已安装，使用时自动启动' : '首次使用时下载官方内核'}<div class="row"><button class="plain" data-action="install-core" ${overview.core.installed || overview.core.downloading ? 'disabled' : ''}>下载内核</button><button class="plain" data-action="install-core-offline">离线导入内核</button></div></div>`;
  $('#network-profiles').innerHTML = overview.profiles.map((profile: any) => `<div class="network-profile"><div class="row"><strong>${escape(profile.name)}</strong><span class="tag">${escape({ stopped: '按需启动', starting: '启动中', running: '运行中', error: '启动失败' }[profile.status as string] ?? profile.status)}</span></div><label>使用节点<select data-network-id="${escape(profile.id)}">${profile.nodes.map((node: string) => `<option value="${escape(node)}" ${node === profile.selected ? 'selected' : ''}>${escape(node)}</option>`).join('')}</select></label>${profile.error ? `<p class="hint">${escape(profile.error)}</p>` : ''}<div class="row">${profile.source === 'subscription' ? `<button class="plain" data-action="refresh-network" data-id="${escape(profile.id)}">更新订阅</button>` : '<span></span>'}<button class="plain danger" data-action="remove-network" data-id="${escape(profile.id)}">移除</button></div></div>`).join('');
  $('#network-profiles').querySelectorAll<HTMLSelectElement>('select').forEach(select => { select.onchange = () => void action('network.select', { id: select.dataset.networkId, node: select.value }, '节点已切换').catch(() => {}); });
}
function connections(provider?: string) {
  const entries = state.config.connections.filter((c: any) => !provider || c.provider === provider);
  if (!entries.length && provider) return `<div class="panel compact-empty"><h3>尚未添加 ${escape(providerNames[provider])} 连接</h3><p>添加账号或 API Key 后，自动获取可用模型。</p><button class="secondary" data-action="add-connection" data-provider="${escape(provider)}">＋ 添加连接</button></div>`;
  if (!entries.length) return `<div class="panel empty"><div class="empty-symbol">⇄</div><h3>把你的模型连接到这里</h3><p>使用 ChatGPT 设备码登录，或添加 Kimi、MiniMax 和其他服务的 API Key。</p><button class="primary" data-action="add-connection">＋ 添加第一个连接</button></div>`;
  return `<div class="connection-grid">${entries.map((c: any) => `<div class="connection-card" data-connection-id="${escape(c.id)}"><div class="connection-top"><div class="provider-icon ${escape(c.provider)}">${escape(c.name[0].toUpperCase())}</div><div><h3>${escape(c.name)}</h3><small>${escape(providerNames[c.provider])} · ${c.auth === 'chatgpt-device' ? '设备码登录' : c.auth === 'api-key' ? 'API Key' : '本地服务'}</small></div></div><div class="meta"><span>${c.models.length} 个模型</span><span>${escape(proxyName(c.proxy))}</span></div><div class="meta"><span>${c.enabled ? '连接已启用' : '连接已停用'}</span><span>${c.auth === 'chatgpt-device' ? escape(state.logins[c.id]?.account ?? '授权状态待检测') : '权限以实际调用为准'}</span></div><div class="connection-actions">${c.auth === 'chatgpt-device' ? `<button class="plain" data-action="login" data-id="${escape(c.id)}">设备码登录</button>` : ''}<button class="plain" data-action="discover" data-id="${escape(c.id)}">重新获取</button><button class="plain" data-action="edit" data-id="${escape(c.id)}">设置</button><button class="plain danger" data-action="delete" data-id="${escape(c.id)}">移除</button></div></div>`).join('')}</div>`;
}
function modelsTable(provider?: string) {
  const allEntries = page === 'models' ? state.config.connections.flatMap((connection: any) => connection.models.map((model: any) => ({ connection, model }))) : activeModels();
  const entries = allEntries.filter(({ connection }: any) => !provider || connection.provider === provider);
  if (!entries.length) return '<div class="panel empty"><div class="empty-symbol">◇</div><h3>模型目录还是空的</h3><p>配置或登录成功后自动获取，也可手动填写模型 ID。</p></div>';
  return `<div class="panel table-wrap"><table><thead><tr><th>模型</th><th>连接</th><th>上下文配置</th><th>能力</th><th></th></tr></thead><tbody>${entries.map(({ connection: c, model: m }: any) => `<tr><td><strong>${escape(m.name)}</strong><small>${escape(c.id + '/' + m.id)}</small></td><td>${escape(c.name)}</td><td>${number(m.contextWindow)}</td><td>${!m.enabled ? '<span class="tag">已停用</span> ' : ''}${m.tools ? '<span class="tag">工具调用</span> ' : ''}${m.images ? '<span class="tag">图片</span> ' : ''}${m.reasoning.length ? '<span class="tag">推理</span>' : ''}</td><td><button class="plain" data-action="model-edit" data-id="${escape(c.id)}" data-model="${escape(m.id)}">设置</button></td></tr>`).join('')}</tbody></table></div>`;
}
function clientConfiguration() {
  const client = targetClient(); const model = selectedConfigModel(); const entries = configModelEntries();
  const isProvider = ['kimi', 'minimax'].includes(clientTab);
  const selectTarget = isProvider ? `<label>接入客户端<select id="config-target">${[['codex', 'Codex'], ['claude', 'Claude Code'], ['generic', '其他 Agent']].map(([id, name]) => `<option value="${id}" ${client === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>` : '';
  const modelOptions = entries.map(({ connection, model: entry }: any) => `<option value="${escape(connection.id + '/' + entry.id)}" ${model === connection.id + '/' + entry.id ? 'selected' : ''}>${escape(connection.name + ' · ' + entry.name)}</option>`).join('');
  const options = `<div class="config-options">${selectTarget}<label class="model-choice">默认账号 / 模型<select id="config-model" ${!model ? 'disabled' : ''}>${modelOptions || '<option>请先添加支持工具调用的模型</option>'}</select></label>${client === 'generic' ? `<label>接口格式<select id="config-protocol">${[['responses', 'Responses'], ['messages', 'Messages'], ['chat', 'Chat Completions']].map(([id, name]) => `<option value="${id}" ${id === genericProtocol ? 'selected' : ''}>${name}</option>`).join('')}</select></label>` : ''}</div>`;
  const title = client === 'codex' ? 'Codex 配置' : client === 'claude' ? 'Claude Code 配置' : '通用 Agent 配置';
  const description = client === 'codex' ? '桌面端与 CLI 共用配置，模型目录包含所有已启用的连接。' : client === 'claude' ? '使用 Messages 接口，默认模型和子代理模型一并配置。' : '复制 JSON，按目标客户端的设置字段填写 Base URL、密钥和模型。';
  const heading = `<div class="config-heading"><div><h3>${title}</h3><p>${description}</p></div>${client !== 'generic' ? `<button class="plain" data-action="restore" data-id="${client}" ${clientBusy ? 'disabled' : ''}>恢复原配置</button>` : ''}</div>`;
  if (!model) return `<div class="panel configuration-panel">${heading}${options}<div class="config-empty">暂无可用模型。先在“账号与模型”中添加连接，配置成功后自动获取模型。</div></div>`;
  if (client === 'generic') {
    const preview = JSON.stringify({ base_url: configAddress() + (genericProtocol === 'messages' ? '' : '/v1'), api_key: '<local gateway key>', model, protocol: genericProtocol }, null, 2);
    return `<div class="panel configuration-panel">${heading}${options}<div class="config-code-label"><span>JSON · 密钥已隐藏</span></div><pre class="config-code">${escape(preview)}</pre><div class="config-footer"><span>复制或导出时包含本网关访问密钥</span><div><button class="secondary" data-action="export-generic">导出 JSON</button><button class="primary" data-action="copy-generic">复制 JSON</button></div></div></div>`;
  }
  const current = generatedPlan?.key === planKey() ? generatedPlan : undefined;
  const ready = current?.status === 'ready'; const busy = !ready || clientBusy;
  return `<div class="panel configuration-panel">${heading}${options}<div class="config-code-label"><span>${client === 'codex' ? 'config.toml' : 'settings.json'} · 密钥已隐藏</span><button class="plain" data-action="regenerate-config" ${clientBusy ? 'disabled' : ''}>重新生成</button></div>${ready ? `<pre class="config-code">${escape(current.result.preview)}</pre><div class="config-path">写入位置 <code>${escape(current.result.path)}</code></div>` : `<div class="config-empty ${current?.status === 'error' ? 'config-error' : ''}">${escape(current?.error ?? '正在生成配置…')}</div>`}<div class="config-footer"><span>自动备份原文件，可随时恢复</span><div><button class="secondary" data-action="export-config" ${busy ? 'disabled' : ''}>导出</button>${client === 'codex' ? `<button class="secondary" data-action="copy-config" data-format="json" title="通用 JSON 数据；Codex 原生配置使用 TOML" ${busy ? 'disabled' : ''}>复制 JSON</button>` : ''}<button class="secondary" data-action="copy-config" data-format="native" ${busy ? 'disabled' : ''}>复制 ${client === 'codex' ? 'TOML' : 'JSON'}</button><button class="primary" data-action="write-config" ${busy ? 'disabled' : ''}>${clientBusy ? '正在写入…' : '一键写入'}</button></div></div>${client === 'codex' ? '<div class="config-footnote">Codex 使用 TOML。JSON 用于配置数据交换，手动配置时请复制 TOML。</div>' : ''}</div>`;
}
function clientsPage() {
  const tab = selectedClientTab(); const count = state.config.connections.filter((c: any) => c.provider === tab.provider).length;
  const tabs = `<div class="client-tabs" role="tablist" aria-label="客户端与服务">${clientTabs.map(item => `<button id="tab-${item.id}" role="tab" aria-selected="${clientTab === item.id}" aria-controls="client-tab-panel" tabindex="${clientTab === item.id ? 0 : -1}" class="${clientTab === item.id ? 'active' : ''}" data-client-tab="${item.id}">${item.name}</button>`).join('')}</div>`;
  const panes = `<div class="client-subnav" role="tablist" aria-label="管理内容"><button role="tab" aria-selected="${clientPane === 'accounts'}" class="${clientPane === 'accounts' ? 'active' : ''}" data-client-pane="accounts">账号与模型${count ? `<span>${count}</span>` : ''}</button><button role="tab" aria-selected="${clientPane === 'config'}" class="${clientPane === 'config' ? 'active' : ''}" data-client-pane="config">接入配置</button></div>`;
  let content: string;
  if (clientPane === 'config') content = clientConfiguration();
  else {
    const explanation = clientTab === 'codex' ? '管理 ChatGPT / OpenAI 账号，可复用本机登录或使用设备码添加。' : clientTab === 'claude' ? '管理 Anthropic API 连接，也可在接入配置中选择其他服务商模型。' : clientTab === 'generic' ? '接入自定义 API 或本地模型服务，统一提供三种接口。' : `管理 ${tab.name} 账号和模型，在接入配置中选择要使用的客户端。`;
    content = `<div class="accounts-toolbar"><p>${explanation}</p><button class="primary" data-action="add-connection" data-provider="${tab.provider}">＋ 添加连接</button></div>${clientTab === 'codex' ? localAccountPanel() : ''}${count ? `<div class="section-heading"><h3>已管理的连接 <span class="tag">${count}</span></h3></div>` : ''}${connections(tab.provider)}${activeModels().some(({ connection }: any) => connection.provider === tab.provider) ? `<div class="section-heading"><h3>可用模型</h3></div>${modelsTable(tab.provider)}` : ''}`;
  }
  return `${tabs}${panes}<section id="client-tab-panel" role="tabpanel" aria-labelledby="tab-${tab.id}">${content}</section>`;
}
function render() {
  $('#page-title').textContent = titles[page]!;
  $('#service-status').innerHTML = '<i></i> 本地网关运行中';
  let html = '';
  if (page === 'overview') html = `<p class="intro">所有模型，一个入口。在熟悉的客户端里自由选择。</p>${endpointCards()}${stats()}<div class="section-heading"><div><h3>我的连接 <span class="tag">${state.config.connections.length}</span></h3><p>连接各自管理，模型自动汇总</p></div><button class="primary" data-action="add-connection">＋ 添加连接</button></div>${connections()}<div class="section-heading"><h3>可用模型 <span class="tag">${activeModels().length}</span></h3><button class="plain" data-go="models">查看模型目录 →</button></div>${modelsTable()}`;
  if (page === 'connections') html = `<div class="row intro"><p>管理账号、API Key 和每个连接的网络设置。</p><button class="primary" data-action="add-connection">＋ 添加连接</button></div>${connections()}`;
  if (page === 'models') html = `<p class="intro">这些模型通过同一个网关提供服务。客户端根据各自能力加载模型目录。</p>${modelsTable()}<p class="hint">模型列表不等于调用权限。首次接入请验证实际调用；自定义模型的上下文和能力需要与服务商说明核对。</p>`;
  if (page === 'clients') html = clientsPage();
  if (page === 'usage') {
    const daily: { date: string; count: number }[] = state.daily;
    const max = Math.max(1, ...daily.map(x => x.count));
    html = `<div class="row intro"><p>调用元数据保存在本机，不记录提示词和回复正文。</p><div><select id="days" class="compact"><option value="1">最近 1 天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select></div></div>${stats()}${state.usageWriteFailed ? '<div class="notice">部分统计写入失败，请检查本地磁盘空间和目录权限。</div>' : ''}<div class="panel"><div class="chart">${daily.map(x => `<div class="bar-group"><small>${x.count || ''}</small><div class="bar" style="height:${Math.max(2, x.count / max * 80)}px"></div><small>${x.date.slice(5)}</small></div>`).join('')}</div></div><div class="section-heading"><h3>请求明细</h3><button class="secondary" data-action="export">导出 CSV</button></div><div class="panel table-wrap">${state.records.length ? `<table><thead><tr><th>时间</th><th>客户端 / 模型</th><th>输入 / 输出</th><th>耗时</th><th>结果</th></tr></thead><tbody>${state.records.map((r: any) => `<tr><td>${escape(new Date(r.startedAt).toLocaleString())}</td><td><strong>${escape(r.clientId)}</strong><small>${escape(r.model)}</small></td><td>${r.tokens.input ?? '未知'} / ${r.tokens.output ?? '未知'}</td><td>${r.durationMs} ms</td><td><span class="tag ${r.status === 'success' ? '' : 'error'}">${r.status === 'success' ? '成功' : r.status === 'cancelled' ? '已取消' : '失败'}</span></td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无调用记录。接入客户端并发送请求后，这里会自动更新。</div>'}</div><p class="hint">明细显示最近 200 条；导出包含最近 90 天。套餐总额度查询尚未接入，当前仅统计经过本地网关的请求。</p>`;
  }
  $('#content').innerHTML = html;
  if (page === 'overview') {
    const access = $<HTMLInputElement>('#lan-access'); access.onchange = () => void action('service.lan', { enabled: access.checked }, '服务监听设置已更新').catch(() => refresh());
    const addresses = $<HTMLSelectElement>('#service-address'); addresses.value = selectedAddress; addresses.onchange = () => { selectedAddress = addresses.value; render(); };
  }
  if (page === 'clients' && clientPane === 'config') {
    const target = document.querySelector<HTMLSelectElement>('#config-target');
    if (target) target.onchange = () => { providerTarget = target.value; generatedPlan = undefined; render(); };
    const model = document.querySelector<HTMLSelectElement>('#config-model');
    if (model) model.onchange = () => { clientModels[modelSelectionKey()] = model.value; generatedPlan = undefined; render(); };
    const protocol = document.querySelector<HTMLSelectElement>('#config-protocol');
    if (protocol) protocol.onchange = () => { genericProtocol = protocol.value; render(); };
    if (selectedConfigModel() && targetClient() !== 'generic' && generatedPlan?.key !== planKey()) void prepareClientConfig();
  }
  if (page === 'connections') { const manage = document.createElement('button'); manage.className = 'secondary'; manage.dataset.action = 'manage-networks'; manage.textContent = '管理代理订阅'; $('#content .intro').append(manage); }
  $('#content').querySelectorAll<HTMLElement>('.connection-card').forEach(card => {
    const discovery = state.discoveries?.[card.dataset.connectionId!]; if (!discovery) return;
    const status = document.createElement('p'); status.className = 'discovery-state'; status.textContent = discovery.phase === 'loading' ? '正在自动获取模型…' : discovery.phase === 'ready' ? `模型目录已更新 · ${discovery.count} 个模型` : discovery.message ?? '获取失败，可重新获取或手动填写模型 ID。'; card.append(status);
  });
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
  try {
    const next = await call('state', { days, filters: usageFilters }); const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next; if (changed) render(); updateLogin(); updateNetworks();
  }
  catch (e: any) { $('#service-status').textContent = '网关连接异常'; toast(e.message, true); }
  finally { refreshing = false; }
}
function updateLogin() {
  if (!activeLogin || !$<HTMLDialogElement>('#login-dialog').open) return;
  const login = state.logins[activeLogin] ?? { phase: 'starting' };
  $('#login-content').innerHTML = login.phase === 'waiting' ? `<p class="hint">打开授权页面，登录 ChatGPT 并输入以下设备码。</p><div class="device-code">${escape(login.userCode)}</div><p class="hint">${escape(login.verificationUrl)}<br>如果设备码登录未启用，请在 ChatGPT 安全设置或工作区权限中开启。</p>` : login.phase === 'authenticated' ? `<div class="empty"><h3>账号已连接</h3><p>${escape(login.account)}</p><p>正在自动获取模型，稍后会更新目录。</p></div>` : `<div class="empty">${escape(login.error ?? (login.phase === 'cancelled' ? '登录已取消' : '正在启动设备码登录…'))}</div>`;
  $<HTMLButtonElement>('#open-login').disabled = login.phase !== 'waiting';
}
function openConnection(id?: string, provider?: string) {
  editing = id ? state.config.connections.find((c: any) => c.id === id) : undefined;
  const form = $<HTMLFormElement>('#connection-form'); form.reset();
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  field('proxy').innerHTML = proxyOptions();
  if (editing) { for (const name of ['name', 'provider', 'auth', 'baseUrl']) field(name).value = editing[name]; field('proxy').value = choiceValue(editing.proxy); field('modelIds').value = editing.models.map((m: any) => m.upstreamId).join('\n'); field('protocol').value = editing.models[0]?.protocols.length === 3 ? 'all' : editing.models[0]?.protocols[0] ?? 'chat'; }
  else { if (provider) field('provider').value = provider; providerChanged(); }
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
document.addEventListener('keydown', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
  if (!target || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...target.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (buttons.indexOf(target as HTMLButtonElement) + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault(); const next = buttons[index]!; next.click();
  if (next.dataset.clientPane) document.querySelector<HTMLButtonElement>(`[data-client-pane="${next.dataset.clientPane}"]`)?.focus();
});
document.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!target) return;
  if (target.dataset.close) { $<HTMLDialogElement>('#' + target.dataset.close).close(); return; }
  if (target.dataset.clientTab) { clientTab = target.dataset.clientTab; generatedPlan = undefined; render(); document.getElementById('tab-' + clientTab)?.focus(); return; }
  if (target.dataset.clientPane) { clientPane = target.dataset.clientPane; render(); return; }
  const next = target.dataset.page ?? target.dataset.go;
  if (next) { page = next; document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.page === page)); render(); return; }
  const operation = target.dataset.action; const id = target.dataset.id;
  void (async () => {
    target.setAttribute('disabled', '');
    try {
      if (operation === 'add-connection') openConnection(undefined, target.dataset.provider);
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
      if (operation === 'manage-networks') { $<HTMLDialogElement>('#network-dialog').showModal(); updateNetworks(); }
      if (operation === 'install-core') await action('network.install', {}, '内核已安装');
      if (operation === 'install-core-offline') await action('network.install-offline', {}, '离线安装操作已完成');
      if (operation === 'refresh-network') await action('network.refresh', { id }, '订阅已更新');
      if (operation === 'remove-network' && confirm('移除此订阅？')) await action('network.remove', { id }, '订阅已移除');
      if (operation === 'read-network-config') { const contents = await call('network.read-config'); if (contents !== null) $<HTMLTextAreaElement>('textarea[name="config"]').value = contents; }
      if (operation === 'detect-local') await action('local.detect', {}, '本机账号检测已完成');
      if (operation === 'import-local') await action('local.import', { id }, '已复用本机账号，正在自动获取模型');
      if (operation === 'discover') await action('connection.discover', { id }, '模型目录已同步');
      if (operation === 'login') { activeLogin = id; $<HTMLDialogElement>('#login-dialog').showModal(); updateLogin(); await action('device.login', { id }); }
      if (operation === 'delete' && confirm('移除此连接及其模型？已有客户端请求可能受到影响。')) await action('connection.delete', { id }, '连接已移除');
      if (operation === 'regenerate-config') await prepareClientConfig(true);
      if (['write-config', 'copy-config', 'export-config'].includes(operation ?? '')) {
        const plan = await prepareClientConfig(); if (!plan) throw new Error('请先生成可用的客户端配置。');
        if (operation === 'write-config') {
          clientBusy = true; render();
          try { await action('client.apply', { id: plan.id }, '配置已写入并备份，重新打开客户端后生效'); }
          finally { clientBusy = false; generatedPlan = undefined; render(); }
        }
        if (operation === 'copy-config') await action('client.copy-config', { id: plan.id, format: target.dataset.format }, '配置已复制，包含本网关访问密钥');
        if (operation === 'export-config') { const saved = await call('client.export-config', { id: plan.id, client: targetClient(), format: 'native' }); if (saved) toast('客户端配置已导出'); }
      }
      if (operation === 'copy-generic' || operation === 'export-generic') {
        const result = await call(operation === 'copy-generic' ? 'client.copy-generic' : 'client.export-generic', { model: selectedConfigModel(), protocol: genericProtocol, address: configAddress() });
        if (result) toast(operation === 'copy-generic' ? 'JSON 已复制，包含本网关访问密钥' : 'JSON 已导出');
      }
      if (operation === 'preview') { const result = await action('client.preview', { client: id, model: clientModels[id!] }); previewId = result.id; $('#preview-path').textContent = result.path; $('#preview-code').textContent = result.preview; $<HTMLDialogElement>('#preview-dialog').showModal(); }
      if (operation === 'restore' && confirm('恢复接入 Model Bridge 前的客户端配置？')) { await action('client.restore', { client: id }, '原配置已恢复'); generatedPlan = undefined; render(); }
      if (operation === 'copy-key') await action('client.copy-key', {}, '访问密钥已复制');
      if (operation === 'copy-address') await action('client.copy-address', { protocol: id, kind: target.dataset.kind, address: selectedAddress }, '地址已复制');
      if (operation === 'export') await action('usage.export', {}, '导出操作已完成');
    } catch (error: any) { toast(error.message ?? String(error), true); } finally { target.removeAttribute('disabled'); }
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
$<HTMLSelectElement>('select[name="source"]').onchange = event => { const subscription = (event.target as HTMLSelectElement).value === 'subscription'; $('#subscription-field').hidden = !subscription; $('#network-config-fields').hidden = subscription; };
$<HTMLFormElement>('#network-form').onsubmit = event => {
  event.preventDefault(); const form = new FormData(event.target as HTMLFormElement); const field = (key: string) => String(form.get(key) ?? '').trim();
  const button = (event.target as HTMLFormElement).querySelector<HTMLButtonElement>('button[type="submit"]')!; button.disabled = true;
  void action('network.save', { name: field('name'), source: field('source'), url: field('url'), config: field('config') }, '订阅已保存，请选择节点').then(id => {
    $<HTMLFormElement>('#network-form').reset(); $('#subscription-field').hidden = false; $('#network-config-fields').hidden = true;
    const select = $<HTMLSelectElement>('select[name="proxy"]'); select.innerHTML = proxyOptions(); select.value = `managed:${id}`;
  }).catch(() => {}).finally(() => button.disabled = false);
};
$<HTMLFormElement>('#model-form').onsubmit = event => {
  event.preventDefault(); if (!editingModel) return;
  const fields = new FormData(event.target as HTMLFormElement); const value = (key: string) => String(fields.get(key) ?? '').trim();
  const connection = structuredClone(state.config.connections.find((c: any) => c.id === editingModel!.connectionId));
  const model = connection.models.find((m: any) => m.id === editingModel!.modelId);
  if ((value('priceInput') === '') !== (value('priceOutput') === '')) { toast('请同时填写输入和输出价格，或全部留空。', true); return; }
  Object.assign(model, { name: value('name'), contextWindow: Number(value('contextWindow')), enabled: value('enabled') === 'true', tools: value('tools') === 'true', images: value('images') === 'true', reasoning: value('reasoning').split(',').map(s => s.trim()).filter(Boolean), price: value('priceInput') === '' ? undefined : { input: Number(value('priceInput')), output: Number(value('priceOutput')), ...(value('priceCached') !== '' ? { cachedInput: Number(value('priceCached')) } : {}) } });
  void action('connection.save', { connection, autoDiscover: false }, '模型设置已保存').then(() => $<HTMLDialogElement>('#model-dialog').close()).catch(() => {});
};
$('#cancel-login').onclick = () => void action('device.cancel', { id: activeLogin }).catch(() => {});
$('#apply-client').onclick = () => void action('client.apply', { id: previewId }, '配置已应用，请重新启动客户端').then(() => $<HTMLDialogElement>('#preview-dialog').close()).catch(() => {});
void refresh(); setInterval(() => { if (!clientBusy && !document.querySelector('select:focus, .config-code:focus') && !window.getSelection()?.toString()) void refresh(); }, 4000);
export {};
