import { COACH_TOOLS, SpawnLimits, type AthleteSettings, type ResolvedModel, type Tier, type ToolName } from '@opencoach/protocol';
import type { Core } from './core';
import { imageProviderFor } from './identity';

/**
 * Tools whose backing service this deployment doesn't have. They are left out of the model's tool list rather than
 * offered and refused on every call.
 */
export function unavailableTools(core: Core, athleteId: string): Set<ToolName> {
  const out = new Set<ToolName>();
  if (!core.deps.webSearch) out.add('web_search');
  if (!core.config.web.fetch.enabled) out.add('web_fetch');
  if (!core.weather) out.add('weather');
  if (!core.deps.renderer) {
    out.add('preview_ui');
    out.add('publish_ui');
  }
  if (!imageProviderFor(core, athleteId)) out.add('generate_image');
  return out;
}

/** Configuration facts, not a claim that an external service has passed a live health check. */
export function capabilityLines(core: Core, athleteId: string, settings: AthleteSettings, model: ResolvedModel, tools: ToolName[], imageSpendUsd?: number): string[] {
  const tiers = (['fast', 'coach', 'deep'] as Tier[]).map((tier) => {
    try {
      const route = core.deps.router.route(tier, settings.models[tier] ?? undefined, { athleteId });
      return { tier, model: route[0] };
    } catch {
      return { tier, model: undefined };
    }
  });
  const visionTiers = tiers.filter((t) => t.model?.capabilities.vision).map((t) => t.tier);
  const imageProvider = imageProviderFor(core, athleteId);
  const missing = [...unavailableTools(core, athleteId)].filter((t) => COACH_TOOLS.includes(t));
  const identity = settings.coachIdentity.allowChanges ? 'athlete allows name/avatar changes in chat turns they ask for' : 'name/avatar changes NOT ENABLED by the athlete';
  return [
    'OpenCoach capability guide: /system/docs/opencoach.md',
    `tools: ${tools.join(', ') || 'none'}${missing.length ? ` · not available on this server: ${missing.join(', ')}` : ''}`,
    ...(tools.includes('weather') ? ['weather: town-level forecast, hourly detail, air quality (pass a town, never an address)'] : []),
    ...(tools.includes('web_fetch') ? ['web_fetch: public pages only'] : []),
    `images: current model ${model.capabilities.vision ? 'has vision' : 'TEXT ONLY'} · image-capable helper tier(s): ${visionTiers.join(', ') || 'NONE — do not claim image extraction or visual inspection'}`,
    `image generation: ${imageProvider ? `${imageProvider.model}, one 512px square PNG, permission ${settings.images.mode}, ${imageSpendUsd !== undefined ? `$${imageSpendUsd.toFixed(3)} of ` : ''}$${settings.images.monthlyUsd.toFixed(2)} this month` : 'not configured'} · ${identity} · skills: image-generation, coach-identity`,
    ...(tools.includes('preview_ui') ? ['UI: preview_ui renders and checks views; only publish_ui changes what the athlete sees'] : []),
    `configured model tiers: ${tiers.map((t) => `${t.tier}=${t.model ? `${t.model.model} (${t.model.provider.id}; effort: ${t.model.capabilities.efforts.join(', ') || 'not supported'})` : 'unavailable'}`).join('; ')}; different tier names may use the same model`,
    ...(tools.includes('spawn_agent') ? [`helpers: depth limit ${SpawnLimits.maxDepth}, concurrency limit ${SpawnLimits.maxConcurrentPerAthlete}; ${core.config.limits.helperMaxSteps} steps / ${core.config.limits.helperMaxWallMs / 1000}s each; reactive head turn ${core.config.limits.reactiveMaxWallMs / 1000}s; foreground helpers share the head turn's remaining time`] : []),
  ];
}
