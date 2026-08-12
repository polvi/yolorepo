// Minimal MTP (Media Transfer Protocol) over WebUSB.
// MTP rides on the PTP (ISO 15740) USB transport: 12-byte containers over
// a pair of bulk endpoints. Container: length u32, type u16, code u16,
// transactionID u32, then payload. All values little-endian.

export const OPS = {
  GetDeviceInfo: 0x1001,
  OpenSession: 0x1002,
  CloseSession: 0x1003,
  GetStorageIDs: 0x1004,
  GetStorageInfo: 0x1005,
  GetNumObjects: 0x1006,
  GetObjectHandles: 0x1007,
  GetObjectInfo: 0x1008,
  GetObject: 0x1009,
  DeleteObject: 0x100b,
  SendObjectInfo: 0x100c,
  SendObject: 0x100d,
} as const;

export const CONTAINER = { COMMAND: 1, DATA: 2, RESPONSE: 3, EVENT: 4 } as const;

// USB base-class code for still-image capture (PTP), the class real MTP/PTP
// interfaces advertise. See usb.org base-class list.
const USB_CLASS_STILL_IMAGE = 0x06;

// Base classes that expose bulk in/out pairs but never speak MTP. A composite
// gadget (Android phone, or an Autel drone: RNDIS + vendor + ADB) offers
// several of these, so the old "first bulk pair wins" fallback would claim a
// network or debug pipe and hang. Skip them.
const NON_MTP_CLASSES = new Set<number>([
  0x01, // audio
  0x02, // CDC control (RNDIS/ACM comm)
  0x03, // HID
  0x08, // mass storage
  0x09, // hub
  0x0a, // CDC data (RNDIS/ACM data pipe)
  0x0b, // smart card
  0x0e, // video
  0xdc, // diagnostic
  0xe0, // wireless controller (RNDIS lives here on many gadgets)
]);

// A vendor-specific (0xFF) interface is ambiguous: some devices ship MTP there,
// but Android also puts ADB (FF/42/01), fastboot (FF/42/03), and AOA accessory
// (FF/FF/00) behind it. Recognize the debug/accessory signatures so we never
// probe them.
function isAndroidDebugInterface(cls: number, sub: number, proto: number): boolean {
  if (cls !== 0xff) return false;
  if (sub === 0x42) return true;        // adb (proto 1) / fastboot (proto 3)
  if (sub === 0xff && proto === 0x00) return true; // AOA accessory
  return false;
}

export const RC_NAMES: Record<number, string> = {
  0x2001: 'OK',
  0x2002: 'GeneralError',
  0x2003: 'SessionNotOpen',
  0x2005: 'OperationNotSupported',
  0x2006: 'ParameterNotSupported',
  0x2007: 'IncompleteTransfer',
  0x2009: 'InvalidObjectHandle',
  0x200c: 'StoreFull',
  0x200d: 'ObjectWriteProtected',
  0x2013: 'StoreNotAvailable',
  0x2015: 'NoValidObjectInfo',
  0x2019: 'DeviceBusy',
  0x201d: 'InvalidParameter',
  0x201e: 'SessionAlreadyOpen',
};

export const FMT_ASSOCIATION = 0x3001; // folder
export const ROOT_PARENT = 0xffffffff;

const EXT_FORMATS: Record<string, number> = {
  txt: 0x3004, html: 0x3005, htm: 0x3005, wav: 0x3008, mp3: 0x3009,
  avi: 0x300a, mpg: 0x300b, jpg: 0x3801, jpeg: 0x3801, gif: 0x3807,
  png: 0x380b, tiff: 0x380d, wma: 0xb901, mp4: 0xb982,
};

export function formatForName(name: string): number {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return EXT_FORMATS[ext] ?? 0x3000; // undefined/binary
}

export function rcName(code: number): string {
  return RC_NAMES[code] ?? '0x' + code.toString(16);
}

