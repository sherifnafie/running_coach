import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { navigate } from '../../lib/router';
import { ViewUpdateMessage } from './Bubbles';

vi.mock('../../lib/controller', () => ({ discardPending: vi.fn(), react: vi.fn(), retryPending: vi.fn() }));
vi.mock('../../lib/router', () => ({ navigate: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('[UI-1] keeps one quiet disclosure, deduplicates summaries and retains screen/history links', () => {
  const summary = 'Added a **Log** for sessions.';
  const views = ['Log', 'Calendar', 'Today', 'Plan', 'Progress'].map(title => ({ title, viewId: title.toLowerCase(), summary }));
  const { container } = render(<ViewUpdateMessage views={views} />);
  const details = container.querySelector('details')!;
  const header = details.querySelector('summary')!;
  expect(details.open).toBe(false);
  expect(header.textContent).toBe('Log, Calendar +3Updated');
  expect(container.querySelectorAll('.md')).toHaveLength(1);
  expect(container.querySelector('.md strong')?.textContent).toBe('Log');
  fireEvent.click(header);
  expect(details.open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
  expect(navigate).toHaveBeenCalledWith({ name: 'view', viewId: 'calendar', params: {} });
  fireEvent.click(screen.getByRole('button', { name: 'View history' }));
  expect(navigate).toHaveBeenCalledWith({ name: 'settings', section: 'history' });
});

it('[UI-1] retains distinct summaries when the coach makes multiple edits in one batch', () => {
  const { container } = render(<ViewUpdateMessage views={[
    { viewId: 'today', title: 'Today', summary: 'Added a log field.' },
    { viewId: 'calendar', title: 'Calendar', summary: 'Calendar opens in week view.' },
  ]} />);
  expect(container.querySelectorAll('.md')).toHaveLength(2);
});
