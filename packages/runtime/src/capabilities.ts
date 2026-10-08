import { SpawnLimits, type AthleteSettings, type ResolvedModel, type Tier, type ToolName } from '@opencoach/protocol';
import type { Core } from './core';
import { imageProviderFor } from './identity';

/** Configuration facts, not a claim that an external service has passed a live health check. */
export function capabilityLines(core: Core, athleteId: string, settings: AthleteSettings, model: ResolvedModel, tools: ToolName[]): string[] {
  const tiers = (['fast', 'coach', 'deep'] as Tier[]).map((tier) => {
    try {
      const route = core.deps.router.route(tier, settings.models[tier], { athleteId });
      return { tier, model: route[0] };
    } catch {
      return { tier, model: undefined };
    }
  });
  const visionTiers = tiers.filter((t) => t.model?.capabilities.vision).map((t) => t.tier);
  const imageProvider = imageProviderFor(core, athleteId);
  return [
    'OpenCoach capability guide: /system/docs/opencoach.md · research skill: /system/skills/research/SKILL.md',
    `core tools granted: ${tools.join(', ') || 'none'}; services below describe configuration, not live availability`,
    `weather: ${!tools.includes('weather') ? 'not granted' : core.weather ? 'available (town-level forecast, hourly detail, air quality; use a town, never an address)' : 'NOT CONFIGURED'}`,
    `research: web_search ${!tools.includes('web_search') ? 'not granted' : core.deps.webSearch ? 'configured' : 'NOT CONFIGURED'} · web_fetch ${!tools.includes('web_fetch') ? 'not granted' : core.config.web.fetch.enabled ? 'enabled (public pages only)' : 'DISABLED'}`,
    `images: current model ${model.capabilities.vision ? 'has vision' : 'TEXT ONLY'} · image-capable helper tier(s): ${visionTiers.join(', ') || 'NONE — do not claim image extraction or visual inspection'}`,
    `image generation: ${imageProvider ? `configured (${imageProvider.id}, ${imageProvider.model}); independent of chat vision` : 'NOT CONFIGURED for this athlete'} · permission ${settings.images.mode} · image allowance $${settings.images.monthlyUsd}/month inside total AI budgets · one square 512px PNG, fixed model/request parameters${core.config.imageGeneration?.provider === 'openrouter' ? `, quality ${core.config.imageGeneration.quality}` : ''} · default pixel-art style · skill: /system/skills/image-generation/SKILL.md`,
    `coach identity changes ${settings.coachIdentity.allowChanges ? 'athlete-enabled; requested chat turns only, including athlete input received while working' : 'NOT ENABLED by athlete'} · image permission is separate · successful set_preferences updates the displayed name/avatar · skill: /system/skills/coach-identity/SKILL.md`,
    `UI checks: ${!tools.includes('preview_ui') ? 'preview_ui not granted' : core.deps.renderer ? 'renderer configured; inspect the returned gate report' : 'renderer NOT CONFIGURED; preview/publication unavailable'} · ${tools.includes('publish_ui') ? 'only publish_ui changes the live views' : 'publish_ui not granted'}`,
    `configured model tiers: ${tiers.map((t) => `${t.tier}=${t.model ? `${t.model.model} (${t.model.provider.id}; effort: ${t.model.capabilities.efforts.join(', ') || 'not supported'})` : 'unavailable'}`).join('; ')}; different tier names may use the same model`,
    ...(tools.includes('spawn_agent') ? [`helpers: depth limit ${SpawnLimits.maxDepth}, concurrency limit ${SpawnLimits.maxConcurrentPerAthlete}; ${core.config.limits.helperMaxSteps} steps / ${core.config.limits.helperMaxWallMs / 1000}s each; reactive head turn ${core.config.limits.reactiveMaxWallMs / 1000}s. Foreground work shares the head's remaining time; use background:true for longer tasks. Brief explicitly, grant required tools and a write scope, verify outputs`] : []),
  ];
}
