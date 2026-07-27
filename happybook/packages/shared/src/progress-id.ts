/**
 * Deterministic id for a document's progress record. The web client and the
 * kosync endpoint derive the same UUID independently, so there is exactly one
 * progress record per document and LWW converges on it from both writers
 * without either having to look the other's id up. Shaped as a v5 UUID so it
 * passes changeSchema's uuid() validation.
 */
export async function progressIdFor(documentId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`happybook:progress:${documentId}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
