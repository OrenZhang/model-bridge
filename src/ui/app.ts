import { modelModeOptions, modeLabels, type ReasoningMode } from '../shared/reasoning-modes.js';
import { connectionState } from './connection-state.js';
import type { UpdateState } from '../shared/updates.js';
declare global { interface Window { modelBridge: { call: (operation: string, payload?: unknown) => Promise<any>; onUpdate: (listener: (state: UpdateState) => void) => () => void } } }
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const number = (n: number) => new Intl.NumberFormat('zh-CN', { notation: n >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const providerNames: Record<string, string> = { openai: 'ChatGPT / OpenAI', kimi: 'Kimi', minimax: 'MiniMax', anthropic: 'Anthropic', deepseek:'DeepSeek', custom: '自定义服务' };
const titles: Record<string, string> = { overview: '对外服务', connections: '连接', models: '模型', clients: '客户端', usage: '用量统计' };
let state: any; let page = 'connections'; let days = 60; let editing: any; let activeLogin: string | undefined; let toastTimer: ReturnType<typeof setTimeout>; let refreshing = false;
const usageFilters: Record<string, string> = {};
let editingModel: { connectionId: string; modelId: string } | undefined;
let selectedAddress = '';
const clientTabs = [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude Code' }];
let clientTab = 'codex'; let clientBusy = false;
let connectionSource = 'login'; let connectionSaving = false; let reuseSnapshot = '';
let loginStarting = false; let loginAttempt = 0;
let portableKeyId='';
let portableClient = 'codex'; let portableAddress = ''; let portableRevision = 0;
let updateRecoveryShown = false;
let updateMarkup = '';
let updateNotesIdentity = '';

async function call(operation: string, payload?: unknown) { return window.modelBridge.call(operation, payload); }
function updatePanel() {
  const update: UpdateState | undefined = state?.update;
  if (!update) return;
  if (update.recovered && !updateRecoveryShown) { updateRecoveryShown = true; $<HTMLDialogElement>('#update-dialog').showModal(); }
  const busy = ['checking', 'downloading', 'installing'].includes(update.phase);
  const labels: Record<UpdateState['phase'], string> = { idle: '检查 GitHub Releases 中的新版本', checking: '正在检查更新…', current: '当前已是最新版本', available: '有新版本可用', downloading: '正在下载安装包…', downloaded: '下载完成，已通过校验', installing: '正在启动安装…', error: '更新未完成', development: '源码运行模式，请使用安装包检查更新' };
  const versionButton = $('#app-version');
  versionButton.textContent = `v${update.currentVersion}${['available', 'downloaded'].includes(update.phase) ? ' · 有更新' : ''}`;
  const canDownload = update.phase === 'available' || (update.phase === 'error' && update.retry === 'download');
  const canInstall = update.phase === 'downloaded' || (update.phase === 'error' && update.retry === 'install');
  const markup = `<p class="update-version">当前版本 <code>${escape(update.currentVersion)}</code>${update.latestVersion ? ` <span>→</span> <code>${escape(update.latestVersion)}</code>` : ''}</p><p role="status">${labels[update.phase]}</p>${update.phase === 'downloading' ? `<progress class="update-progress" max="100" value="${Math.min(100, Math.max(0, update.percent ?? 0))}" aria-label="更新下载进度"></progress><p class="hint">${Math.round(update.percent ?? 0)}%${update.total ? ` · ${(Number(update.transferred ?? 0) / 1048576).toFixed(1)} / ${(update.total / 1048576).toFixed(1)} MB` : ''}</p>` : ''}${update.message ? `<p class="${update.phase === 'error' ? 'notice' : 'hint'}">${escape(update.message)}</p>` : ''}${update.networkLabel ? `<p class="hint">更新网络：${escape(update.networkLabel)}</p>` : ''}${update.notes ? `<details class="update-notes"><summary>更新说明</summary><pre>${escape(update.notes)}</pre></details>` : ''}<p class="hint">点击“检查并更新”后，有新版本会自动下载、校验并重启；进行中的模型请求完成后再安装。</p><div class="dialog-actions"><button class="plain" data-action="update-releases">查看 Releases</button><button class="secondary" data-action="update-check" ${busy || update.phase === 'development' ? 'disabled' : ''}>${update.phase === 'error' && update.retry === 'check' ? '重新检查并更新' : '检查并更新'}</button>${canDownload ? '<button class="primary" data-action="update-download">下载更新</button>' : ''}${canInstall ? `<button class="primary" data-action="update-install">安装并重启</button>` : ''}</div>`;
  const content = $('#update-content');
  const identity = JSON.stringify([update.latestVersion ?? update.currentVersion, update.notes ?? '']);
  if (markup === updateMarkup && content.hasChildNodes()) return;
  const oldNotes = content.querySelector<HTMLDetailsElement>('.update-notes');
  const expanded = identity === updateNotesIdentity && !!oldNotes?.open;
  const notesScroll = oldNotes?.querySelector('pre')?.scrollTop ?? 0;
  const dialog = $<HTMLDialogElement>('#update-dialog');
  const dialogScroll = dialog.scrollTop;
  content.innerHTML = markup;
  const newNotes = content.querySelector<HTMLDetailsElement>('.update-notes');
  if (newNotes) {
    newNotes.open = expanded;
    const text = newNotes.querySelector('pre');
    if (text && expanded) text.scrollTop = notesScroll;
  }
  dialog.scrollTop = dialogScroll;
  updateMarkup = markup;
  updateNotesIdentity = identity;
}
function toast(message: string, error = false) {
  const element = $('#toast');
  element.textContent = message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  element.classList.toggle('error', error);
  element.hidden = false;
  // Native modal dialogs live above every document z-index. A manual popover
  // places feedback above the modal without moving focus out of its form.
  if (element.matches(':popover-open')) element.hidePopover();
  element.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidePopover(); element.hidden = true; }, error ? 9000 : 4500);
}
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
  return `<div class="panel endpoint-panel"><div class="endpoint-toolbar"><strong>统一接口</strong><div class="endpoint-controls"><label class="toggle"><input id="lan-access" type="checkbox" ${state.config.listenHost === '0.0.0.0' ? 'checked' : ''} />局域网访问</label><select id="service-address" aria-label="服务地址">${addresses.map((address: string) => `<option value="${escape(address)}">${escape(address)}${address === state.address ? ' · 本机' : ' · 局域网'}</option>`).join('')}</select></div></div><div class="table-wrap"><table class="endpoint-table"><thead><tr><th>接口</th><th>客户端 Base URL</th><th>请求路径</th></tr></thead><tbody>${[['responses', 'Responses', '/v1', '/v1/responses'], ['messages', 'Messages', '', '/v1/messages'], ['chat', 'Chat Completions', '/v1', '/v1/chat/completions']].map(([id, name, base, endpoint]) => `<tr><td><strong>${name}</strong></td><td><div class="address-cell"><code>${escape(selectedAddress + base)}</code><button class="copy-button" data-action="copy-address" data-id="${id}" data-kind="base" aria-label="复制 ${name} 基础地址" title="复制基础地址">复制</button></div></td><td><div class="address-cell"><code>${endpoint}</code><button class="copy-button" data-action="copy-address" data-id="${id}" data-kind="endpoint" aria-label="复制 ${name} 完整请求地址" title="复制完整请求地址">复制</button></div></td></tr>`).join('')}</tbody></table></div>${state.config.listenHost === '0.0.0.0' ? '<div class="endpoint-note">监听 0.0.0.0 · 其他设备使用网卡地址和访问密钥连接，系统防火墙需允许该端口。</div>' : ''}</div>`;
}
function localAccountPanel() {
  return `<div class="section-heading"><h3>本机 Codex 登录</h3><button type="button" class="secondary" data-action="detect-local">重新检测</button></div><div class="panel local-accounts">${(state.localAccounts ?? []).map((account: any) => `<div class="local-account"><div><strong>${escape(account.email ?? (account.kind === 'api-key' ? 'OpenAI API Key 登录' : '未检测到可复用账号'))}</strong>${account.plan ? `<span class="tag">${escape(account.plan)}</span>` : ''}<p>当前连接：${escape(account.provider === 'model_bridge' ? 'Model Bridge' : account.provider === 'openai' ? '官方 OpenAI / ChatGPT' : account.provider)}${account.model ? ' · ' + escape(account.model) : ''}</p><small>${escape(account.directory)}</small>${account.message ? `<p class="hint">${escape(account.message)}</p>` : ''}</div><button class="${account.imported ? 'secondary' : 'primary'}" type="button" data-action="import-local" data-id="${escape(account.id)}" ${!account.canImport || account.imported ? 'disabled' : ''}>${account.imported ? '已接入账号' : '复用此账号'}</button></div>`).join('') || '<div class="empty">正在检测本机 Codex 配置与登录状态…</div>'}</div><p class="hint">保存独立登录副本，作为一个连接添加。若登录失效，可在连接中重新授权。</p>`;
}
function updateNetworks() {
  if (!$<HTMLDialogElement>('#network-dialog').open) return;
  const overview = state.managedNetworks ?? { core: {}, profiles: [] };
  $('#network-core-status').innerHTML = `<div class="notice">mihomo ${escape(overview.core.version ?? '')} · ${overview.core.downloading ? '下载中…' : overview.core.installed ? '已安装，使用时自动启动' : overview.core.bundled ? '已附带官方内核，首次使用自动安装' : '首次使用时下载官方内核'}<div class="row"><button class="plain" data-action="install-core" ${overview.core.installed || overview.core.downloading ? 'disabled' : ''}>${overview.core.bundled ? '安装内置内核' : '下载内核'}</button><button class="plain" data-action="install-core-offline">离线导入内核</button></div>${overview.core.error ? `<p class="hint service-error">${escape(overview.core.error)}</p>` : ''}</div>`;
  $('#network-profiles').innerHTML = overview.profiles.map((profile: any) => {
    const automatic = profile.selectionMode !== 'manual';
    const checks = profile.checks ?? [];
    return `<div class="network-profile"><div class="row"><strong>${escape(profile.name)}</strong><span class="tag">${escape({ stopped: '按需启动', starting: '启动中', running: '运行中', error: '启动失败' }[profile.status as string] ?? profile.status)}</span></div>
      <label>使用节点<select data-network-id="${escape(profile.id)}"><option value="auto" ${automatic ? 'selected' : ''}>自动 · AI 可用优选（最低延迟）</option>${profile.nodes.map((node: string) => `<option value="manual:${escape(node)}" ${!automatic && node === profile.selected ? 'selected' : ''}>${escape(node)}</option>`).join('')}</select></label>
      ${automatic ? `<p class="hint">按连接检测 AI 接口，每 5 分钟复测。切换只影响后续请求。</p>${checks.length ? checks.map((check: any) => `<div class="network-check"><span class="status-dot ${check.selected ? 'success' : check.checking ? '' : 'error'}"></span><div><strong>${escape(check.target)}</strong><small>${check.checking ? '正在检测… · ' : ''}${check.selected ? `${escape(check.selected)} · ${number(check.latencyMs)} ms · ${check.available}/${check.total} 可用` : check.checking ? '首次检测可能需要一些时间' : '暂无通过检测的节点'}${check.checkedAt ? ` · ${escape(new Date(check.checkedAt).toLocaleTimeString())}` : ''}</small></div></div>`).join('') : '<p class="hint">首次使用连接时自动检测，也可点击立即检测。不验证账号额度或模型权限。</p>'}` : ''}
      ${profile.error ? `<p class="hint">${escape(profile.error)}</p>` : ''}<div class="row"><div>${automatic ? `<button class="plain" data-action="check-network" data-id="${escape(profile.id)}" ${checks.some((c: any) => c.checking) ? 'disabled' : ''}>立即检测</button>` : ''}${profile.source === 'subscription' ? `<button class="plain" data-action="refresh-network" data-id="${escape(profile.id)}">更新订阅</button>` : ''}</div><button class="plain danger" data-action="remove-network" data-id="${escape(profile.id)}">移除</button></div></div>`;
  }).join('');
  $('#network-profiles').querySelectorAll<HTMLSelectElement>('select').forEach(select => { select.onchange = () => void action(select.value === 'auto' ? 'network.auto' : 'network.select', { id: select.dataset.networkId, node: select.value.slice(7) }, '节点模式已切换').catch(() => {}); });
}
function connections() {
  const entries = state.config.connections;
  if (!entries.length) return `<div class="panel empty"><h3>添加你的第一个连接</h3><p>登录 ChatGPT、复用本机账号，或添加 API 服务。</p><button class="primary" data-action="add-connection">＋ 添加连接</button></div>`;
  return Object.entries(providerNames).map(([provider, name]) => {
    const group = entries.filter((c: any) => c.provider === provider); if (!group.length) return '';
    return `<section class="connection-group"><div class="group-label">${escape(name)} <span>${group.length} 个连接</span></div><div class="panel connection-list">${group.map((c: any) => {
      const login = state.logins[c.id]; const discovery = state.discoveries[c.id];
      const detail = c.auth === 'subscription' ? (login?.account ?? c.accountEmail ?? '订阅账号') + ' · ' + (c.region === 'global' ? '国际区' : '中国区') : c.auth === 'chatgpt-device' ? (login?.account ?? c.accountEmail ?? (c.accountId ? 'ChatGPT 账号' : '尚未登录')) + ' · ' + (c.loginMethod === 'browser' ? '官方登录' : '设备码登录') : c.auth === 'none' ? '本地服务' : 'API Key';
      const health = connectionState(c, login, discovery, state.connectionChecks?.[c.id]); const status = health.label;
      return `<div class="connection-card" data-connection-id="${escape(c.id)}"><div class="provider-icon">${escape(name[0])}</div><div class="connection-description"><h3>${escape(c.name)}</h3><small>${escape(detail)} · ${c.models.length} 个模型${discovery?.source === 'preset' ? ' · 官方预置目录，权限以套餐为准' : ''}</small></div><span class="connection-status ${health.tone}" title="${escape(health.detail ?? status)}" aria-label="${escape(status)}"><span class="status-dot" aria-hidden="true"></span><span class="status-label">${status}</span></span><div class="connection-actions">${['chatgpt-device', 'subscription'].includes(c.auth) && ['待登录', '需重新登录'].includes(status) ? `<button class="plain" data-action="login" data-id="${escape(c.id)}">登录</button>` : ''}<button class="secondary" data-action="edit" data-id="${escape(c.id)}">管理</button></div></div>`;
    }).join('')}</div></section>`;
  }).join('') + '<button class="add-another" data-action="add-connection">＋ 添加其他账号或 API 服务</button>';
}
function modelsTable() {
  const catalog = state.managedModels ?? state.modelCatalog ?? [];
  if (!catalog.length) return '<div class="panel empty"><h3>暂无模型</h3><p>添加连接后自动获取，也可手动添加模型。</p></div>';
  return `<div class="panel table-wrap"><table><thead><tr><th>对外提供</th><th>模型</th><th>服务商</th><th>账号</th><th></th></tr></thead><tbody>${catalog.map((entry: any) => `<tr class="${entry.exposedAccounts ? '' : 'model-hidden'}"><td><input class="model-exposure" type="checkbox" data-model-exposure="${escape(entry.id)}" aria-label="对外提供 ${escape(entry.name)}" ${entry.enabled ? 'checked' : ''} /></td><td><strong>${escape(entry.name)}</strong></td><td>${escape(providerNames[entry.provider])}</td><td>${entry.exposedAccounts ?? entry.members.length} / ${entry.members.length} 个账号对外${entry.members.length > 1 ? ' · 自动分发' : ''}</td><td><button class="secondary" data-action="pool-details" data-id="${escape(entry.id)}">查看</button></td></tr>`).join('')}</tbody></table></div>`;
}
function showPool(id: string) {
  const entry = (state.managedModels ?? state.modelCatalog).find((e: any) => e.id === id); if (!entry) return;
  $('#pool-title').textContent = entry.name;
  $('#pool-content').innerHTML = `<p class="hint">${escape(providerNames[entry.provider])} · ${entry.exposedAccounts ?? entry.members.length} / ${entry.members.length} 个账号对外${entry.members.length > 1 ? ' · 新对话轮流分配' : ''}</p><div class="pool-members">${entry.members.map((member: any) => `<div class="pool-member"><div><strong>${escape(member.name)}</strong><small>${escape(member.model)}</small></div><button class="plain" data-action="model-edit" data-id="${escape(member.connectionId)}" data-model="${escape(member.modelId)}">模型设置</button></div>`).join('')}</div><p class="hint">同一对话的消息、thinking 和工具结果始终回到原账号。原账号不可用时会提示处理。</p>`;
  $<HTMLDialogElement>('#pool-dialog').showModal();
}
function accessKeyPanel(){
 const keys=state.accessKeys??[];
 return `<div class="section-heading"><h3>访问密钥</h3><span class="hint">近 ${days} 天 · 本机客户端密钥单独管理</span></div><div class="panel"><form id="access-key-form" class="key-create"><input name="keyName" aria-label="密钥名称" placeholder="例如：我的 Linux、同事的电脑" required maxlength="100"/><button class="primary" type="submit">创建独立 Key</button></form>${keys.length?`<div class="table-wrap"><table><thead><tr><th>名称</th><th>状态</th><th>请求数</th><th>输入 / 输出 Token</th><th>操作</th></tr></thead><tbody>${keys.map((k:any)=>`<tr><td><strong>${escape(k.name)}</strong></td><td>${k.enabled?'启用':'停用'}</td><td>${number(k.requests)}</td><td>${number(k.inputTokens)} / ${number(k.outputTokens)}</td><td><button class="plain" data-action="access-copy" data-id="${escape(k.id)}" ${k.enabled?'':'disabled'}>复制</button><button class="plain" data-action="access-usage" data-id="${escape(k.id)}">用量</button><button class="plain" data-action="access-rename" data-id="${escape(k.id)}">改名</button><button class="plain" data-action="access-toggle" data-id="${escape(k.id)}">${k.enabled?'停用':'启用'}</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">创建独立 Key 后，可复制配置给其他设备使用。</div>'}</div>`;
}
function renderReasoningSettings(){
 const models=editing?.models??[];const provider=$<HTMLSelectElement>('select[name="provider"]').value;
 const connection={provider,auth:editing?.auth??'api-key'};
 const available=models.filter((m:any)=>modelModeOptions(connection,m).length>2);
 $('#reasoning-models').innerHTML=available.length?available.map((m:any)=>{const modes=modelModeOptions(connection,m);const value=editing?.reasoningModes?.[m.upstreamId]??'client';return `<label>${escape(m.name)}<select data-reasoning-model="${escape(m.upstreamId)}" aria-label="${escape(m.name)} 推理模式">${modes.includes(value as ReasoningMode)?'':`<option value="${escape(value)}" disabled selected>原设置已不受支持，请重新选择</option>`}${modes.map(mode=>`<option value="${mode}" ${mode===value?'selected':''}>${modeLabels[mode]}</option>`).join('')}</select></label>`;}).join(''):'<p class="hint">获取模型后显示其支持的模式；未声明推理能力的模型保持客户端或服务商默认。</p>';
}
function clientsPage() {
  const client = clientTabs.find(item => item.id === clientTab)!;
  const status = state.clientStatuses?.[clientTab];
  const unified = status?.mode === 'bridge';
  const original = status && ['external', 'unconfigured'].includes(status.mode);
  const available = (state.modelCatalog ?? []).filter((entry: any) => entry.tools);
  const providers = state.config.connections.filter((c: any) => c.enabled).length;
  const disabled = clientBusy || !status || status.mode === 'error';
  const tabs = `<div class="client-tabs" role="tablist" aria-label="客户端">${clientTabs.map(item => `<button id="tab-${item.id}" role="tab" aria-selected="${clientTab === item.id}" aria-controls="client-tab-panel" tabindex="${clientTab === item.id ? 0 : -1}" class="${clientTab === item.id ? 'active' : ''}" data-client-tab="${item.id}">${item.name}</button>`).join('')}</div>`;
  return `${tabs}<section id="client-tab-panel" role="tabpanel" aria-labelledby="tab-${clientTab}"><div class="mode-heading"><p>选择 ${client.name} 的使用模式</p><button class="plain" data-go="connections">管理服务商 →</button></div><div class="panel mode-list"><div class="mode-row ${unified ? 'is-current' : ''}"><div class="mode-symbol">⇄</div><div class="mode-description"><h3>统一模型</h3><p>连接本地网关，使用所有已接入服务商的模型。</p><small>${providers} 个连接 · ${available.length} 个模型 · 客户端无需单独登录服务商</small></div><div class="mode-actions">${unified ? '<span class="using-service">使用中</span>' : `<button class="primary" data-action="use-gateway" ${disabled || !available.length ? 'disabled' : ''}>启用</button>`}</div></div><div class="mode-row ${original ? 'is-current' : ''}"><div class="mode-symbol native-mode">↶</div><div class="mode-description"><h3>原始认证</h3><p>使用客户端原来的连接和账号认证。</p><small>保留原有登录，可随时切回</small></div>${original ? '<span class="using-service">使用中</span>' : `<button class="secondary" data-action="use-original" ${disabled || !status?.canRestore ? 'disabled' : ''}>切换</button>`}</div></div>${status?.error ? `<p class="hint service-error">${escape(status.error)}</p>` : ''}${!available.length ? '<p class="switch-note">添加服务商后即可启用统一模型，模型会自动汇总。</p>' : '<p class="switch-note">统一模式下直接在客户端选择模型。切换模式后，已打开的客户端可能需要重启。</p>'}${unified && !status.canRestore ? '<p class="hint service-error">未找到可用的原始配置备份，暂时无法切回。</p>' : ''}</section>`;
}
async function updatePortableConfig(preferLan = false) {
  const revision = ++portableRevision;
  const addresses = [state.address, ...(state.lanAddresses ?? [])];
  if (preferLan || !addresses.includes(portableAddress)) portableAddress = state.lanAddresses?.[0] ?? state.address;
  const selector = $<HTMLSelectElement>('#portable-address');
  selector.innerHTML = addresses.map((address: string) => `<option value="${escape(address)}">${escape(address)} · ${address === state.address ? '本机' : '局域网'}</option>`).join('');
  selector.value = portableAddress;
  const keys=(state.accessKeys??[]).filter((k:any)=>k.enabled);
  if(!keys.some((k:any)=>k.id===portableKeyId))portableKeyId=keys[0]?.id??'';
  $<HTMLSelectElement>('#portable-key').innerHTML=keys.map((k:any)=>`<option value="${escape(k.id)}">${escape(k.name)}</option>`).join('');
  $<HTMLSelectElement>('#portable-key').value=portableKeyId;
  $('#portable-description').textContent = portableAddress === state.address ? '当前地址仅本机可用。分享给其他设备前，请开启局域网访问并选择网卡地址。' : '其他设备使用此网卡地址连接；两台电脑需网络互通，并允许此端口通过防火墙。';
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#portable-dialog [data-portable]')];
  $('#portable-feedback').textContent = '';
  buttons.forEach(button => button.disabled = true); $('#portable-preview').textContent = '正在生成…';
  try {
    const result = await call('client.portable-preview', { client: portableClient, address: portableAddress, keyId:portableKeyId });
    if (revision !== portableRevision) return;
    $('#portable-preview').textContent = result.preview;
    $('#portable-instructions').textContent = result.instructions;
    $<HTMLButtonElement>('#portable-copy-catalog').hidden = !result.requiresCatalog;
    $('#portable-copy-config').textContent = `复制 ${result.filename}`;
    buttons.forEach(button => button.disabled = false);
  } catch (error: any) { if (revision === portableRevision) $('#portable-preview').textContent = error.message; }
}
function render() {
  updatePanel();
  $('#page-title').textContent = titles[page]!;
  $('#service-status').innerHTML = '<i></i> 本地网关运行中';
  let html = '';
  if (page === 'overview') html = `<p class="intro">为其他设备提供模型服务，按独立密钥统计用量。</p>${endpointCards()}${accessKeyPanel()}<div class="section-heading"><h3>复制接入配置</h3><span class="hint">使用下方选中的独立 Key</span></div><div class="panel service-exports"><label>配置使用的密钥<select id="service-key">${(state.accessKeys??[]).filter((k:any)=>k.enabled).map((k:any)=>`<option value="${escape(k.id)}" ${k.id===portableKeyId?'selected':''}>${escape(k.name)}</option>`).join('')}</select></label>${clientTabs.map(c=>`<button class="secondary" data-action="portable-config" data-id="${c.id}" ${(state.accessKeys??[]).some((k:any)=>k.enabled)&&state.modelCatalog?.length?'':'disabled'}>${c.name} 配置与脚本</button>`).join('')}</div>`;
  if (page === 'connections') html = `<div class="row intro connection-toolbar"><p>${state.config.connections.length} 个连接 · ${new Set(state.config.connections.map((c: any) => c.provider)).size} 个服务商</p><div class="toolbar-actions"><button class="secondary" data-action="manage-networks">代理订阅</button><button class="primary" data-action="add-connection">＋ 添加连接</button></div></div>${connections()}<p class="hint">同模型多账号分摊不同对话，后续消息与工具调用保持在原账号。</p>`;
  if (page === 'models') html = `<p class="intro">这些模型通过同一个网关提供服务。客户端根据各自能力加载模型目录。</p>${modelsTable()}<p class="hint">模型列表不等于调用权限。首次接入请验证实际调用；自定义模型的上下文和能力需要与服务商说明核对。</p>`;
  if (page === 'clients') html = clientsPage();
  if (page === 'usage') {
    const daily: { date: string; count: number }[] = state.daily;
    const max = Math.max(1, ...daily.map(x => x.count));
    html = `<div class="row intro"><p>用量仅保留最近 60 天，过期自动删除；不记录提示词和回复正文。</p><div><select id="days" class="compact"><option value="1">最近 1 天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="60">最近 60 天</option></select></div></div>${stats()}${state.usageWriteFailed ? '<div class="notice">部分统计写入失败，请检查本地磁盘空间和目录权限。</div>' : ''}<div class="panel"><div class="chart ${daily.length > 7 ? 'dense' : ''}">${daily.map((x, i) => `<div class="bar-group" title="${x.date} · ${x.count} 次请求"><small>${daily.length <= 7 ? x.count || '' : '&nbsp;'}</small><div class="bar" style="height:${Math.max(2, x.count / max * 80)}px"></div><small>${i % Math.ceil(daily.length / 7) === 0 || i === daily.length - 1 ? x.date.slice(5) : '&nbsp;'}</small></div>`).join('')}</div></div><div class="section-heading"><h3>请求明细</h3><button class="secondary" data-action="export">导出 CSV</button></div><div class="panel table-wrap">${state.records.length ? `<table><thead><tr><th>时间</th><th>客户端 / 模型</th><th>输入 / 输出</th><th>耗时</th><th>结果</th></tr></thead><tbody>${state.records.map((r: any) => `<tr><td>${escape(new Date(r.startedAt).toLocaleString())}</td><td><strong>${escape(state.config.clients.find((c:any)=>c.id===r.clientId)?.name??r.clientId)}</strong><small>${escape(r.model)}</small></td><td>${r.tokens.input ?? '未知'} / ${r.tokens.output ?? '未知'}</td><td>${r.durationMs} ms</td><td><span class="tag ${r.status === 'success' ? '' : 'error'}">${r.status === 'success' ? '成功' : r.status === 'cancelled' ? '已取消' : '失败'}</span></td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无调用记录。接入客户端并发送请求后，这里会自动更新。</div>'}</div><p class="hint">明细显示最近 200 条；导出包含最近 60 天。套餐总额度查询尚未接入，当前仅统计经过本地网关的请求。</p>`;
  }
  $('#content').innerHTML = html;
  if (page === 'overview') {
    const access = $<HTMLInputElement>('#lan-access'); access.onchange = () => void action('service.lan', { enabled: access.checked }, '服务监听设置已更新').catch(() => refresh());
    const keySelect=$<HTMLSelectElement>('#service-key');if(keySelect){if(![...keySelect.options].some(o=>o.value===portableKeyId))portableKeyId=keySelect.options[0]?.value??'';keySelect.value=portableKeyId;keySelect.onchange=()=>{portableKeyId=keySelect.value;};}
    const addresses = $<HTMLSelectElement>('#service-address'); addresses.value = selectedAddress; addresses.onchange = () => { selectedAddress = addresses.value; render(); };
  }
  if (page === 'usage') {
    const filters = document.createElement('div'); filters.className = 'usage-filters';
    filters.innerHTML = Object.entries({ clientId: '客户端', provider: '服务商', connectionId: '账号', model: '模型' }).map(([key, name]) => `<label>${name}<select data-filter="${key}"><option value="">全部</option>${state.usageOptions[key].map((v: string) => `<option value="${escape(v)}">${escape(key === 'clientId' ? state.config.clients.find((c:any)=>c.id===v)?.name??v : key === 'provider' ? providerNames[v] ?? v : key === 'connectionId' ? state.config.connections.find((c: any) => c.id === v)?.name ?? v : v)}</option>`).join('')}</select></label>`).join('');
    $('#content .intro').after(filters);
    filters.querySelectorAll<HTMLSelectElement>('select').forEach(select => { select.value = usageFilters[select.dataset.filter!] ?? ''; select.onchange = () => { usageFilters[select.dataset.filter!] = select.value; void refresh(); }; });
  }
  if (page === 'models') document.querySelectorAll<HTMLInputElement>('[data-model-exposure]').forEach(input => { input.indeterminate = state.managedModels?.find((entry: any) => entry.id === input.dataset.modelExposure)?.mixed === true; });
  if (page === 'usage') { const select = $<HTMLSelectElement>('#days'); select.value = String(days); select.onchange = () => { days = Number(select.value); void refresh(); }; }
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const next = await call('state', { days, filters: usageFilters }); const changed = JSON.stringify(next) !== JSON.stringify(state);
    state = next; if (changed) render(); updateLogin(); updateNetworks(); updateReuse();
  }
  catch (e: any) { $('#service-status').textContent = '网关连接异常'; toast(e.message, true); }
  finally { refreshing = false; }
}
function updateLogin() {
  if (!activeLogin || !$<HTMLDialogElement>('#login-dialog').open) return;
  const connection = state.config.connections.find((c: any) => c.id === activeLogin);
  const login = loginStarting ? {phase:'starting'} : state.logins[activeLogin] ?? { phase: 'starting' };
  const method = login.method ?? connection?.loginMethod;
  const discovery = state.discoveries[activeLogin];
  const provider = providerNames[connection?.provider] ?? 'ChatGPT';
  const subscription = connection?.auth === 'subscription';
  $('#login-provider').textContent = subscription ? provider : 'CHATGPT';
  $('#login-title').textContent = subscription ? provider + ' 订阅登录' : method === 'browser' ? 'ChatGPT 官方登录' : 'ChatGPT 设备码登录';
  if (login.phase === 'authenticated') {
    activeLogin = undefined; loginStarting = false; loginAttempt++;
    $<HTMLDialogElement>('#login-dialog').close();
    toast(discovery?.phase === 'ready' ? '账号已连接，已加载 ' + discovery.count + ' 个模型' : discovery?.phase === 'error' ? '授权已完成，模型同步失败，请在连接中重试' : '账号已连接，模型目录正在同步', discovery?.phase === 'error');
    return;
  }
  $('#login-content').innerHTML = login.phase === 'waiting' && method === 'browser' ? '<div class="empty"><h3>在浏览器完成登录</h3><p>授权完成后会自动连接。添加其他账号时，请在授权页选择对应账号。</p></div>' : login.phase === 'waiting' ? `<p class="hint">打开授权页面，登录 ${escape(provider)} 并按页面提示确认授权。</p><div class="device-code">${escape(login.userCode)}</div><p class="hint">${escape(login.verificationUrl)}${subscription ? '' : '<br>如果设备码登录未启用，请在 ChatGPT 安全设置或工作区权限中开启。'}</p>` : login.phase === 'authenticated' ? `<div class="empty"><h3>账号已连接</h3><p>${escape(login.account)}</p><p>${discovery?.phase === 'ready' ? '已加载 ' + discovery.count + ' 个模型。' : discovery?.phase === 'error' ? '账号授权已完成，模型同步失败：' + escape(discovery.message) : '正在加载模型目录…'}</p></div>` : `<div class="empty">${escape(login.error ?? (login.phase === 'cancelled' ? '登录已取消' : login.phase === 'idle' ? '当前未发起登录，请关闭窗口后重新授权。' : '正在启动登录…'))}</div>`;
  $<HTMLButtonElement>('#open-login').disabled = login.phase !== 'waiting';
}
async function showLogin(id: string) {
  const attempt = ++loginAttempt; activeLogin = id; loginStarting = true;
  $<HTMLDialogElement>('#login-dialog').showModal(); updateLogin();
  try { const result = await action('device.login', {id}); if (attempt === loginAttempt) state.logins[id] = result; }
  catch (error: any) { if (attempt === loginAttempt) state.logins[id] = {phase:'error',error:error.message}; }
  finally { if (attempt === loginAttempt) { loginStarting = false; updateLogin(); } }
}
function updateReuse() {
  if (!$<HTMLDialogElement>('#connection-dialog').open || connectionSource !== 'reuse') return;
  const snapshot = JSON.stringify(state.localAccounts);
  if (snapshot === reuseSnapshot) return; reuseSnapshot = snapshot;
  $('#reuse-login').innerHTML = localAccountPanel();
}
function setConnectionSource(source: string) {
  connectionSource = source;
  const form = $<HTMLFormElement>('#connection-form');
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const openai = field('provider').value === 'openai';
  const subscribable = ['kimi', 'minimax'].includes(field('provider').value);
  if (source === 'login' && subscribable) field('auth').value = 'subscription';
  if (source === 'login' && openai && !field('auth').value.startsWith('chatgpt-')) field('auth').value = 'chatgpt-browser';
  if (source === 'api') field('auth').value = $('#api-auth') instanceof HTMLSelectElement ? $<HTMLSelectElement>('#api-auth').value : 'api-key';
  $('#connection-tabs').hidden = !(openai || subscribable) || !!editing;
  $('#source-reuse').hidden = !openai;
  $('#reuse-login').hidden = source !== 'reuse'; $('#connection-details').hidden = source === 'reuse';
  field('name').required = source !== 'reuse';
  field('baseUrl').required = source === 'api';
  $('#api-fields').hidden = source !== 'api'; $('#login-methods').hidden = source !== 'login' || !openai;
  $('#subscription-fields').hidden = source !== 'login' || !subscribable;
  $('#subscription-note').textContent = field('provider').value === 'minimax' ? '登录 MiniMax Code Token Plan 账号。开放平台 Coding Plan 请使用 API Key 接入；两者的计费和接口地址不同。' : '通过 Kimi 官方授权页面登录，使用 Kimi Code 订阅权益。支持多个独立账号。';
  $('#api-key-label').hidden = field('auth').value === 'none';
  $('#save-connection').textContent = source === 'login' ? (subscribable ? '获取订阅登录授权' : field('auth').value === 'chatgpt-browser' ? '打开浏览器登录' : '获取设备码') : '保存并获取模型';
  if (editing) $('#save-connection').textContent = '保存设置';
  document.querySelectorAll<HTMLButtonElement>('[data-source]').forEach(button => { const active = button.dataset.source === source; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll<HTMLButtonElement>('[data-login-method]').forEach(button => { const active = field('auth').value === 'chatgpt-' + button.dataset.loginMethod; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $('#connection-details').setAttribute('aria-labelledby', source === 'api' ? 'source-api' : 'source-login');
  $('#connection-manage-actions').hidden = !editing;
  updateReuse();
}
function openConnection(id?: string, provider?: string) {
  editing = id ? state.config.connections.find((c: any) => c.id === id) : undefined;
  const form = $<HTMLFormElement>('#connection-form'); form.reset(); reuseSnapshot = '';
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const savedKey = editing?.auth === 'api-key' && !!editing.secretRef;
  field('apiKey').placeholder = savedKey ? '••••••••（已保存，留空保留）' : '密钥加密保存在本机';
  field('apiKey').title = savedKey ? '已保存 API Key。填写新值才会替换，留空保留原密钥。' : '';
  field('apiKey').dataset.saved = String(savedKey);
  field('proxy').innerHTML = proxyOptions();
  $('#connection-dialog h2').textContent = editing ? '连接设置' : '添加连接';
  if (editing) {
    for (const name of ['name', 'provider', 'baseUrl', 'region']) field(name).value = editing[name];
    field('auth').value = editing.auth === 'chatgpt-device' && editing.loginMethod === 'browser' ? 'chatgpt-browser' : editing.auth;
    field('proxy').value = choiceValue(editing.proxy); field('modelIds').value = editing.models.map((m: any) => m.upstreamId).join('\n');
    field('protocol').value = editing.models[0]?.protocols.length === 3 ? 'all' : editing.models[0]?.protocols[0] ?? 'chat';
    $<HTMLSelectElement>('#api-auth').value = editing.auth === 'none' ? 'none' : 'api-key';
    setConnectionSource(['chatgpt-device', 'subscription'].includes(editing.auth) ? 'login' : 'api');
    $('#connection-manage-actions').innerHTML = `<label class="toggle"><input type="checkbox" name="enabled" ${editing.enabled ? 'checked' : ''} />使用此连接</label>${['chatgpt-device', 'subscription'].includes(editing.auth) ? '<button type="button" class="secondary" data-action="login" data-id="' + escape(editing.id) + '">重新登录</button>' : ''}<button type="button" class="secondary" data-action="discover" data-id="${escape(editing.id)}">同步模型</button><button type="button" class="plain danger" data-action="delete" data-id="${escape(editing.id)}">移除连接</button>`;
  } else { if (provider) field('provider').value = provider; providerChanged(); }
  renderReasoningSettings();
  $<HTMLDialogElement>('#connection-dialog').showModal(); updateReuse();
}
function providerChanged() {
  const form = $<HTMLFormElement>('#connection-form'); const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const provider = field('provider').value;
  const defaults: Record<string, [string, string]> = { openai: ['https://api.openai.com/v1', 'responses'], kimi: ['https://api.kimi.com/coding/v1', 'all'], minimax: ['https://api.minimax.io/anthropic/v1', 'messages'], anthropic: ['https://api.anthropic.com/v1', 'messages'], deepseek:['https://api.deepseek.com/v1','chat'], custom: ['', 'chat'] };
  field('baseUrl').value = defaults[provider]![0]; field('protocol').value = defaults[provider]![1];
  field('auth').value = provider === 'openai' ? 'chatgpt-browser' : ['kimi', 'minimax'].includes(provider) ? 'subscription' : 'api-key';
  $<HTMLSelectElement>('#api-auth').value = 'api-key';
  setConnectionSource(['openai', 'kimi', 'minimax'].includes(provider) ? 'login' : 'api');
  renderReasoningSettings();
}
document.addEventListener('keydown', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
  if (!target || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...target.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (buttons.indexOf(target as HTMLButtonElement) + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault(); const next = buttons[index]!; next.click();
});
document.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button'); if (!target) return;
  if (target.dataset.source) { setConnectionSource(target.dataset.source); return; }
  if (target.dataset.loginMethod) { $<HTMLSelectElement>('select[name="auth"]').value = 'chatgpt-' + target.dataset.loginMethod; setConnectionSource('login'); return; }
  if (target.dataset.close) { $<HTMLDialogElement>('#' + target.dataset.close).close(); return; }
  if (target.dataset.clientTab) { clientTab = target.dataset.clientTab; render(); document.getElementById('tab-' + clientTab)?.focus(); return; }
  const next = target.dataset.page ?? target.dataset.go;
  if (next) { page = next; document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.page === page)); render(); return; }
  const operation = target.dataset.action; const id = target.dataset.id;
  void (async () => {
    target.setAttribute('disabled', '');
    try {
      if (operation === 'open-updates') { updatePanel(); $<HTMLDialogElement>('#update-dialog').showModal(); }
      if (operation === 'update-releases') await call('update.releases');
      if (['update-check', 'update-download', 'update-install'].includes(operation ?? '')) { state.update = await call(operation === 'update-check' ? 'update.check-install' : operation!.replace('update-', 'update.')); updatePanel(); }
      if (operation === 'add-connection') openConnection(undefined, target.dataset.provider);
      if (operation === 'edit') openConnection(id);
      if (operation === 'pool-details') showPool(id!);
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
      if (operation === 'check-network') await action('network.check', { id }, 'AI 节点检测完成');
      if (operation === 'refresh-network') await action('network.refresh', { id }, '订阅已更新');
      if (operation === 'remove-network' && confirm('移除此订阅？')) await action('network.remove', { id }, '订阅已移除');
      if (operation === 'read-network-config') { const contents = await call('network.read-config'); if (contents !== null) $<HTMLTextAreaElement>('textarea[name="config"]').value = contents; }
      if (operation === 'detect-local') await action('local.detect', {}, '本机账号检测已完成');
      if (operation === 'import-local') { await action('local.import', { id }, '已复用本机账号，正在自动获取模型'); $<HTMLDialogElement>('#connection-dialog').close(); }
      if (operation === 'discover') await action('connection.discover', { id }, '模型目录已同步');
      if (operation === 'login') { $<HTMLDialogElement>('#connection-dialog').close(); await showLogin(id!); }
      if (operation === 'delete' && confirm('移除此连接及其模型？此账号的已有对话将不可继续。')) { await action('connection.delete', { id }, '连接已移除'); $<HTMLDialogElement>('#connection-dialog').close(); }
      if (operation === 'portable-config') { portableClient = id??'codex'; portableAddress = selectedAddress; $<HTMLSelectElement>('#portable-platform').value = navigator.userAgent.includes('Windows') ? 'windows' : navigator.userAgent.includes('Linux') ? 'linux' : 'macos'; $<HTMLDialogElement>('#portable-dialog').showModal(); await updatePortableConfig(); }
      if (target.dataset.portable) {
        const payload = { client: portableClient, address: portableAddress, keyId:portableKeyId };
        if (target.dataset.portable === 'export') { if (await call('client.export-portable', payload)) toast('配置包已导出'); }
        else { $('#portable-feedback').textContent = ''; await call('client.copy-portable', { ...payload, part: target.dataset.portable === 'script' ? $<HTMLSelectElement>('#portable-platform').value : target.dataset.portable }); $('#portable-feedback').textContent = target.dataset.portable === 'script' ? '执行脚本已复制，可在目标电脑粘贴运行。' : '配置已复制。'; toast('已复制，配置包含本网关访问密钥'); }
      }
      if (operation === 'use-gateway' || operation === 'use-original') {
        if (clientBusy) return;
        const client = clientTab; clientBusy = true; render();
        try {
          await action(operation === 'use-gateway' ? 'client.gateway' : 'client.original', { client }, operation === 'use-gateway' ? '已启用统一模型，可在客户端选择所有已接入模型' : '已切回原始认证');
        } finally { clientBusy = false; render(); }
      }
      if(operation==='access-copy')await action('access.copy',{id},'访问密钥已复制');
      if(operation==='access-toggle'){const key=state.accessKeys.find((k:any)=>k.id===id);await action('access.update',{id,enabled:!key.enabled},key.enabled?'密钥已停用':'密钥已启用');}
      if(operation==='access-usage'){usageFilters.clientId=id!;page='usage';document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',(b as HTMLElement).dataset.page==='usage'));await refresh();render();}
      if(operation==='access-rename'){const key=state.accessKeys.find((k:any)=>k.id===id);const name=prompt('密钥名称',key.name);if(name?.trim())await action('access.update',{id,name:name.trim()},'名称已更新');}
      if (operation === 'copy-key') await action('client.copy-key', {}, '访问密钥已复制');
      if (operation === 'copy-address') await action('client.copy-address', { protocol: id, kind: target.dataset.kind, address: selectedAddress }, '地址已复制');
      if (operation === 'export') await action('usage.export', {}, '导出操作已完成');
    } catch (error: any) { toast(error.message ?? String(error), true); } finally { target.removeAttribute('disabled'); }
  })();
});
$<HTMLSelectElement>('select[name="provider"]').onchange = providerChanged;
$<HTMLSelectElement>('#api-auth').onchange = () => setConnectionSource('api');
$<HTMLFormElement>('#connection-form').onsubmit = event => {
  event.preventDefault();
  if (connectionSaving || connectionSource === 'reuse') return;
  connectionSaving = true; $<HTMLButtonElement>('#save-connection').disabled = true;
  void (async () => {
    const form = new FormData(event.target as HTMLFormElement); const field = (name: string) => String(form.get(name) ?? '').trim();
    const id = editing?.id ?? `account-${crypto.randomUUID().slice(0, 8)}`; const loginMethod = field('auth') === 'chatgpt-browser' ? 'browser' : 'device'; const auth = field('auth').startsWith('chatgpt-') ? 'chatgpt-device' : field('auth'); const protocol = field('protocol');
    const existing = new Map((editing?.models ?? []).map((m: any) => [m.upstreamId, m]));
    const models = [...new Set(field('modelIds').split('\n').map(x => x.trim()).filter(Boolean))].map(model => ({ ...(existing.get(model) as object ?? { id: model, name: model, upstreamId: model }), protocols: auth === 'subscription' ? [field('provider') === 'minimax' ? 'messages' : 'chat'] : auth === 'chatgpt-device' ? ['responses'] : protocol === 'all' ? ['responses', 'messages', 'chat'] : [protocol] }));
    try { await action('connection.save', { connection: { ...editing, id, name: field('name'), provider: field('provider'), auth, loginMethod, region: field('region') || 'cn', enabled: editing ? form.get('enabled') === 'on' : true, baseUrl: auth === 'chatgpt-device' ? 'https://chatgpt.com/backend-api/codex' : auth === 'subscription' ? field('provider') === 'kimi' ? (field('region') === 'global' ? 'https://api.kimi.ai/coding/v1' : 'https://api.kimi.com/coding/v1') : (field('region') === 'global' ? 'https://agent.minimax.io/mavis/api/v1/llm/v1' : 'https://agent.minimax.cn/mavis/api/v1/llm/v1') : field('baseUrl'), proxy: proxyChoice(field('proxy')), reasoningModes:Object.fromEntries([...document.querySelectorAll<HTMLSelectElement>('[data-reasoning-model]')].filter(e=>e.value!=='client').map(e=>[e.dataset.reasoningModel!,e.value])), models }, apiKey: auth === 'api-key' ? field('apiKey') : undefined }, '连接已保存'); $<HTMLDialogElement>('#connection-dialog').close(); if (['chatgpt-device', 'subscription'].includes(auth) && !editing) { await showLogin(id!); } } catch { /* shown */ } finally { connectionSaving = false; $<HTMLButtonElement>('#save-connection').disabled = false; }
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
  void action('network.save', { name: field('name'), source: field('source'), url: field('url'), config: field('config') }, '订阅已保存，默认自动优选 AI 节点').then(id => {
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
$('#cancel-login').onclick = () => void action('device.cancel', { id: activeLogin }).then(() => $<HTMLDialogElement>('#login-dialog').close()).catch(() => {});
$<HTMLDialogElement>('#login-dialog').addEventListener('close', () => {
  const id = activeLogin; if (!id) return;
  const pending = loginStarting || ['starting', 'waiting'].includes(state.logins[id]?.phase);
  activeLogin = undefined; loginStarting = false; loginAttempt++;
  if (pending) void action('device.cancel', {id}).catch(() => {});
});
$<HTMLSelectElement>('#portable-address').onchange = event => { portableAddress = (event.target as HTMLSelectElement).value; void updatePortableConfig(); };
$<HTMLSelectElement>('#portable-key').onchange=event=>{portableKeyId=(event.target as HTMLSelectElement).value;void updatePortableConfig();};
document.addEventListener('change', event => {
  const input = event.target as HTMLInputElement; if (!input.matches('input[data-model-exposure]')) return;
  const enabled = input.checked; input.disabled = true;
  void action('model.exposure', {id:input.dataset.modelExposure,enabled}, enabled ? '模型已对外提供' : '模型已停止对外提供').catch(() => { input.checked = !enabled; }).finally(() => { input.disabled = false; });
});
const navIcons: Record<string, string> = {overview:'<path d="M2 10h16M10 2v16"/><circle cx="10" cy="10" r="8"/>',"connections": "<path d=\"M7 3v4m6-4v4M5 7h10v3a5 5 0 0 1-5 5v3M3 7h14\"/>", "models": "<path d=\"m10 2 8 5-8 5-8-5 8-5Zm-8 9 8 5 8-5M2 15l8 5 8-5\"/>", "clients": "<rect x=\"2\" y=\"3\" width=\"16\" height=\"14\" rx=\"2\"/><path d=\"m5 7 3 3-3 3m6 0h4\"/>", "usage": "<path d=\"M3 17V9m7 8V3m7 14v-6\"/>"};
document.querySelectorAll<HTMLButtonElement>('nav [data-page]').forEach(button => { button.querySelector('span')!.innerHTML = `<svg viewBox="0 0 20 22" aria-hidden="true">${navIcons[button.dataset.page!] ?? ''}</svg>`; });
window.modelBridge.onUpdate(update => { if (state) { state.update = update; updatePanel(); } });
void refresh(); setInterval(() => { if (!clientBusy && !connectionSaving && !document.querySelector('select:focus') && !window.getSelection()?.toString()) void refresh(); }, 4000);
export {};

document.addEventListener('submit',event=>{if((event.target as HTMLElement).id!=='access-key-form')return;event.preventDefault();const form=event.target as HTMLFormElement;const button=form.querySelector('button')!;button.disabled=true;const name=String(new FormData(form).get('keyName')??'').trim();void action('access.create',{name},'独立密钥已创建').then(id=>{portableKeyId=id;render();}).catch(()=>{}).finally(()=>{button.disabled=false;});});
