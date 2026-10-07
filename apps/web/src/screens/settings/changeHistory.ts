import type { ChangeEntry } from '@opencoach/protocol';

/** [WS-4] Describe saved files without implying a draft screen or plan is already live. */
export function changePresentation(change: ChangeEntry, t: (label: string) => string) {
  const areas = [...new Set(change.files.map((file) => {
    const path = file.replace(/^\.\//, '');
    if (path.startsWith('ui/')) return 'Screen files';
    if (path.startsWith('data/')) return 'Training data';
    if (path === 'plan/current.md' || /^(athlete|memory)\//.test(path) || /^(AGENTS|HEARTBEAT|briefing)\.md$/.test(path)) return 'Coach notes';
    if (path.startsWith('plan/')) return 'Plan files';
    if (path.startsWith('research/')) return 'Research';
    if (path === 'exports/calendar.ics') return 'Calendar export';
    return 'Coach workspace';
  }))].map(t);

  let title: string;
  switch (change.kind) {
    case 'seed': title = t('Your coach was set up'); break;
    case 'revert': title = t('Earlier screen restored'); break;
    case 'publish': title = change.summary.replace(/^publish:\s*/, '').trim() || t('Screens published'); break;
    case 'external': title = t('Workspace edited outside the coach'); break;
    default:
      title = change.summary === 'nightly: database dump'
        ? t('Training data backed up')
        : /^Updated |^Coach turn$/.test(change.summary) ? t('Coach saved changes') : change.summary;
  }
  return { title, areas };
}
