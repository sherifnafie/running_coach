import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { AuthResponse } from '@opencoach/protocol';
import { auth } from './endpoints';

/** Passkeys via SimpleWebAuthn (discoverable credentials; the gateway issues and verifies challenges). */
export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** Gateways may return the options bare or wrapped. */
function optionsOf(res: unknown): never {
  const o = res as { options?: unknown; publicKey?: unknown } | null;
  return (o?.options ?? o?.publicKey ?? res) as never;
}

export async function loginWithPasskey(): Promise<AuthResponse> {
  const optionsJSON = optionsOf(await auth.passkeyLoginOptions());
  const response = await startAuthentication({ optionsJSON });
  return auth.passkeyLoginVerify(response);
}

export async function addPasskey(): Promise<void> {
  const optionsJSON = optionsOf(await auth.passkeyRegisterOptions());
  const response = await startRegistration({ optionsJSON });
  await auth.passkeyRegisterVerify(response);
}

/** True when the user dismissed the browser's passkey sheet (not an error worth showing). */
export function isPasskeyCancelled(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/** "Chrome on Android" style label for the device list. */
export function deviceLabel(ua: string = navigator.userAgent): string {
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} on ${os}`;
}
