import { describe, expect, test } from "bun:test";
import { parseSnpReport, parseTcb, verifyVcekChain, checkVcekAgainstReport, verifyReportSignature, amdRoots, parsePemChain, vcekExtensions, hex, policyBit, SNP_POLICY_BIT_DEBUG, SNP_POLICY_BIT_MIGRATE_MA, tcbAtLeast } from "../src/index.ts";
import { dataBytes, dataText } from "./helpers.ts";

// Real vectors (test/data/NOTES.md): Milan v2 report + VCEK from google/go-sev-guest testdata,
// Genoa v3 report + VCEK captured from a live Tinfoil enclave (13rac1/teep). AMD ASK/ARK are the
// pinned KDS chains in src/roots/amd/.
const MILAN_NOW = Date.parse("2024-01-01T00:00:00Z");
const GENOA_NOW = Date.parse("2026-08-01T00:00:00Z");

describe("SNP report parser", () => {
  test("Milan v2 report fields", () => {
    const r = parseSnpReport(dataBytes("report.bin"));
    expect(r.version).toBe(2);
    expect(r.vmpl).toBe(0);
    expect(r.signatureAlgo).toBe(1);
    expect(r.policy).toBe(0xb0000n);
    expect(hex.encode(r.reportData).startsWith("0102030405")).toBe(true);
    expect(r.reportedTcbRaw).toBe(0x4405000000000002n); // bytes 02 00 00 00 00 00 05 44 LE
    const tcb = parseTcb(r.reportedTcbRaw, "Milan");
    expect([tcb.bootLoader, tcb.tee, tcb.snp, tcb.microcode]).toEqual([2, 0, 5, 68]);
    expect(hex.encode(r.chipId).startsWith("3ac3fe21")).toBe(true);
    expect(r.chipId.length).toBe(64); expect(r.measurement.length).toBe(48); expect(r.sigR.length).toBe(48); expect(r.sigS.length).toBe(48);
    expect(r.signedBytes.length).toBe(0x2a0);
    // 0xb0000 = SMT(16) | reserved-must-be-1(17) | DEBUG(19): the go-sev-guest vector is a debug guest
    expect(policyBit(r.policy, SNP_POLICY_BIT_DEBUG)).toBe(true);
    expect(policyBit(r.policy, SNP_POLICY_BIT_MIGRATE_MA)).toBe(false);
  });
  test("Genoa v3 report fields", () => {
    const r = parseSnpReport(dataBytes("report_genoa_v3.bin"));
    expect(policyBit(r.policy, SNP_POLICY_BIT_DEBUG)).toBe(false);
    expect(policyBit(r.policy, SNP_POLICY_BIT_MIGRATE_MA)).toBe(false);
    expect(r.vmpl).toBe(0);
    expect(r.version).toBe(3);
    expect([r.cpuidFamId, r.cpuidModId, r.cpuidStep]).toEqual([25, 17, 1]);
    const tcb = parseTcb(r.reportedTcbRaw, "Genoa");
    expect([tcb.bootLoader, tcb.tee, tcb.snp, tcb.microcode]).toEqual([10, 0, 23, 84]);
    expect(hex.encode(r.chipId).startsWith("1af1aa6c")).toBe(true);
  });
  test("rejects wrong length", () => {
    expect(() => parseSnpReport(new Uint8Array(1183))).toThrow();
  });
  test("Turin TCB layout", () => {
    const t = parseTcb(0x48_00_00_00_0b_02_09_03n, "Turin");
    expect([t.fmc, t.bootLoader, t.tee, t.snp, t.microcode]).toEqual([3, 9, 2, 11, 72]);
    expect(tcbAtLeast(t, { bootLoader: 9, snp: 11, microcode: 72, fmc: 3 })).toBe(true);
    expect(tcbAtLeast(t, { snp: 12 })).toBe(false);
  });
});