export class Reader {
  private dv: DataView;
  private o = 0;
  constructor(u8: Uint8Array) {
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  u8(): number { const v = this.dv.getUint8(this.o); this.o += 1; return v; }
  u16(): number { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32(): number { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  u64(): number {
    const lo = this.u32(), hi = this.u32();
    return hi * 0x100000000 + lo;
  }
  // PTP string: u8 char count (incl. null terminator), then UTF-16LE chars.
  string(): string {
    const n = this.u8();
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = this.u16();
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s;
  }
  au16(): number[] {
    const n = this.u32();
    const a: number[] = [];
    for (let i = 0; i < n; i++) a.push(this.u16());
    return a;
  }
  au32(): number[] {
    const n = this.u32();
    const a: number[] = [];
    for (let i = 0; i < n; i++) a.push(this.u32());
    return a;
  }
}

export class Writer {
  private bytes: number[] = [];
  u8(v: number): void { this.bytes.push(v & 0xff); }
  u16(v: number): void { this.u8(v); this.u8(v >> 8); }
  u32(v: number): void { this.u16(v); this.u16(v >>> 16); }
  string(s: string): void {
    if (!s) { this.u8(0); return; }
    this.u8(s.length + 1); // char count including null terminator
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    this.u16(0);
  }
  build(): Uint8Array { return new Uint8Array(this.bytes); }
}

export interface DeviceInfo {
  standardVersion: number;
  vendorExtensionID: number;
  vendorExtensionVersion: number;
  vendorExtensionDesc: string;
  functionalMode: number;
  operationsSupported: number[];
  eventsSupported: number[];
  devicePropertiesSupported: number[];
  captureFormats: number[];
  playbackFormats: number[];
  manufacturer: string;
  model: string;
  deviceVersion: string;
  serialNumber: string;
}

export interface StorageInfo {
  id: number;
  storageType: number;
  filesystemType: number;
  accessCapability: number;
  maxCapacity: number;
  freeSpace: number;
  freeSpaceObjects: number;
  description: string;
  volumeLabel: string;
}

export interface ObjectInfo {
  handle: number;
  storageId: number;
  format: number;
  protection: number;
  size: number;
  parent: number;
  associationType: number;
  filename: string;
  dateCreated: string;
  dateModified: string;
  isFolder: boolean;
}

interface Container {
  length: number;
  type: number;
  code: number;
  tid: number;
  payload: Uint8Array;
}

export interface TransactionResult {
  code: number;
  params: number[];
  data: Uint8Array | null;
}

// Structural subset of WebUSB used here, so consumers don't need the
// non-standard USB lib types; a real USBDevice satisfies it.
export interface UsbEndpointLike { endpointNumber: number; direction: string; type: string; }
export interface UsbAlternateLike {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass?: number;
  interfaceProtocol?: number;
  interfaceName?: string;
  endpoints: UsbEndpointLike[];
}
export interface UsbInterfaceLike { interfaceNumber: number; alternates: UsbAlternateLike[]; }
export interface UsbConfigurationLike { interfaces: UsbInterfaceLike[]; }
export interface UsbTransferInResultLike { status?: string; data?: DataView; }
export interface UsbDeviceLike {
  productName?: string;
  configuration: UsbConfigurationLike | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(num: number): Promise<void>;
  releaseInterface(num: number): Promise<void>;
  selectAlternateInterface(num: number, alt: number): Promise<void>;
  clearHalt(direction: 'in' | 'out', endpoint: number): Promise<void>;
  transferIn(endpoint: number, length: number): Promise<UsbTransferInResultLike>;
  transferOut(endpoint: number, data: BufferSource): Promise<unknown>;
}

function objectInfoDataset(
  storageId: number, format: number, size: number,
  filename: string, associationType: number,
): Uint8Array {
  const w = new Writer();
  w.u32(storageId);
  w.u16(format);
  w.u16(0); // protection
  w.u32(size);
  w.u16(0); w.u32(0); w.u32(0); w.u32(0); // thumb format/size/width/height
  w.u32(0); w.u32(0); w.u32(0); // image width/height/bit depth
  w.u32(0); // parent (taken from the command params)
  w.u16(associationType); w.u32(0); w.u32(0); // association type/desc, sequence number
  w.string(filename);
  w.string(''); // date created
  w.string(''); // date modified
  w.string(''); // keywords
  return w.build();
}

export interface MtpOpenOptions {
  /**
   * Milliseconds to wait for any single bulk-in read before giving up. A wrong
   * interface (a network or vendor pipe on a composite device) accepts the
   * command write but never answers, so without a bound the read hangs forever.
   * Default 5000.
   */
  readTimeoutMs?: number;
  /**
   * When more than one interface could be MTP, send a GetDeviceInfo probe and
   * keep the first that actually answers like PTP, instead of committing blind
   * to the first bulk pair. Default true. The probe uses a short timeout
   * (min(readTimeoutMs, 1500)) so scanning a few dead interfaces stays quick.
   */
  verify?: boolean;
}

export class MtpDevice {
  readonly device: UsbDeviceLike;
  log: (msg: string) => void = (msg) => console.log('[mtp-ts] ' + msg);
  private tid = 0;
  private ifaceNum = 0;
  private epIn = 0;
  private epOut = 0;
  private readTimeoutMs = 5000;

  constructor(usbDevice: UsbDeviceLike) {
    this.device = usbDevice;
  }

  async open(opts: MtpOpenOptions = {}): Promise<void> {
    const d = this.device;
    this.readTimeoutMs = opts.readTimeoutMs ?? 5000;
    const verify = opts.verify ?? true;
    await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    if (d.configuration === null) throw new Error('device has no active configuration');

    // Rank interfaces that expose a bulk in/out pair. score 2 = a real PTP/MTP
    // interface (class 6, or a name that says so); score 1 = a plausible vendor
    // interface we would only try as a last resort. Interfaces whose class is
    // known non-MTP (RNDIS, CDC, HID, mass storage, hub, ...) or that carry the
    // Android debug/accessory signature are dropped entirely.
    const candidates: {
      iface: UsbInterfaceLike; alt: UsbAlternateLike;
      bulkIn: UsbEndpointLike; bulkOut: UsbEndpointLike; score: number;
    }[] = [];
    const skipped: string[] = [];
    for (const iface of d.configuration.interfaces) {
      for (const alt of iface.alternates) {
        const bulkIn = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
        const bulkOut = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
        if (!bulkIn || !bulkOut) continue;
        const cls = alt.interfaceClass;
        const sub = alt.interfaceSubclass ?? 0;
        const proto = alt.interfaceProtocol ?? 0;
        const label = `if${iface.interfaceNumber} (class ${cls}/${sub}/${proto}${alt.interfaceName ? ` "${alt.interfaceName}"` : ''})`;
        if (NON_MTP_CLASSES.has(cls) || isAndroidDebugInterface(cls, sub, proto)) {
          skipped.push(label);
          continue;
        }
        const nameSaysMtp = /mtp|ptp/i.test(alt.interfaceName ?? '');
        const score = (cls === USB_CLASS_STILL_IMAGE || nameSaysMtp) ? 2 : 1;
        candidates.push({ iface, alt, bulkIn, bulkOut, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    if (skipped.length) this.log('skipped non-MTP interfaces: ' + skipped.join(', '));
    if (candidates.length === 0) {
      throw new Error('no MTP-capable interface found (only non-MTP interfaces present; this device likely does not expose MTP over USB)');
    }

    // With a single candidate, or verification off, commit to the best-scored
    // one. Otherwise probe each in order and keep the first that answers a
    // GetDeviceInfo like PTP, so a non-MTP vendor pipe can't silently win.
    const shouldProbe = verify && candidates.length > 1;
    const tried: string[] = [];
    for (const c of candidates) {
      const label = `if${c.iface.interfaceNumber} (class ${c.alt.interfaceClass}/${c.alt.interfaceSubclass ?? 0}/${c.alt.interfaceProtocol ?? 0})`;
      await this.bindInterface(c.iface, c.alt, c.bulkIn, c.bulkOut);
      if (!shouldProbe) {
        this.log(`interface ${this.ifaceNum} ep-in ${this.epIn} ep-out ${this.epOut}`);
        return;
      }
      const probeTimeout = Math.min(this.readTimeoutMs, 1500);
      if (await this.probeIsMtp(probeTimeout)) {
        this.log(`selected ${label} ep-in ${this.epIn} ep-out ${this.epOut}`);
        return;
      }
      this.log(`${label} did not answer MTP GetDeviceInfo, trying next`);
      tried.push(label);
      try { await d.releaseInterface(this.ifaceNum); } catch { /* keep scanning */ }
    }
    throw new Error('no interface responded to MTP GetDeviceInfo; tried ' + tried.join(', ') +
      ' — this device likely does not expose MTP over USB');
  }

  private async bindInterface(
    iface: UsbInterfaceLike, alt: UsbAlternateLike,
    bulkIn: UsbEndpointLike, bulkOut: UsbEndpointLike,
  ): Promise<void> {
    this.ifaceNum = iface.interfaceNumber;
    this.epIn = bulkIn.endpointNumber;
    this.epOut = bulkOut.endpointNumber;
    await this.device.claimInterface(this.ifaceNum);
    if (alt.alternateSetting !== 0) {
      await this.device.selectAlternateInterface(this.ifaceNum, alt.alternateSetting);
    }
  }

  // Send GetDeviceInfo and check for a well-formed PTP response, under a tight
  // timeout. Any error (timeout, stall, garbage) means "not MTP here".
  private async probeIsMtp(timeoutMs: number): Promise<boolean> {
    const saved = this.readTimeoutMs;
    this.readTimeoutMs = timeoutMs;
    this.tid = 0;
    try {
      const r = await this.transaction(OPS.GetDeviceInfo, []);
      return r.code === 0x2001 && r.data !== null && r.data.byteLength >= 12;
    } catch {
      return false;
    } finally {
      this.readTimeoutMs = saved;
    }
  }

  async close(): Promise<void> {
    try { await this.transaction(OPS.CloseSession, []); } catch { /* may not be open */ }
    try { await this.device.releaseInterface(this.ifaceNum); } catch { /* already gone */ }
    try { await this.device.close(); } catch { /* already gone */ }
  }

  private buildCommand(code: number, tid: number, params: number[]): ArrayBuffer {
    const buf = new ArrayBuffer(12 + params.length * 4);
    const dv = new DataView(buf);
    dv.setUint32(0, buf.byteLength, true);
    dv.setUint16(4, CONTAINER.COMMAND, true);
    dv.setUint16(6, code, true);
    dv.setUint32(8, tid, true);
    params.forEach((p, i) => dv.setUint32(12 + i * 4, p >>> 0, true));
    return buf;
  }

  // Race a bulk-in read against a timer. WebUSB can't cancel a pending
  // transfer, but the timeout lets us stop awaiting a pipe that will never
  // answer (a wrong interface, or a device that stopped responding) and surface
  // a clear error instead of hanging the page. close() releases the endpoint.
  private async readWithTimeout(len: number): Promise<UsbTransferInResultLike> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`bulk-in read timed out after ${this.readTimeoutMs}ms on endpoint ${this.epIn}`)),
        this.readTimeoutMs,
      );
    });
    try {
      return await Promise.race([this.device.transferIn(this.epIn, len), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async transferIn(len: number): Promise<Uint8Array> {
    let r = await this.readWithTimeout(len);
    if (r.status === 'stall') {
      this.log('bulk-in stall, clearing halt');
      await this.device.clearHalt('in', this.epIn);
      r = await this.readWithTimeout(len);
    }
    if (r.status !== 'ok' || !r.data) throw new Error('transferIn failed: ' + r.status);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  private async readContainer(): Promise<Container> {
    // First read must land the 12-byte header; skip zero-length packets.
    let first = await this.transferIn(16384);
    let zlp = 0;
    while (first.byteLength === 0 && zlp++ < 8) first = await this.transferIn(16384);
    if (first.byteLength < 12) throw new Error('short container: ' + first.byteLength + ' bytes');

    const head = new DataView(first.buffer, first.byteOffset, 12);
    const length = head.getUint32(0, true);
    const type = head.getUint16(4, true);
    const code = head.getUint16(6, true);
    const tid = head.getUint32(8, true);

    const parts = [first];
    let got = first.byteLength;
    while (got < length) {
      const chunk = await this.transferIn(Math.min(1 << 20, 16384 * Math.ceil((length - got) / 16384)));
      if (chunk.byteLength === 0) throw new Error('unexpected ZLP mid-container');
      parts.push(chunk);
      got += chunk.byteLength;
    }
    const full = new Uint8Array(got);
    let off = 0;
    for (const p of parts) { full.set(p, off); off += p.byteLength; }
    return { length, type, code, tid, payload: full.subarray(12, length) };
  }

  async transaction(op: number, params: number[] = [], dataOut: Uint8Array | null = null): Promise<TransactionResult> {
    const tid = this.tid++;
    await this.device.transferOut(this.epOut, this.buildCommand(op, tid, params));
    if (dataOut) {
      const buf = new Uint8Array(12 + dataOut.byteLength);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, buf.byteLength, true);
      dv.setUint16(4, CONTAINER.DATA, true);
      dv.setUint16(6, op, true);
      dv.setUint32(8, tid, true);
      buf.set(dataOut, 12);
      await this.device.transferOut(this.epOut, buf);
    }
    let data: Uint8Array | null = null;
    let c = await this.readContainer();
    if (c.type === CONTAINER.DATA) {
      data = c.payload;
      c = await this.readContainer();
    }
    if (c.type !== CONTAINER.RESPONSE) throw new Error('expected response container, got type ' + c.type);
    if (c.tid !== tid) throw new Error(`response tid ${c.tid} does not match command tid ${tid} (stale container on pipe?)`);
    const rparams: number[] = [];
    const rv = new Reader(c.payload);
    for (let i = 0; i + 4 <= c.payload.byteLength; i += 4) rparams.push(rv.u32());
    return { code: c.code, params: rparams, data };
  }

  async expectOk(op: number, params: number[] = [], dataOut: Uint8Array | null = null): Promise<TransactionResult> {
    const r = await this.transaction(op, params, dataOut);
    if (r.code !== 0x2001) {
      throw new Error(`op 0x${op.toString(16)} failed: ${rcName(r.code)}`);
    }
    return r;
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const r = await this.expectOk(OPS.GetDeviceInfo, []);
    const rd = new Reader(r.data!);
    return {
      standardVersion: rd.u16(),
      vendorExtensionID: rd.u32(),
      vendorExtensionVersion: rd.u16(),
      vendorExtensionDesc: rd.string(),
      functionalMode: rd.u16(),
      operationsSupported: rd.au16(),
      eventsSupported: rd.au16(),
      devicePropertiesSupported: rd.au16(),
      captureFormats: rd.au16(),
      playbackFormats: rd.au16(),
      manufacturer: rd.string(),
      model: rd.string(),
      deviceVersion: rd.string(),
      serialNumber: rd.string(),
    };
  }

  async openSession(): Promise<void> {
    this.tid = 0;
    const r = await this.transaction(OPS.OpenSession, [1]);
    if (r.code === 0x201e) {
      this.log('session already open, closing and reopening');
      await this.transaction(OPS.CloseSession, []);
      this.tid = 0;
      await this.expectOk(OPS.OpenSession, [1]);
    } else if (r.code !== 0x2001) {
      throw new Error('OpenSession failed: ' + rcName(r.code));
    }
  }

  async getStorageIDs(): Promise<number[]> {
    const r = await this.expectOk(OPS.GetStorageIDs, []);
    return new Reader(r.data!).au32();
  }

  async getStorageInfo(storageId: number): Promise<StorageInfo> {
    const r = await this.expectOk(OPS.GetStorageInfo, [storageId]);
    const rd = new Reader(r.data!);
    return {
      id: storageId,
      storageType: rd.u16(),
      filesystemType: rd.u16(),
      accessCapability: rd.u16(),
      maxCapacity: rd.u64(),
      freeSpace: rd.u64(),
      freeSpaceObjects: rd.u32(),
      description: rd.string(),
      volumeLabel: rd.string(),
    };
  }

  async getObjectHandles(storageId: number, parent: number = ROOT_PARENT): Promise<number[]> {
    const r = await this.expectOk(OPS.GetObjectHandles, [storageId, 0, parent]);
    return new Reader(r.data!).au32();
  }

  async getObjectInfo(handle: number): Promise<ObjectInfo> {
    const r = await this.expectOk(OPS.GetObjectInfo, [handle]);
    const rd = new Reader(r.data!);
    const storageId = rd.u32();
    const format = rd.u16();
    const protection = rd.u16();
    const size = rd.u32();
    rd.u16(); // thumb format
    rd.u32(); // thumb size
    rd.u32(); // thumb width
    rd.u32(); // thumb height
    rd.u32(); // image width
    rd.u32(); // image height
    rd.u32(); // image bit depth
    const parent = rd.u32();
    const associationType = rd.u16();
    rd.u32(); // association desc
    rd.u32(); // sequence number
    const filename = rd.string();
    const dateCreated = rd.string();
    const dateModified = rd.string();
    return {
      handle, storageId, format, protection, size, parent, associationType,
      filename, dateCreated, dateModified, isFolder: format === FMT_ASSOCIATION,
    };
  }

  // Receive a file: returns its bytes.
  async getObject(handle: number): Promise<Uint8Array> {
    const r = await this.expectOk(OPS.GetObject, [handle]);
    return r.data ?? new Uint8Array(0);
  }

  // Send a file. SendObjectInfo tells the responder what is coming and where
  // (storage + parent); SendObject must follow immediately with the bytes.
  // Returns the new object handle.
  async sendObject(
    storageId: number, parent: number, filename: string,
    bytes: Uint8Array, format: number | null = null,
  ): Promise<number> {
    const dataset = objectInfoDataset(storageId, format ?? formatForName(filename), bytes.byteLength, filename, 0);
    const info = await this.expectOk(OPS.SendObjectInfo, [storageId, parent], dataset);
    const handle = info.params[2];
    if (handle === undefined) throw new Error('SendObjectInfo returned no object handle');
    await this.expectOk(OPS.SendObject, [], bytes);
    return handle;
  }

  // Create a folder: an association object is SendObjectInfo alone, no data
  // phase follows. Returns the new folder's handle.
  async createFolder(storageId: number, parent: number, name: string): Promise<number> {
    const dataset = objectInfoDataset(storageId, FMT_ASSOCIATION, 0, name, 1 /* generic folder */);
    const info = await this.expectOk(OPS.SendObjectInfo, [storageId, parent], dataset);
    const handle = info.params[2];
    if (handle === undefined) throw new Error('SendObjectInfo returned no object handle');
    return handle;
  }

  async deleteObject(handle: number): Promise<void> {
    await this.expectOk(OPS.DeleteObject, [handle, 0]);
  }
}
