import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { SystemClock, consoleLogger } from '@opencoach/protocol';
import { openSqliteStore } from '@opencoach/store';
import { exportAthlete, importAthlete } from '@opencoach/workspace';
import { loadConfig } from './config';
import { SetupCodeManager } from './setup-code';

const [command = 'serve', ...args] = process.argv.slice(2);
if (command === 'serve') await import('./main');
else if (['setup-code', 'export', 'import'].includes(command)) {
  const config = loadConfig();
  const clock = new SystemClock();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const store = await openSqliteStore({ path: join(config.dataDir, 'system.db'), clock });
  try {
    if (command === 'setup-code') {
      if (await store.hasAnyAthlete()) throw new Error('Setup is complete. Create an invite or pairing code through the authenticated app.');
      await new SetupCodeManager({ store, clock, dataDir: config.dataDir, publicUrl: config.publicUrl, logger: consoleLogger() }).issue();
    } else if (command === 'export') {
      if (!args[0]) throw new Error('Usage: opencoach export <athlete-id>');
      console.log(await exportAthlete({ dataDir: config.dataDir, athleteId: args[0], store, clock }));
    } else {
      if (!args[0]) throw new Error('Usage: opencoach import <bundle.tar.gz> [new-athlete-id]');
      const result = await importAthlete({ dataDir: config.dataDir, bundlePath: resolve(args[0]), newAthleteId: args[1], store, clock });
      console.log(JSON.stringify(result));
    }
  } finally { await store.close(); }
} else {
  console.error('Usage: opencoach [serve | setup-code | export <athlete-id> | import <bundle.tar.gz> [new-athlete-id]]');
  process.exitCode = command === '--help' || command === '-h' ? 0 : 1;
}
