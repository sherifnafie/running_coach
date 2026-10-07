import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfigDetailed, ConfigError } from '../src/config';
import { CompatibleProviderConfig } from '@opencoach/protocol';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function configFile(text: string) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-config-')); dirs.push(dir);
  const path = join(dir, 'config.yaml'); await writeFile(path, text);
  return { dir, path };
}

describe('OpenCode GO compatible configuration [RT-7] [SEC-1]', () => {
  it('materializes the environment credential and preserves explicit tiers/transport headers without persisting it', async () => {
    const source = await readFile(resolve('opencoach.config.opencode-go.example.yaml'), 'utf8');
    const { path, dir } = await configFile(source);
    const syntheticKey = 'synthetic-test-credential-no-live-access';
    const loaded = loadConfigDetailed({ path, cwd: dir, env: { OPENCODE_GO_API_KEY: syntheticKey } });
    expect(loaded.config.demo).toBe(false);
    expect(loaded.config.providers.compatible[0]).toMatchObject({ id: 'opencode-go', apiKeyEnv: 'OPENCODE_GO_API_KEY', apiKey: syntheticKey, baseUrl: 'https://opencode.ai/zen/go/v1', headers: { 'User-Agent': 'OpenCoach/0.1.0' }, sessionHeader: 'x-opencode-session', replayReasoningContent: true, thinking: true, reasoningEfforts: ['low', 'high', 'max'], maxOutputTokens: 16384, vision: false });
    expect(loaded.config.models?.tiers.coach).toEqual({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', effort: 'low' });
    expect(loaded.config.models?.tiers.fast?.model).toBe('deepseek-v4.1-flash');
    expect(await readFile(path, 'utf8')).not.toContain(syntheticKey);
    expect(JSON.stringify(loaded.warnings)).not.toContain(syntheticKey);
  });

  it('only an OpenRouter key selects default tiers; GO or OpenAI (voice) keys alone leave the demo on', async () => {
    const { dir } = await configFile('');
    const demo = loadConfigDetailed({ cwd: dir, env: { OPENCODE_GO_API_KEY: 'synthetic-test-credential', OPENAI_API_KEY: 'synthetic-openai-credential' } });
    expect(demo.config.demo).toBe(true);
    const openrouter = loadConfigDetailed({ cwd: dir, env: { OPENROUTER_API_KEY: 'sk-or-synthetic-credential' } });
    expect(openrouter.config.demo).toBe(false);
    expect(openrouter.config.providers.openrouter?.apiKey).toBe('sk-or-synthetic-credential');
    expect(openrouter.config.providers.openrouter?.routing).toMatchObject({ dataCollection: 'deny', requireParameters: true });
    expect(openrouter.config.models?.tiers).toEqual({
      coach: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
      deep: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', effort: 'high' },
      fast: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', effort: 'low' },
    });
    const custom = await configFile('providers:\n  openrouter:\n    apiKeyEnv: MY_ROUTER_KEY\n    defaultModel: z-ai/glm-5.3-flash\n');
    const renamed = loadConfigDetailed({ cwd: custom.dir, path: custom.path, env: { MY_ROUTER_KEY: 'sk-or-synthetic-other' } });
    expect(renamed.config.models?.tiers.coach.model).toBe('z-ai/glm-5.3-flash');
  });

  it('rejects malformed headers and excludes credential/header values from configuration diagnostics', async () => {
    expect(CompatibleProviderConfig.safeParse({ id: 'x', baseUrl: 'https://example.com', sessionHeader: 'bad\nheader' }).success).toBe(false);
    expect(CompatibleProviderConfig.safeParse({ id: 'x', baseUrl: 'https://example.com', headers: { 'User-Agent': 'bad\r\nheader' } }).success).toBe(false);
    const secret = 'synthetic-private-header-value';
    const { path, dir } = await configFile(`publicUrl: ${secret}\nproviders:\n  compatible:\n    - id: x\n      baseUrl: https://example.com\n      headers:\n        Authorization: ${secret}\n`);
    let failure: unknown;
    try { loadConfigDetailed({ path, cwd: dir, env: {} }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as Error).message).not.toContain(secret);
    const malformed = await configFile(`providers: [\nAuthorization: ${secret}\n`);
    try { loadConfigDetailed({ path: malformed.path, cwd: malformed.dir, env: { OPENCODE_GO_API_KEY: secret } }); } catch (error) {
      expect((error as Error).message).toContain('Invalid YAML');
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
