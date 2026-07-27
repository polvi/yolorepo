import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { initSync, stopSync } from './sync-client';

// AuthGravity lives at authgravity.<base domain>, where the base domain is
// the app's hostname minus the 'app.happybook.' prefix. Local dev has no
// deployed base domain, so it falls back to proc.io.
function deriveAuthEndpoint(): string {
  const host = typeof location === 'undefined' ? 'localhost' : location.hostname;
  const base =
    host === 'localhost' || host === '127.0.0.1'
      ? 'proc.io'
      : host.startsWith('app.happybook.')
        ? host.slice('app.happybook.'.length)
        : host;
  return `https://authgravity.${base}`;
}

export const AUTH_ENDPOINT = deriveAuthEndpoint();

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`auth request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function registerPasskey(): Promise<void> {
  const options = await json<Parameters<typeof startRegistration>[0]['optionsJSON']>(
    await fetch(`${AUTH_ENDPOINT}/v1/register/options`, { credentials: 'include' }),
  );
  const credential = await startRegistration({ optionsJSON: options });
  await json(
    await fetch(`${AUTH_ENDPOINT}/v1/register/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credential),
      credentials: 'include',
    }),
  );
  await initSync();
}

export async function loginPasskey(): Promise<void> {
  const options = await json<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
    await fetch(`${AUTH_ENDPOINT}/v1/login/options`, { credentials: 'include' }),
  );
  const credential = await startAuthentication({ optionsJSON: options });
  await json(
    await fetch(`${AUTH_ENDPOINT}/v1/login/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credential),
      credentials: 'include',
    }),
  );
  await initSync();
}

/** Zero-UI fallback when the WebAuthn ceremony fails in this browser. */
export function hostedLogin(): void {
  location.href = `${AUTH_ENDPOINT}/login?return_to=${encodeURIComponent(location.href)}`;
}

export async function logout(): Promise<void> {
  await fetch(`${AUTH_ENDPOINT}/v1/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
  stopSync();
}
