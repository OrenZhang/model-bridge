export function connectionState(connection: any, login?: any, discovery?: any, check?: any) {
  if (!connection.enabled) return { tone: 'neutral', label: '已停用' };
  if (['starting', 'waiting'].includes(login?.phase)) return { tone: 'pending', label: '授权中' };
  if (discovery?.phase === 'loading') return { tone: 'pending', label: '同步中' };
  if (check?.phase === 'error') return {tone:'error',label:'调用失败',detail:check.message};
  if (check?.phase === 'ready') return {tone:'success',label:'调用成功'};
  if (login?.phase === 'error') return { tone: 'error', label: '需重新登录', detail: login.error };
  if (discovery?.phase === 'error') return { tone: 'error', label: '同步失败', detail: discovery.message };
  if (['chatgpt-device', 'subscription'].includes(connection.auth)) {
    if (login?.phase === 'authenticated' || connection.accountId || connection.credentialVersion) return { tone: 'success', label: '已连接' };
    return { tone: 'neutral', label: '待登录' };
  }
  if (discovery?.phase === 'ready') return { tone: 'success', label: '已连接' };
  return connection.models.length ? { tone: 'success', label: '已配置', detail: '已配置模型；调用权限以服务商返回结果为准。' } : { tone: 'neutral', label: '待检测' };
}
