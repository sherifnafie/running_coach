import { composeServer } from './compose';

const server = await composeServer();
await server.listen();
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try { await server.close(); }
  catch (error) { server.logger.error('shutdown failed', { error: (error as Error).message }); process.exitCode = 1; }
};
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
