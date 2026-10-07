import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CoachAvatar } from './CoachAvatar';

describe('[UI-1] coach avatar fallback', () => {
  it('uses private blob URLs and falls back when the image cannot load', () => {
    const sha = 'a'.repeat(64);
    const { container, rerender } = render(<CoachAvatar name="Kip" sha256={sha} />);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe(`/v1/blobs/${sha}`);
    fireEvent.error(image);
    expect(screen.getByText('K')).toBeTruthy();
    rerender(<CoachAvatar name="Coach" sha256={'b'.repeat(64)} />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(`/v1/blobs/${'b'.repeat(64)}`);
    rerender(<CoachAvatar name="Coach" sha256="https://untrusted.example/pixel" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('C')).toBeTruthy();
  });
});
