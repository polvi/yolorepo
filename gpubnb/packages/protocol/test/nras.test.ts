import { describe, expect, test } from "bun:test";
import { verifyEs384Jwt, decodeJwt, checkDeviceClaims, hwmodelAllowed, NRAS_ISSUER, NRAS_JWKS_URL, fetchNrasJwks, sha256, utf8, hex } from "../src/index.ts";
import { dataText } from "./helpers.ts";
import { makeSynthNras } from "./synth.ts";

const sample = JSON.parse(dataText("nras-sample-eat.json")) as [["JWT", string], Record<string, string>];
const jwksAtCapture = (JSON.parse(dataText("nras-jwks-at-capture.json")) as { keys: JsonWebKey[] }).keys;
const overallJwt = sample[0][1];
const deviceJwt = sample[1]["GPU-0"]!;
const CAPTURE_NOW = decodeJwt(overallJwt).claims.iat as number * 1000 + 60_000;

describe("NRAS EAT (real sample, H100, captured 2026-06-29)", () => {
  test("constants", () => {
    expect(NRAS_JWKS_URL).toBe("https://nras.attestation.nvidia.com/.well-known/jwks.json");
    expect(NRAS_ISSUER).toBe("https://nras.attestation.nvidia.com");
  });
  test("overall + device JWT verify against the JWKS captured at the time", async () => {
    const o = await verifyEs384Jwt(overallJwt, jwksAtCapture, { now: CAPTURE_NOW, issuer: NRAS_ISSUER });
    expect(o.ok).toBe(true);
    expect(o.claims!["x-nvidia-overall-att-result"]).toBe(true);
    const d = await verifyEs384Jwt(deviceJwt, jwksAtCapture, { now: CAPTURE_NOW, issuer: NRAS_ISSUER });
    expect(d.ok).toBe(true);
    expect(checkDeviceClaims("GPU-0", d.claims!).ok).toBe(true);
    expect(d.claims!.hwmodel).toBe("GH100");
    // submods digest = sha256 of the device JWT ascii
    const sub = (o.claims!.submods as any)["GPU-0"][1][1];
    expect(hex.encode(await sha256(utf8(deviceJwt)))).toBe(sub);
  });
  test("expired now → rejected; wrong issuer → rejected; kid missing from live-style JWKS → rejected", async () => {
    expect((await verifyEs384Jwt(overallJwt, jwksAtCapture, { now: Date.parse("2026-08-19T00:00:00Z"), issuer: NRAS_ISSUER })).ok).toBe(false);
    expect((await verifyEs384Jwt(overallJwt, jwksAtCapture, { now: CAPTURE_NOW, issuer: "https://nras.attestation-stg.nvidia.com" })).ok).toBe(false);
    const live = (JSON.parse(dataText("nras-jwks.json")) as { keys: JsonWebKey[] }).keys;
    const r = await verifyEs384Jwt(overallJwt, live, { now: CAPTURE_NOW, issuer: NRAS_ISSUER });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no JWKS key with kid/);
  });
  test("tampered payload fails signature", async () => {
    const [h, c, s] = overallJwt.split(".");
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    claims["x-nvidia-overall-att-result"] = false;
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    expect((await verifyEs384Jwt(forged, jwksAtCapture, { now: CAPTURE_NOW, issuer: NRAS_ISSUER })).detail).toMatch(/signature invalid/);
  });
});

describe("NRAS (synthetic ES384 JWKS)", () => {
  test("sign/verify, alg confusion, unknown kid", async () => {
    const n = await makeSynthNras();
    const now = Date.now();
    const t = await n.sign({ iss: NRAS_ISSUER, exp: Math.floor(now / 1000) + 60, foo: 1 });
    expect((await verifyEs384Jwt(t, n.jwks, { now, issuer: NRAS_ISSUER })).ok).toBe(true);
    expect((await verifyEs384Jwt(t, n.jwks, { now: now + 10 * 60_000, issuer: NRAS_ISSUER })).ok).toBe(false);
    const other = await makeSynthNras();
    expect((await verifyEs384Jwt(t, other.jwks, { now, issuer: NRAS_ISSUER })).ok).toBe(false);
    // alg none / HS256 header is refused before any key lookup
    const [, c, s] = t.split(".");
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${c}.${s}`;
    expect((await verifyEs384Jwt(none, n.jwks, { now })).detail).toMatch(/alg/);
  });
  test("device claim checks", () => {
    const base = { measres: "success", dbgstat: "disabled", secboot: true, hwmodel: "GB202" };
    expect(checkDeviceClaims("GPU-0", base).ok).toBe(true);
    expect(checkDeviceClaims("GPU-0", { ...base, measres: "fail" }).ok).toBe(false);
    expect(checkDeviceClaims("GPU-0", { ...base, dbgstat: "enabled" }).ok).toBe(false);
    expect(checkDeviceClaims("GPU-0", { ...base, secboot: false }).ok).toBe(false);
    expect(checkDeviceClaims("GPU-0", { ...base, hwmodel: "GA100" }).ok).toBe(false);
    expect(hwmodelAllowed("GH100")).toBe(true);
    expect(hwmodelAllowed("NVIDIA RTX PRO 6000 Blackwell Server Edition")).toBe(true);
    expect(hwmodelAllowed("RTX PRO 6000 Blackwell Workstation Edition")).toBe(false);
    expect(hwmodelAllowed("GB202", ["H100"])).toBe(false);
  });
  test("fetchNrasJwks uses the injected fetch", async () => {
    const keys = await fetchNrasJwks((async (url: any) => { expect(String(url)).toBe(NRAS_JWKS_URL); return new Response(JSON.stringify({ keys: [{ kty: "EC" }] })); }) as any);
    expect(keys).toEqual([{ kty: "EC" }]);
    await expect(fetchNrasJwks((async () => new Response("x", { status: 500 })) as any)).rejects.toThrow(/500/);
  });
});
