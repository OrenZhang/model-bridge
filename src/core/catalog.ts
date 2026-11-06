import { publicModelRoutes } from './model-pool.js';
import { type Config } from './config.js';

const instructions = 'You are a coding assistant. Follow the user and developer instructions. Inspect relevant files before changing them. Use the provided tools and report results accurately.';
export function models(config: Config) {
  return publicModelRoutes(config);
}
export function managedModels(config: Config) {
  const all = structuredClone(config);
  all.hiddenModels = [];
  for (const connection of all.connections) { connection.enabled = true; for (const model of connection.models) model.enabled = true; }
  return publicModelRoutes(all).map(entry => {
    // Include duplicate account imports too: hiding a model must hide every route.
    const members = config.connections.flatMap(connection => connection.models.filter(model => model.upstreamId === entry.id).map(model => ({connection, model})));
    const hidden = config.hiddenModels.includes(entry.id);
    return { ...entry, members, enabled: !hidden && members.every(m => m.model.enabled), mixed: !hidden && members.some(m => m.model.enabled) && members.some(m => !m.model.enabled), exposedAccounts: hidden ? 0 : members.filter(m => m.connection.enabled && m.model.enabled).length };
  });
}
export function openaiCatalog(config: Config) {
  return { object: 'list', data: models(config).map(({ connection, model, id, displayName }) => ({ id, object: 'model', created: 0, owned_by: connection.provider, display_name: displayName })) };
}
export function codexCatalog(config: Config) {
  return { models: models(config).filter(({ model }) => model.tools).map(({ connection, model, id, displayName }, priority) => ({
    slug: id, display_name: displayName, description: `Via ${connection.name}`,
    default_reasoning_level: model.reasoning[0] ?? null,
    supported_reasoning_levels: model.reasoning.map(effort => ({ effort, description: effort })),
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority,
    additional_speed_tiers: [], service_tiers: [], default_service_tier: null,
    availability_nux: null, upgrade: null, base_instructions: instructions,
    supports_reasoning_summaries: false, default_reasoning_summary: 'none',
    support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: 10000 }, supports_parallel_tool_calls: true,
    context_window: model.contextWindow, max_context_window: model.contextWindow,
    effective_context_window_percent: 95, experimental_supported_tools: [],
    input_modalities: model.images ? ['text', 'image'] : ['text'],
    supports_search_tool: false, supports_image_detail_original: false,
  })) };
}
export function anthropicCatalog(config: Config) {
  const data = models(config).map(({ connection, model, id, displayName }) => ({ id, type: 'model', display_name: displayName, created_at: '1970-01-01T00:00:00Z' }));
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}
