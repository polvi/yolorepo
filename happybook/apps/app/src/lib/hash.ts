export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<string>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<string>) => resolve(e.data);
      worker.onerror = (e) => reject(e.error ?? new Error('hash worker failed'));
      // Structured clone (no transfer): the caller still needs the buffer for OPFS.
      worker.postMessage(data);
    });
  } finally {
    worker.terminate();
  }
}
