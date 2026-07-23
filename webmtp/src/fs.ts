// Path-based filesystem layer over MtpDevice, built for sync use cases:
// resolve/readdir/stat/readFile/writeFile/mkdirp/rm against one storage.
// MTP addresses objects by opaque handle; this walks name segments and
// caches folder handles so repeated syncs don't re-walk the tree.

import { MtpDevice, ROOT_PARENT, type ObjectInfo } from './mtp';

export class MtpFs {
  readonly mtp: MtpDevice;
  readonly storageId: number;
  private folderCache = new Map<string, number>();

  constructor(mtp: MtpDevice, storageId: number) {
    this.mtp = mtp;
    this.storageId = storageId;
  }

  static segments(path: string): string[] {
    return path.split('/').map((s) => s.trim()).filter(Boolean);
  }

  private async childByName(parent: number, name: string): Promise<ObjectInfo | null> {
    const handles = await this.mtp.getObjectHandles(this.storageId, parent);
    for (const h of handles) {
      const info = await this.mtp.getObjectInfo(h);
      if (info.filename === name) return info;
    }
    return null;
  }

  /** Folder path -> handle (ROOT_PARENT for ''); null if any segment is missing or a file. */
  async resolveFolder(path: string): Promise<number | null> {
    let parent: number = ROOT_PARENT;
    let key = '';
    for (const seg of MtpFs.segments(path)) {
      key += '/' + seg;
      const cached = this.folderCache.get(key);
      if (cached !== undefined) { parent = cached; continue; }
      const child = await this.childByName(parent, seg);
      if (!child || !child.isFolder) return null;
      this.folderCache.set(key, child.handle);
      parent = child.handle;
    }
    return parent;
  }

  /** Create every missing segment; returns the final folder handle. */
  async mkdirp(path: string): Promise<number> {
    let parent: number = ROOT_PARENT;
    let key = '';
    for (const seg of MtpFs.segments(path)) {
      key += '/' + seg;
      const cached = this.folderCache.get(key);
      if (cached !== undefined) { parent = cached; continue; }
      const child = await this.childByName(parent, seg);
      let handle: number;
      if (child) {
        if (!child.isFolder) throw new Error(key + ' exists and is not a folder');
        handle = child.handle;
      } else {
        handle = await this.mtp.createFolder(this.storageId, parent, seg);
        this.mtp.log('created folder ' + key);
      }
      this.folderCache.set(key, handle);
      parent = handle;
    }
    return parent;
  }

  async readdir(path: string): Promise<ObjectInfo[]> {
    const parent = await this.resolveFolder(path);
    if (parent === null) throw new Error('no such folder: /' + MtpFs.segments(path).join('/'));
    const handles = await this.mtp.getObjectHandles(this.storageId, parent);
    const out: ObjectInfo[] = [];
    for (const h of handles) out.push(await this.mtp.getObjectInfo(h));
    return out;
  }

  async stat(path: string): Promise<ObjectInfo | null> {
    const segs = MtpFs.segments(path);
    const name = segs.pop();
    if (!name) return null;
    const parent = await this.resolveFolder(segs.join('/'));
    if (parent === null) return null;
    return this.childByName(parent, name);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const info = await this.stat(path);
    if (!info) throw new Error('no such file: ' + path);
    if (info.isFolder) throw new Error(path + ' is a folder');
    return this.mtp.getObject(info.handle);
  }

  /**
   * Write a file, creating parent folders as needed. MTP has no overwrite,
   * so an existing object of the same name is deleted first.
   * Returns the new object handle.
   */
  async writeFile(path: string, bytes: Uint8Array): Promise<number> {
    const segs = MtpFs.segments(path);
    const name = segs.pop();
    if (!name) throw new Error('writeFile needs a file name: ' + path);
    const parent = await this.mkdirp(segs.join('/'));
    const existing = await this.childByName(parent, name);
    if (existing) {
      if (existing.isFolder) throw new Error(path + ' exists and is a folder');
      await this.mtp.deleteObject(existing.handle);
    }
    return this.mtp.sendObject(this.storageId, parent, name, bytes);
  }

  /** Delete a file or folder (folders delete recursively on MTP). Missing paths are a no-op. */
  async rm(path: string): Promise<void> {
    const info = await this.stat(path);
    if (!info) return;
    await this.mtp.deleteObject(info.handle);
    if (info.isFolder) {
      const key = '/' + MtpFs.segments(path).join('/');
      for (const k of [...this.folderCache.keys()]) {
        if (k === key || k.startsWith(key + '/')) this.folderCache.delete(k);
      }
    }
  }
}
