/** PDF bytes live in OPFS, keyed by content hash; Dexie holds only metadata. */
export interface BlobStore {
  put(sha256: string, data: ArrayBuffer): Promise<void>;
  get(sha256: string): Promise<ArrayBuffer | null>;
  has(sha256: string): Promise<boolean>;
  delete(sha256: string): Promise<void>;
}

class OpfsBlobStore implements BlobStore {
  private async dir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('blobs', { create: true });
  }

  async put(sha256: string, data: ArrayBuffer): Promise<void> {
    const dir = await this.dir();
    const handle = await dir.getFileHandle(`${sha256}.pdf`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async get(sha256: string): Promise<ArrayBuffer | null> {
    try {
      const dir = await this.dir();
      const handle = await dir.getFileHandle(`${sha256}.pdf`);
      const file = await handle.getFile();
      return await file.arrayBuffer();
    } catch {
      return null;
    }
  }

  async has(sha256: string): Promise<boolean> {
    try {
      const dir = await this.dir();
      await dir.getFileHandle(`${sha256}.pdf`);
      return true;
    } catch {
      return false;
    }
  }

  async delete(sha256: string): Promise<void> {
    const dir = await this.dir();
    await dir.removeEntry(`${sha256}.pdf`).catch(() => {});
  }
}

/** In-memory store for tests. */
export class MemoryBlobStore implements BlobStore {
  private map = new Map<string, ArrayBuffer>();
  async put(sha256: string, data: ArrayBuffer) {
    this.map.set(sha256, data);
  }
  async get(sha256: string) {
    return this.map.get(sha256) ?? null;
  }
  async has(sha256: string) {
    return this.map.has(sha256);
  }
  async delete(sha256: string) {
    this.map.delete(sha256);
  }
}

export const blobStore: BlobStore = new OpfsBlobStore();
