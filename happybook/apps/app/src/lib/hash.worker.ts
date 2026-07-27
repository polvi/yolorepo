// Hashing a 50MB PDF on the main thread janks the UI; do it here.
self.onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  const digest = await crypto.subtle.digest('SHA-256', e.data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  self.postMessage(hex);
};
