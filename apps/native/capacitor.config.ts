import type { CapacitorConfig } from '@capacitor/cli';

/**
 * OpenCoach native shell (SPEC §14, Phase 2). The shell loads the PWA from YOUR server so the same
 * coach-authored views and API work unchanged; native plugins (Health Connect, push) are bridged in.
 *
 * Build with your server's public URL, e.g.:
 *   OPENCOACH_SERVER_URL=https://coach.example.ts.net pnpm --filter @opencoach/native sync
 */
const serverUrl = process.env.OPENCOACH_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'org.opencoach.app',
  appName: 'OpenCoach',
  webDir: 'www',
  server: serverUrl
    ? { url: serverUrl, cleartext: serverUrl.startsWith('http://'), androidScheme: 'https' }
    : { androidScheme: 'https' },
  android: { allowMixedContent: false },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
