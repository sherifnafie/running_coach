import type { AppInfo, PublishedView } from '@opencoach/protocol';
import type { Route } from './router';

/**
 * Bottom navigation (SPEC §9.1, [UI-2], Appendix C §C.4): Chat is always first and cannot be removed, Settings is
 * always last; the coach's views sit in between, overflowing into "More" when they do not fit in five slots.
 */
export interface NavItem {
  key: string;
  label: string;
  icon: string;
  route?: Route;
  /** The "More" entry opens a menu with `overflow`. */
  more?: boolean;
}

export const MAX_SLOTS = 5;

export function navViews(app: AppInfo | undefined): PublishedView[] {
  if (!app) return [];
  const byId = new Map(app.views.map((v) => [v.manifest.id, v]));
  const seen = new Set<string>();
  const out: PublishedView[] = [];
  for (const id of app.app.nav ?? []) {
    const v = byId.get(id);
    if (v && !seen.has(id)) {
      seen.add(id);
      out.push(v);
    }
  }
  return out;
}

const viewItem = (v: PublishedView): NavItem => ({
  key: `view:${v.manifest.id}`,
  label: v.manifest.title,
  icon: v.manifest.icon,
  route: { name: 'view', viewId: v.manifest.id, params: {} },
});

export function computeNav(app: AppInfo | undefined): { slots: NavItem[]; overflow: NavItem[] } {
  const chat: NavItem = { key: 'chat', label: 'Chat', icon: 'chat', route: { name: 'chat' } };
  const settings: NavItem = { key: 'settings', label: 'Settings', icon: 'settings', route: { name: 'settings' } };
  const views = navViews(app).map(viewItem);
  const room = MAX_SLOTS - 2; // chat + settings are fixed
  if (views.length <= room) return { slots: [chat, ...views, settings], overflow: [] };
  const shown = views.slice(0, room - 1);
  const overflow = views.slice(room - 1);
  return { slots: [chat, ...shown, { key: 'more', label: 'More', icon: 'more', more: true }, settings], overflow };
}

export function isActive(item: NavItem, route: Route, overflow: NavItem[] = []): boolean {
  if (item.more) return route.name === 'view' && overflow.some((o) => o.route?.name === 'view' && o.route.viewId === route.viewId);
  const r = item.route;
  if (!r) return false;
  if (r.name === 'view') return route.name === 'view' && route.viewId === r.viewId;
  return r.name === route.name;
}
