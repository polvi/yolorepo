// NVIDIA Remote Attestation Service (NRAS) Detached-EAT verification: an overall
// JWT plus one JWT per GPU, all ES384-signed by NRAS keys published as a JWKS.
import { b64u, toBuf, utf8, utf8Decode } from "../encoding.ts";

/** NRAS JWKS (ES384 keys). Override with VerifyOptions.fetchJwks when caching (e.g. in Workers KV). */
export const NRAS_JWKS_URL = "https://nras.attestation.nvidia.com/.well-known/jwks.json";
export const NRAS_ISSUER = "https://nras.attestation.nvidia.com";

export async function fetchNrasJwks(fetchImpl: typeof fetch = fetch): Promise<JsonWebKey[]> {
  const r = await fetchImpl(NRAS_JWKS_URL, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`NRAS JWKS fetch failed: HTTP ${r.status}`);
  const j = (await r.json()) as { keys?: JsonWebKey[] };
  if (!Array.isArray(j.keys)) throw new Error("NRAS JWKS: no keys array");
  return j.keys;
}

export interface JwtParts { header: Record<string, unknown>; claims: Record<string, unknown>; signingInput: Uint8Array; signature: Uint8Array }

export function decodeJwt(token: string): JwtParts {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("JWT must have 3 segments");
  const header = JSON.parse(utf8Decode(b64u.decode(parts[0]!))) as Record<string, unknown>;
  const claims = JSON.parse(utf8Decode(b64u.decode(parts[1]!))) as Record<string, unknown>;
  return { header, claims, signingInput: utf8(`${parts[0]}.${parts[1]}`), signature: b64u.decode(parts[2]!) };
}

const keyCache = new WeakMap<JsonWebKey, Promise<CryptoKey>>();
async function importEs384(jwk: JsonWebKey): Promise<CryptoKey> {
  let p = keyCache.get(jwk);
  if (!p) {
    const { d: _d, ...pub } = jwk as JsonWebKey & { d?: string };
    p = crypto.subtle.importKey("jwk", { ...pub, key_ops: ["verify"], ext: true }, { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]);
    keyCache.set(jwk, p);
  }
  return p;
}

export interface JwtVerifyResult { ok: boolean; detail: string; claims?: Record<string, unknown>; kid?: string }

/**
 * Verify one ES384 JWT against a JWKS. Checks: alg ES384, a JWK with matching `kid` (or any P-384 key if the
 * token has no kid), signature, `exp` (> now), `nbf` (<= now), `iss` == issuer when one is configured.
 */
export async function verifyEs384Jwt(token: string, jwks: JsonWebKey[], opts: { now: number; issuer?: string | null; skewSec?: number }): Promise<JwtVerifyResult> {
  let jwt: JwtParts;
  try { jwt = decodeJwt(token); } catch (e) { return { ok: false, detail: `malformed JWT: ${(e as Error).message}` }; }
  if (jwt.header.alg !== "ES384") return { ok: false, detail: `alg ${String(jwt.header.alg)} (want ES384)` };
  const kid = typeof jwt.header.kid === "string" ? jwt.header.kid : undefined;
  const candidates = jwks.filter((k) => k.kty === "EC" && (k.crv === "P-384" || !k.crv) && (kid === undefined || (k as JsonWebKey & { kid?: string }).kid === kid));
  if (candidates.length === 0) return { ok: false, detail: kid ? `no JWKS key with kid ${kid}` : "no P-384 key in JWKS", kid };
  if (jwt.signature.length !== 96) return { ok: false, detail: `signature length ${jwt.signature.length} (want 96 = r‖s)`, kid };
  let sigOk = false;
  for (const k of candidates) {
    try {
      const key = await importEs384(k);
      if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-384" }, key, toBuf(jwt.signature), toBuf(jwt.signingInput))) { sigOk = true; break; }
    } catch { /* try next */ }
  }
  if (!sigOk) return { ok: false, detail: "ES384 signature invalid", kid };
  const skew = opts.skewSec ?? 60;
  const nowS = Math.floor(opts.now / 1000);
  const exp = jwt.claims.exp;
  if (typeof exp === "number" && nowS > exp + skew) return { ok: false, detail: `JWT expired at ${exp} (now ${nowS})`, kid, claims: jwt.claims };
  const nbf = jwt.claims.nbf;
  if (typeof nbf === "number" && nowS + skew < nbf) return { ok: false, detail: `JWT not yet valid (nbf ${nbf})`, kid, claims: jwt.claims };
  if (opts.issuer && jwt.claims.iss !== opts.issuer) return { ok: false, detail: `iss ${String(jwt.claims.iss)} != ${opts.issuer}`, kid, claims: jwt.claims };
  return { ok: true, detail: `ES384 ok (kid ${kid ?? "-"})`, kid, claims: jwt.claims };
}

/**
 * Default GPU model allowlist (PROTOCOL §4 check 13). NRAS `hwmodel` strings name the silicon
 * ("GH100 A01 GSP BROM", "GB202 …"), so the list carries both the marketing names and the chip
 * codes; a claim passes when its upper-cased value contains any upper-cased allowlisted token.
 */
export const DEFAULT_HWMODEL_ALLOW: readonly string[] = [
  "RTX PRO 6000 Blackwell Server Edition", "GB202",
  "H100", "GH100",
  "H200",
  "B200", "GB100", "GB200",
  "B300", "GB300",
];

export function hwmodelAllowed(hwmodel: unknown, allow: readonly string[] = DEFAULT_HWMODEL_ALLOW): boolean {
  if (typeof hwmodel !== "string") return false;
  const h = hwmodel.toUpperCase();
  return allow.some((a) => h.includes(a.toUpperCase()));
}

export interface GpuClaimsCheck { ok: boolean; detail: string }

/** Per-device claims (check 13): measres == success, dbgstat == disabled, secboot == true, hwmodel allowlisted. */
export function checkDeviceClaims(name: string, c: Record<string, unknown>, allow?: readonly string[]): GpuClaimsCheck {
  const bad: string[] = [];
  if (c.measres !== "success") bad.push(`measres=${JSON.stringify(c.measres)}`);
  if (c.dbgstat !== "disabled") bad.push(`dbgstat=${JSON.stringify(c.dbgstat)}`);
  if (c.secboot !== true) bad.push(`secboot=${JSON.stringify(c.secboot)}`);
  if (!hwmodelAllowed(c.hwmodel, allow)) bad.push(`hwmodel=${JSON.stringify(c.hwmodel)} not allowlisted`);
  return bad.length ? { ok: false, detail: `${name}: ${bad.join(", ")}` } : { ok: true, detail: `${name}: measres=success dbgstat=disabled secboot=true hwmodel=${String(c.hwmodel)}` };
}
