/**
 * `pnpm --filter @opencoach/web dev:mock`: the mock gateway (+ views origin) and the Vite dev server with its
 * /v1, /admin and WebSocket proxy pointed at the mock.
 */
import { createServer } from 'vite';
import { startMockServer } from './mock-server';

const mock = await startMockServer({
  port: Number(process.env.MOCK_PORT ?? 8787),
  viewsPort: Number(process.env.MOCK_VIEWS_PORT ?? 8788),
  seedHistory: Number(process.env.MOCK_SEED_HISTORY ?? 0),
});
process.env.OPENCOACH_GATEWAY = mock.url;

const vite = await createServer({ root: new URL('..', import.meta.url).pathname, server: { port: Number(process.env.PORT ?? 5173) } });
await vite.listen();
vite.printUrls();
console.log(`\n  Mock gateway   ${mock.url}\n  Views origin   ${mock.viewsUrl}\n  Setup code     ${mock.setupCode}\n`);

const stop = async () => {
  await vite.close();
  await mock.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
