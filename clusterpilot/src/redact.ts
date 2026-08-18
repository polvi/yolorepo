// Secret redaction, shared by everything that writes cluster data somewhere it
// might be read later: the git-tracked state file, the sweep report, and the
// prompts handed to the model.
//
// Two different shapes need it, which is why there are two functions:
//
//   redact()      structured data, where a key name says what the value is.
//                 `helm get values` returns real database passwords.
//   redactText()  free text, where there is no key/value structure to walk.
//                 The Talos kernel command line carries the Omni siderolink
//                 join token, so a raw dmesg dump is credential-bearing.
//
// Both err toward over-redaction. Hiding a harmless setting costs a little
// legibility; leaking a join token into a report or a git remote is not
// recoverable, because you cannot un-publish it.

/**
 * Key-name fragments whose values never leave this process in the clear.
 * Matching is done with separators stripped, so `api_key`, `apiKey`, and
 * `api-key` all hit the same entry.
 */
export const SECRET_KEY_PATTERNS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "credential",
  "bearer",
  "salt",
  "dsn",
  "connectionstring",
  "webhook",
  "license",
];

export const REDACTED = "<redacted by clusterpilot>";

export function looksSecret(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p.replace(/[-_]/g, "")));
}

/** Credentials embedded in a URL, e.g. postgres://user:pw@host. */
const URL_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+):[^@/\s]+@/i;

/** Recursively replaces secret-shaped values. Structure is preserved. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = looksSecret(k) ? REDACTED : redact(v);
    }
    return out;
  }

  if (typeof value === "string" && URL_CREDENTIALS.test(value)) {
    return value.replace(URL_CREDENTIALS, `$1:${REDACTED}@`);
  }

  return value;
}

/**
 * Assignments of a secret-shaped name, in either `key=value` or `key: value`
 * form. The value runs to the next delimiter: whitespace ends a shell-style
 * assignment, and `&` ends a URL query parameter, which is the form the
 * siderolink join token arrives in on the kernel command line.
 */
const TEXT_ASSIGNMENT = new RegExp(
  `\\b([A-Za-z0-9_.-]*(?:${SECRET_KEY_PATTERNS.join("|")})[A-Za-z0-9_.-]*)\\s*([=:])\\s*("?)([^\\s&"']+)`,
  "gi",
);

/** Authorization headers, which carry the credential after the scheme. */
const AUTH_HEADER = /\b(authorization\s*:\s*)(bearer|basic|token)\s+\S+/gi;

/**
 * Redacts secrets from free text such as kernel logs and container output.
 *
 * Worth stating what this is not: a guarantee. Free text can carry a secret
 * with no marker at all, and nothing here would catch it. It removes the
 * credentials that are known to appear in the sources clusterpilot reads,
 * which is why sweep output is still treated as sensitive rather than public.
 */
export function redactText(text: string): string {
  return text
    .replace(AUTH_HEADER, `$1$2 ${REDACTED}`)
    .replace(TEXT_ASSIGNMENT, (_m, key: string, sep: string, quote: string) =>
      `${key}${sep}${quote}${REDACTED}`,
    )
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+):[^@/\s]+@/gi,
      `$1:${REDACTED}@`,
    );
}
