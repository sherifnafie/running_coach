import { translate } from '@opencoach/protocol';
import { appStore } from './appState';
import { shellLabels } from './labels';
import { useStore } from './store';
export function useI18n(): (text: string) => string {
  const locale = useStore(appStore, (s) => s.me?.settings.profile.locale ?? navigator.language ?? 'en');
  // Re-render when a generated label pack arrives for a language without a curated table.
  useStore(appStore, (s) => s.labelsVersion);
  return (text) => translate(text, locale, shellLabels);
}
/** For notices outside React; components use useI18n to follow changes. */
export function t(text: string): string {
  return translate(text, appStore.getState().me?.settings.profile.locale ?? navigator.language ?? 'en', shellLabels);
}