describe("VCEK chain + report signature (real data)", () => {
  test("Milan: chain to pinned ARK, extensions match, signature verifies", async () => {
    const r = parseSnpReport(dataBytes("report.bin"));
    const chain = await verifyVcekChain([dataText("vcek.pem")], MILAN_NOW);
    expect(chain.ok).toBe(true);
    expect(chain.product).toBe("Milan");
    const ext = vcekExtensions(chain.vcek!);
    expect(hex.encode(ext.hwId!)).toBe(hex.encode(r.chipId));
    expect(ext.tcb).toEqual({ bootLoader: 2, tee: 0, snp: 5, microcode: 68 });
    expect(checkVcekAgainstReport(chain.vcek!, r, "Milan").ok).toBe(true);
    expect((await verifyReportSignature(chain.vcek!, r)).ok).toBe(true);
  });
  test("Milan: live KDS VCEK for the same chip (different validity) also works; chain supplied in doc is ignored in favour of pinned roots", async () => {
    const r = parseSnpReport(dataBytes("report.bin"));
    const chain = await verifyVcekChain([dataText("vcek_kds_live.pem"), dataText("cert_chain_milan.pem")], Date.parse("2027-01-01T00:00:00Z"));
    expect(chain.ok).toBe(true);
    expect((await verifyReportSignature(chain.vcek!, r)).ok).toBe(true);
  });
  test("Genoa v3: chain + extensions + signature", async () => {
    const r = parseSnpReport(dataBytes("report_genoa_v3.bin"));
    const chain = await verifyVcekChain([dataText("vcek_genoa.pem")], GENOA_NOW);
    expect(chain.detail).toContain("Genoa");
    expect(chain.ok).toBe(true);
    expect(checkVcekAgainstReport(chain.vcek!, r, "Genoa")).toMatchObject({ ok: true });
    expect((await verifyReportSignature(chain.vcek!, r)).ok).toBe(true);
  });
  test("negative: flipped byte in signed region, swapped VCEK, expired window, wrong chip", async () => {
    const raw = dataBytes("report.bin");
    const chain = await verifyVcekChain([dataText("vcek.pem")], MILAN_NOW);
    const flipped = raw.slice(); flipped[0x90] ^= 1; // measurement byte
    expect((await verifyReportSignature(chain.vcek!, parseSnpReport(flipped))).ok).toBe(false);
    // Genoa VCEK cannot verify the Milan report
    const genoa = await verifyVcekChain([dataText("vcek_genoa.pem")], GENOA_NOW);
    expect((await verifyReportSignature(genoa.vcek!, parseSnpReport(raw))).ok).toBe(false);
    expect(checkVcekAgainstReport(genoa.vcek!, parseSnpReport(raw), "Genoa").ok).toBe(false);
    // validity window
    expect((await verifyVcekChain([dataText("vcek.pem")], Date.parse("2010-01-01T00:00:00Z"))).ok).toBe(false);
    // a self-signed impostor "VCEK" is not under the pinned ASK
    const [ask] = parsePemChain([dataText("cert_chain_milan.pem")]);
    expect((await verifyVcekChain([ask!.toString("pem")], MILAN_NOW)).ok).toBe(false);
    // reported TCB tampered → extension mismatch
    const t = raw.slice(); t[0x180] = 9;
    expect(checkVcekAgainstReport(chain.vcek!, parseSnpReport(t), "Milan").ok).toBe(false);
  });
  test("pinned roots: Genoa, Turin (and Milan for the vector) are self-consistent", async () => {
    const roots = amdRoots();
    expect(Object.keys(roots).sort()).toEqual(["Genoa", "Milan", "Turin"]);
    for (const { ask, ark } of Object.values(roots)) {
      expect(await ark.verify({ publicKey: ark, signatureOnly: true })).toBe(true);
      expect(await ask.verify({ publicKey: ark, signatureOnly: true })).toBe(true);
    }
  });
});
