import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pairingCode, type Clock, type Logger, type Store } from '@opencoach/protocol';

const SETUP_TTL_MS = 24 * 3600 * 1000;

export interface IssuedCode {
  code: string;
  expiresAt: string;
}

/** Create a first-run setup code (purpose "setup", 24 h). */
export async function issueSetupCode(store: Store, clock: Clock): Promise<IssuedCode> {
  const code = pairingCode();
  const expiresAt = new Date(clock.now().getTime() + SETUP_TTL_MS).toISOString();
  await store.createPairingCode({ code, purpose: 'setup', expiresAt });
  return { code, expiresAt };
}

export function setupCodePath(dataDir: string): string {
  return join(dataDir, 'setup-code.txt');
}

export function formatSetupBanner(opts: { code: string; publicUrl: string; file?: string }): string {
  const lines = [
    'OpenCoach first-run setup',
    '',
    `Open:        ${opts.publicUrl}`,
    `Setup code:  ${opts.code}   (valid for 24 hours)`,
    ...(opts.file ? [`Also saved to ${opts.file}`] : []),
    '',
    'Anyone with this code can create the administrator account. Keep it private.',
  ];
  const width = Math.max(...lines.map((l) => l.length));
  const bar = `+${'-'.repeat(width + 4)}+`;
  return ['', bar, ...lines.map((l) => `|  ${l.padEnd(width)}  |`), bar, ''].join('\n');
}

/**
 * First run: while no athlete exists, a setup code is generated at every start, printed prominently and written
 * to <dataDir>/setup-code.txt (0600). Once an athlete exists the file is removed.
 */
export class SetupCodeManager {
  constructor(
    private deps: {
      store: Store;
      clock: Clock;
      dataDir: string;
      logger: Logger;
      publicUrl: string;
      print?: (text: string) => void;
    },
  ) {}

  async issue(): Promise<IssuedCode> {
    const { store, clock, dataDir, publicUrl, logger } = this.deps;
    const issued = await issueSetupCode(store, clock);
    const file = setupCodePath(dataDir);
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(file, `${issued.code}\n`, { mode: 0o600 });
      await chmod(file, 0o600);
    } catch (e) {
      logger.warn('could not write setup-code.txt', { error: (e as Error).message });
    }
    (this.deps.print ?? ((t: string) => console.log(t)))(formatSetupBanner({ code: issued.code, publicUrl, file }));
    logger.info('setup code issued', { expiresAt: issued.expiresAt });
    return issued;
  }

  /** Issue a code if setup is still pending; otherwise clean up the file. */
  async ensure(): Promise<IssuedCode | undefined> {
    const { store, dataDir } = this.deps;
    if (await store.hasAnyAthlete()) {
      await rm(setupCodePath(dataDir), { force: true });
      return undefined;
    }
    return this.issue();
  }
}
