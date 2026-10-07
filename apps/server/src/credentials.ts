import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock, CredentialRecord, Logger, Store } from '@opencoach/protocol';

/**
 * Per-athlete provider keys [SEC-1]. Keys are encrypted at rest (AES-256-GCM, bound to athlete and provider) with a
 * server secret in <dataDir>/secrets/credentials.key, kept decrypted only in this trusted process, never returned to
 * clients (only a masked hint), never passed to sandboxes and left out of exports. Deleting an account deletes them.
 */
export type CredentialProvider = CredentialRecord['provider'];
export type CredentialOwner = CredentialRecord['owner'];
export interface CredentialSummary { owner: CredentialOwner; hint: string; updatedAt: string }

const VERSION = 'v1';

export class CredentialVault {
  private constructor(private readonly key: Buffer) {}

  static async open(dataDir: string): Promise<CredentialVault> {
    const dir = join(dataDir, 'secrets');
    const file = join(dir, 'credentials.key');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let raw = await readFile(file, 'utf8').catch(() => undefined);
    if (!raw) {
      raw = randomBytes(32).toString('base64');
      await writeFile(file, raw, { mode: 0o600, flag: 'wx' }).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
        raw = await readFile(file, 'utf8');
      });
    }
    await chmod(file, 0o600);
    const key = Buffer.from(raw.trim(), 'base64');
    if (key.length !== 32) throw new Error(`${file} must hold a base64-encoded 32-byte key`);
    return new CredentialVault(key);
  }

  static fromKey(key: Buffer): CredentialVault {
    return new CredentialVault(key);
  }

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
  }

  decrypt(sealed: string, aad: string): string {
    const [version, iv, tag, body] = sealed.split(':');
    if (version !== VERSION || !iv || !tag || body === undefined) throw new Error('unsupported credential format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** Masked display form: the prefix and the last four characters. */
export function keyHint(key: string): string {
  const prefix = key.match(/^[a-z]+-[a-z0-9]+-/i)?.[0] ?? key.slice(0, 3);
  return `${prefix}…${key.slice(-4)}`;
}

/** Short stable fingerprint, for caching provider clients per key without keeping the key as a map key. */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export class CredentialService {
  private readonly keys = new Map<string, { key: string; owner: CredentialOwner; hint: string; updatedAt: string }>();

  constructor(private readonly deps: { store: Store; vault: CredentialVault; clock: Clock; logger: Logger }) {}

  private static id(athleteId: string, provider: CredentialProvider): string {
    return `${athleteId}:${provider}`;
  }

  /** Decrypt every stored key into memory. Unreadable entries are logged and skipped, never fatal. */
  async load(): Promise<void> {
    this.keys.clear();
    for (const rec of await this.deps.store.listCredentials()) {
      const id = CredentialService.id(rec.athleteId, rec.provider);
      try {
        this.keys.set(id, { key: this.deps.vault.decrypt(rec.ciphertext, id), owner: rec.owner, hint: rec.hint, updatedAt: rec.updatedAt });
      } catch (error) {
        this.deps.logger.error('stored credential could not be decrypted; ignoring it', { athleteId: rec.athleteId, provider: rec.provider, error: (error as Error).message });
      }
    }
  }

  key(athleteId: string, provider: CredentialProvider): string | undefined {
    return this.keys.get(CredentialService.id(athleteId, provider))?.key;
  }

  summary(athleteId: string, provider: CredentialProvider): CredentialSummary | undefined {
    const entry = this.keys.get(CredentialService.id(athleteId, provider));
    return entry && { owner: entry.owner, hint: entry.hint, updatedAt: entry.updatedAt };
  }

  /** `byok` when the athlete supplied their own OpenRouter key; otherwise the deployment (or an admin) pays. */
  billing(athleteId: string): 'managed' | 'byok' {
    return this.summary(athleteId, 'openrouter')?.owner === 'athlete' ? 'byok' : 'managed';
  }

  async set(athleteId: string, provider: CredentialProvider, key: string, owner: CredentialOwner): Promise<CredentialSummary> {
    const id = CredentialService.id(athleteId, provider);
    const updatedAt = this.deps.clock.now().toISOString();
    const hint = keyHint(key);
    await this.deps.store.setCredential({ athleteId, provider, owner, ciphertext: this.deps.vault.encrypt(key, id), hint, updatedAt });
    this.keys.set(id, { key, owner, hint, updatedAt });
    return { owner, hint, updatedAt };
  }

  async clear(athleteId: string, provider: CredentialProvider): Promise<void> {
    await this.deps.store.deleteCredential(athleteId, provider);
    this.keys.delete(CredentialService.id(athleteId, provider));
  }

  /** Drop cached keys for a deleted account (the store rows go with the account). */
  forget(athleteId: string): void {
    for (const id of [...this.keys.keys()]) if (id.startsWith(`${athleteId}:`)) this.keys.delete(id);
  }
}

/**
 * Check an OpenRouter key before storing it: GET /key answers 200 for a usable key. Returns the remaining credit
 * limit when the key has one. Throws with a message fit for the athlete.
 */
export async function verifyOpenRouterKey(key: string, opts: { baseUrl: string; fetch?: typeof fetch; signal?: AbortSignal }): Promise<{ limitRemaining?: number | null }> {
  if (!/^sk-or-[A-Za-z0-9_-]{16,}$/.test(key)) throw new Error('That does not look like an OpenRouter key (it starts with "sk-or-").');
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${opts.baseUrl.replace(/\/+$/, '')}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: opts.signal ?? AbortSignal.timeout(15_000) });
  } catch {
    throw new Error('Could not reach OpenRouter to check the key. Try again in a moment.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('OpenRouter rejected this key.');
  if (!res.ok) throw new Error(`OpenRouter could not check the key (HTTP ${res.status}).`);
  const body = (await res.json().catch(() => ({}))) as { data?: { limit_remaining?: number | null } };
  return { limitRemaining: body.data?.limit_remaining };
}

/** RFC 7636 PKCE pair (S256) for the OpenRouter OAuth flow. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
