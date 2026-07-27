// Notebook -> USB e-reader sync over MTP (WebUSB). Each notebook maps to a
// folder on the device; documents are compared by name + size, uploaded when
// missing or changed, and removed when they no longer exist in the notebook.
// Folders on the device (e.g. KOReader .sdr sidecars) are never touched.

import {
  MtpFs, connectMtp, getGrantedMtpDevice, mountedStorageIds,
  requestMtpDevice, usbSupported, type MtpDevice,
} from 'mtp-ts';
import { db } from '$lib/db';
import { blobStore } from '$lib/blobstore';

export { usbSupported };

/** Device-side home for synced notebooks; e-reader library scanners look in Books. */
export const DEVICE_BASE = 'Books/happybook';

export interface DeviceSyncResult {
  deviceName: string;
  folder: string;
  uploaded: string[];
  skipped: string[];
  removed: string[];
  missing: string[]; // documents whose bytes aren't in the local blob store yet
}

let current: { mtp: MtpDevice; fs: MtpFs; deviceName: string } | null = null;

/**
 * Connect to a granted device, or show the picker (needs a user gesture).
 * The connection is kept for the session; a failed reuse resets it.
 */
export async function connectDevice(): Promise<{ mtp: MtpDevice; fs: MtpFs; deviceName: string }> {
  if (current) return current;
  const device = (await getGrantedMtpDevice()) ?? (await requestMtpDevice());
  const mtp = await connectMtp(device);
  const ids = mountedStorageIds(await mtp.getStorageIDs());
  const sid = ids[0];
  if (sid === undefined) throw new Error('the device has no mounted storage');
  current = { mtp, fs: new MtpFs(mtp, sid), deviceName: device.productName ?? 'MTP device' };
  return current;
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || 'untitled';
}

export async function syncNotebook(notebookId: string): Promise<DeviceSyncResult> {
  let conn;
  try {
    conn = await connectDevice();
    await conn.fs.mkdirp(DEVICE_BASE);
  } catch (e) {
    current = null; // stale grant or unplugged device; next attempt reconnects
    throw e;
  }
  const { fs, deviceName } = conn;

  const notebook = await db.notebooks.get(notebookId);
  if (!notebook || notebook.deleted) throw new Error('notebook not found');
  const docs = await db.documents
    .where('notebookId').equals(notebookId)
    .filter((d) => d.deleted === 0)
    .toArray();

  const folder = `${DEVICE_BASE}/${safeName(notebook.title)}`;
  await fs.mkdirp(folder);
  const existing = new Map(
    (await fs.readdir(folder)).filter((e) => !e.isFolder).map((e) => [e.filename, e]),
  );

  // Desired device filename per document; title collisions get a hash suffix.
  const want = new Map<string, (typeof docs)[number]>();
  for (const d of docs) {
    const ext = d.format ?? 'pdf'; // format is absent on pre-EPUB records
    let name = `${safeName(d.title)}.${ext}`;
    if (want.has(name)) name = `${safeName(d.title)} (${d.sha256.slice(0, 7)}).${ext}`;
    want.set(name, d);
  }

  const result: DeviceSyncResult = {
    deviceName, folder: '/' + folder, uploaded: [], skipped: [], removed: [], missing: [],
  };

  for (const [name, doc] of want) {
    const onDevice = existing.get(name);
    if (onDevice && onDevice.size === doc.size) {
      result.skipped.push(name);
      continue;
    }
    const bytes = await blobStore.get(doc.sha256);
    if (!bytes) {
      result.missing.push(name);
      continue;
    }
    await fs.writeFile(`${folder}/${name}`, new Uint8Array(bytes));
    result.uploaded.push(name);
  }

  // Files we once managed but that left the notebook. Folders stay untouched.
  for (const [name] of existing) {
    if (!want.has(name) && !result.missing.includes(name)) {
      await fs.rm(`${folder}/${name}`);
      result.removed.push(name);
    }
  }

  return result;
}
