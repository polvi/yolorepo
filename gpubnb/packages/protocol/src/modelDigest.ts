// §8 model_digest = SHA256 over sorted (relative_path, SHA256(file)) entries,
// each encoded as path || 0x00 || sha256 || 0x0a.
import { concat, sha256, utf8 } from "./encoding.ts";

export interface ModelDigestEntry { path: string; sha256: Uint8Array }

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Sort is bytewise on the UTF-8 path (what `sort` of raw bytes gives; locale-free). Duplicate paths are an error. */
export async function modelDigestFromEntries(entries: ModelDigestEntry[]): Promise<Uint8Array> {
  const items = entries.map((e) => {
    if (e.sha256.length !== 32) throw new Error(`sha256 for ${e.path} must be 32 bytes`);
    if (e.path.includes("\0")) throw new Error(`path contains NUL: ${JSON.stringify(e.path)}`);
    return { pathBytes: utf8(e.path), sha: e.sha256 };
  });
  items.sort((a, b) => cmpBytes(a.pathBytes, b.pathBytes));
  for (let i = 1; i < items.length; i++) if (cmpBytes(items[i - 1]!.pathBytes, items[i]!.pathBytes) === 0) throw new Error("duplicate path");
  const parts: Uint8Array[] = [];
  for (const it of items) parts.push(it.pathBytes, new Uint8Array([0]), it.sha, new Uint8Array([0x0a]));
  return sha256(concat(...parts));
}
