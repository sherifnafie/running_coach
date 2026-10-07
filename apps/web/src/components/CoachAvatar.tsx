import { useState } from 'react';

/** Same-origin, authenticated image; broken/missing blobs retain the initial [UI-1]. */
export function CoachAvatar({ name, sha256, className = 'avatar' }: { name: string; sha256?: string | null; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span className={className} aria-hidden="true">
    {sha256 && /^[a-f0-9]{64}$/.test(sha256) && failed !== sha256
      ? <img src={`/v1/blobs/${sha256}`} alt="" onError={() => setFailed(sha256)} />
      : name.slice(0, 1).toUpperCase()}
  </span>;
}
