import { SpawnLimits, type AthleteSettings, type ResolvedModel, type Tier, type ToolName } from '@opencoach/protocol';
import type { Core } from './core';

/** Configuration facts, not a claim that an external service has passed a live health check. */
export function capabilityLines(core: Core, settings: AthleteSettings, model: ResolvedModel, tools: ToolName[]): string[] {
  const tiers = (['fast', 'coach', 'deep'] as Tier[]).map((tier) => {
    try {
      const route = core.deps.router.route(tier, settings.models[tier]);
      return { tier, model: route[0] };
    } catch {
      return { tier, model: undefined };
    }
  });
  const visionTiers = tiers.filter((t) => t.model?.capabilities.vision).map((t) => t.tier);
  return [
    'OpenCoach capability guide: /system/docs/opencoach.md · research skill: /system/skills/research/SKILL.md',
    `core tools granted: ${tools.join(', ') || 'none'}; services below describe configuration, not live availability`,
    `research: web_search ${!tools.includes('web_search') ? 'not granted' : core.deps.webSearch ? 'configured' : 'NOT CONFIGURED'} · web_fetch ${!tools.includes('web_fetch') ? 'not granted' : core.config.web.fetch.enabled ? 'enabled (public pages only)' : 'DISABLED'}`,
    `images: current model ${model.capabilities.vision ? 'has vision' : 'TEXT ONLY'} · image-capable helper tier(s): ${visionTiers.join(', ') || 'NONE — do not claim image extraction or visual inspection'}`,
    `optional image generation: ${core.deps.imageProvider ? `configured (${core.deps.imageProvider.id}, ${core.deps.imageProvider.model}); independent of chat vision` : 'NOT CONFIGURED; a text-model key alone does not enable it'} · coach identity changes ${settings.coachIdentity.allowChanges ? 'athlete-enabled; only act on a current request' : 'NOT ENABLED by athlete'} · skill: /system/skills/coach-identity/SKILL.md`,
    `UI checks: ${!tools.includes('preview_ui') ? 'preview_ui not granted' : core.deps.renderer ? 'renderer configured; inspect the returned gate report' : 'renderer NOT CONFIGURED; preview/publication unavailable'} · ${tools.includes('publish_ui') ? 'only publish_ui changes the live views' : 'publish_ui not granted'}`,
    `configured model tiers: ${tiers.map((t) => `${t.tier}=${t.model ? `${t.model.model} (${t.model.provider.id}; effort: ${t.model.capabilities.efforts.join(', ') || 'not supported'})` : 'unavailable'}`).join('; ')}; different tier names may use the same model`,
    ...(tools.includes('spawn_agent') ? [`helpers: depth limit ${SpawnLimits.maxDepth}, concurrency limit ${SpawnLimits.maxConcurrentPerAthlete}; ${core.config.limits.helperMaxSteps} steps / ${core.config.limits.helperMaxWallMs / 1000}s each; reactive head turn ${core.config.limits.reactiveMaxWallMs / 1000}s. Foreground work shares the head's remaining time; use background:true for longer tasks. Brief explicitly, grant required tools and a write scope, verify outputs`] : []),
  ];
}
