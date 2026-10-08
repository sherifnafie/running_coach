import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedView } from '@opencoach/protocol';
import { patchApp } from '../lib/appState';
import { clearUpdated } from '../lib/controller';
import { ViewScreen } from './ViewScreen';

vi.mock('../components/ViewFrame', () => ({ ViewFrame: () => null }));
vi.mock('../lib/controller', () => ({ clearUpdated: vi.fn() }));
vi.mock('../lib/router', () => ({ navigate: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); patchApp({ updated: { today: { version: '2', summary: 'A clearer session layout.' } } }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('view update notice [UI-1]', () => {
  it('keeps the notice while keyboard focus remains, including after the pointer leaves', () => {
    const view = { manifest: { id: 'today', title: 'Today' }, version: '2', url: 'https://views.test/today' } as PublishedView;
    render(<ViewScreen view={view} params={{}} active />);
    const notice = screen.getByRole('status', { name: 'View updated' });
    const history = screen.getByRole('button', { name: 'View history' });
    fireEvent.focus(history);
    fireEvent.pointerEnter(notice);
    fireEvent.pointerLeave(notice);
    act(() => { vi.advanceTimersByTime(21_000); });
    expect(clearUpdated).not.toHaveBeenCalled();
    fireEvent.blur(history, { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(clearUpdated).toHaveBeenCalledExactlyOnceWith('today');
  });
});
