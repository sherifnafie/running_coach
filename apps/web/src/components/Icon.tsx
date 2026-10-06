import type { SVGProps } from 'react';

/** Stroke icons (24x24). Also used for coach views: `manifest.icon` names map here, unknown names fall back to a circle. */
const PATHS: Record<string, string> = {
  chat: 'M21 12a8 8 0 0 1-11.7 7.1L4 20.5l1.5-4.6A8 8 0 1 1 21 12Z',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM19.4 13.5l1.6 1.2-1.7 3-1.9-.7a7 7 0 0 1-1.6.9l-.3 2h-3.4l-.3-2a7 7 0 0 1-1.6-.9l-1.9.7-1.7-3 1.6-1.2a7 7 0 0 1 0-1.9L4.6 10.4l1.7-3 1.9.7a7 7 0 0 1 1.6-.9l.3-2h3.4l.3 2a7 7 0 0 1 1.6.9l1.9-.7 1.7 3-1.6 1.2a7 7 0 0 1 0 1.9Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
  'phone-off': 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2ZM3 3l18 18',
  paperclip: 'm21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7L10.2 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7.6',
  camera: 'M4 8h3l1.5-2h7L17 8h3v11H4V8Zm8 8.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  image: 'M4 5h16v14H4V5Zm0 11 4-4 3 3 4-5 5 6M9 9.5h.01',
  mic: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  'mic-off': 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18',
  send: 'M4 12 20 4l-5 16-3.5-6.5L4 12Zm7.5 1.5L20 4',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  chevron: 'm9 6 6 6-6 6',
  'chevron-down': 'm6 9 6 6 6-6',
  back: 'm15 6-6 6 6 6',
  file: 'M7 3h7l5 5v13H7V3Zm7 0v5h5',
  play: 'M8 5v14l11-7L8 5Z',
  pause: 'M8 5v14M16 5v14',
  speaker: 'M4 10v4h4l5 4V6L8 10H4Zm12.5-.5a4 4 0 0 1 0 5M18.5 7a7.5 7.5 0 0 1 0 10',
  'speaker-off': 'M4 10v4h4l5 4V6L8 10H4ZM17 9l5 6m0-6-5 6',
  thumbup: 'M7 11v9H4v-9h3Zm0 0 4-7a2 2 0 0 1 2 2l-.5 3H19a2 2 0 0 1 2 2.3l-1 6a2 2 0 0 1-2 1.7H7',
  thumbdown: 'M7 13V4H4v9h3Zm0 0 4 7a2 2 0 0 0 2-2l-.5-3H19a2 2 0 0 0 2-2.3l-1-6A2 2 0 0 0 18 4H7',
  copy: 'M9 9h11v11H9V9Zm-5 6V4h11',
  alert: 'M12 3 2 20h20L12 3Zm0 6v5m0 3h.01',
  wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
  'wifi-off': 'M2 9a15 15 0 0 1 4-2.6M22 9a15 15 0 0 0-8-3.8M5 12.5a10 10 0 0 1 4-2.4M19 12.5a10 10 0 0 0-3-2.1M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M3 3l18 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  // coach views
  circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  today: 'M4 5h16v15H4V5Zm0 5h16M8 3v4m8-4v4m-8 9h3',
  calendar: 'M4 5h16v15H4V5Zm0 5h16M8 3v4m8-4v4M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01',
  plan: 'M5 4h14v16H5V4Zm4 5h6m-6 4h6m-6 4h3',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  chart: 'M4 20V4m0 16h16M8 16v-5m4 5V8m4 8v-3',
  progress: 'm3 17 6-6 4 4 8-8m0 0h-5m5 0v5',
  run: 'M13 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 21l3-6-3-3 3-4 3 2 3 1M11 8 8 11l-3 1',
  shoe: 'M3 16v-3l5-1 3-4 3 2 5 3a3 3 0 0 1 2 3v1H3Zm0 0h18',
  flag: 'M5 21V4m0 0h12l-2 4 2 4H5',
  race: 'M5 21V4m0 0h12l-2 4 2 4H5',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-3h.01',
  heart: 'M12 20s-8-4.6-8-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 8 2.8C20 15.4 12 20 12 20Z',
  home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4v-9Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0',
  star: 'm12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.3l1.1-6.2L3 9.7l6.2-.9L12 3Z',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  book: 'M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4Zm0 12a4 4 0 0 1 4-4h10',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-13v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  scale: 'M12 4v16M5 8h14M7 8l-3 7a3 3 0 0 0 6 0L7 8Zm10 0-3 7a3 3 0 0 0 6 0l-3-7Z',
  food: 'M7 3v8a2 2 0 0 0 2 2v8m0-18v6m4-6v6M17 3c-2 2-2 6 0 8v10',
  bed: 'M3 18V6m0 8h18v4M3 11h8a3 3 0 0 1 3 3m7 0V11a3 3 0 0 0-3-3h-4',
};

export function iconNames(): string[] {
  return Object.keys(PATHS);
}

export function Icon({ name, size = 22, ...rest }: { name: string; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  const d = PATHS[name] ?? PATHS.circle!;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}
