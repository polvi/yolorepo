// In-page passkey ceremonies straight against AuthGravity (tabby pattern):
// the session cookie lands on the registrable domain, so a cross-origin
// fetch with credentials works from backtalk.<base>.
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { baseDomain } from './origins';

const endpoint = () => `https://authgravity.${baseDomain()}`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `auth request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function passkeySignIn(): Promise<void> {
  const options = await json<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
    await fetch(`${endpoint()}/v1/login/options`, { credentials: 'include' })
  );
  const credential = await startAuthentication({ optionsJSON: options });
  await json(
    await fetch(`${endpoint()}/v1/login/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credential),
      credentials: 'include',
    })
  );
}

export async function passkeyCreateAccount(): Promise<void> {
  const options = await json<Parameters<typeof startRegistration>[0]['optionsJSON']>(
    await fetch(`${endpoint()}/v1/register/options`, { credentials: 'include' })
  );
  const credential = await startRegistration({ optionsJSON: options });
  await json(
    await fetch(`${endpoint()}/v1/register/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credential),
      credentials: 'include',
    })
  );
}

export function friendlyAuthError(err: unknown): string | null {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'NotAllowedError') return null; // user cancelled, stay quiet
  if (e?.message && /credential not found/i.test(e.message)) {
    return "That passkey isn't registered here anymore. Try a different one or create an account.";
  }
  return e?.message || 'Sign-in failed. Try again.';
}
