// WebCrypto SHA-1 helpers plus hex codecs. No dependencies.

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hexStr: string): Uint8Array {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-1', data as BufferSource);
  return new Uint8Array(digest);
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
  return bytesToHex(await sha1(data));
}
