'use strict';

// Minimal MTP (Media Transfer Protocol) over WebUSB.
// MTP rides on the PTP (ISO 15740) USB transport: 12-byte containers over
// a pair of bulk endpoints. Container: length u32, type u16, code u16,
// transactionID u32, then payload.

const OPS = {
  GetDeviceInfo: 0x1001,
  OpenSession: 0x1002,
  CloseSession: 0x1003,
  GetStorageIDs: 0x1004,
  GetStorageInfo: 0x1005,
  GetNumObjects: 0x1006,
  GetObjectHandles: 0x1007,
  GetObjectInfo: 0x1008,
  GetObject: 0x1009,
  DeleteObject: 0x100B,
  SendObjectInfo: 0x100C,
  SendObject: 0x100D,
};

const CONTAINER = { COMMAND: 1, DATA: 2, RESPONSE: 3, EVENT: 4 };

const RC_NAMES = {
  0x2001: 'OK',
  0x2002: 'GeneralError',
  0x2003: 'SessionNotOpen',
  0x2005: 'OperationNotSupported',
  0x2006: 'ParameterNotSupported',
  0x2007: 'IncompleteTransfer',
  0x2009: 'InvalidObjectHandle',
  0x200C: 'StoreFull',
  0x200D: 'ObjectWriteProtected',
  0x2013: 'StoreNotAvailable',
  0x2015: 'NoValidObjectInfo',
  0x2019: 'DeviceBusy',
  0x201D: 'InvalidParameter',
  0x201E: 'SessionAlreadyOpen',
};

const FMT_ASSOCIATION = 0x3001; // folder

const EXT_FORMATS = {
  txt: 0x3004, html: 0x3005, htm: 0x3005, wav: 0x3008, mp3: 0x3009,
  avi: 0x300A, mpg: 0x300B, jpg: 0x3801, jpeg: 0x3801, gif: 0x3807,
  png: 0x380B, tiff: 0x380D, wma: 0xB901, mp4: 0xB982,
};

function formatForName(name) {
  const ext = name.toLowerCase().split('.').pop();
  return EXT_FORMATS[ext] || 0x3000; // undefined/binary
}

function rcName(code) {
  return RC_NAMES[code] || '0x' + code.toString(16);
}

class Reader {
  constructor(u8) {
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.o = 0;
  }
  u8() { const v = this.dv.getUint8(this.o); this.o += 1; return v; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  u64() {
    const lo = this.u32(), hi = this.u32();
    return hi * 0x100000000 + lo;
  }
  // PTP string: u8 char count (incl. null terminator), then UTF-16LE chars.
  string() {
    const n = this.u8();
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = this.u16();
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s;
  }
  au16() {
    const n = this.u32();
    const a = [];
    for (let i = 0; i < n; i++) a.push(this.u16());
    return a;
  }
  au32() {
    const n = this.u32();
    const a = [];
    for (let i = 0; i < n; i++) a.push(this.u32());
    return a;
  }
}

class Writer {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xFF); }
  u16(v) { this.u8(v); this.u8(v >> 8); }
  u32(v) { this.u16(v); this.u16(v >>> 16); }
  string(s) {
    if (!s) { this.u8(0); return; }
    this.u8(s.length + 1); // char count including null terminator
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    this.u16(0);
  }
  build() { return new Uint8Array(this.bytes); }
}

class MtpDevice {
  constructor(usbDevice) {
    this.device = usbDevice;
    this.tid = 0;
    this.ifaceNum = null;
    this.epIn = null;
    this.epOut = null;
    this.log = (msg) => console.log('[webmtp] ' + msg);
  }

  async open() {
    const d = this.device;
    await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);

    // Find the PTP/MTP interface: class 6 (still image), or failing that any
    // alternate exposing a bulk-in/bulk-out pair.
    let match = null;
    for (const iface of d.configuration.interfaces) {
      for (const alt of iface.alternates) {
        const bulkIn = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
        const bulkOut = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
        if (!bulkIn || !bulkOut) continue;
        const isPtp = alt.interfaceClass === 6;
        if (isPtp || !match) {
          match = { iface, alt, bulkIn, bulkOut, isPtp };
          if (isPtp) break;
        }
      }
      if (match && match.isPtp) break;
    }
    if (!match) throw new Error('no interface with bulk in/out endpoints found');

    this.ifaceNum = match.iface.interfaceNumber;
    this.epIn = match.bulkIn.endpointNumber;
    this.epOut = match.bulkOut.endpointNumber;
    this.log(`interface ${this.ifaceNum} (class ${match.alt.interfaceClass}) ep-in ${this.epIn} ep-out ${this.epOut}`);
    await d.claimInterface(this.ifaceNum);
    if (match.alt.alternateSetting !== 0) {
      await d.selectAlternateInterface(this.ifaceNum, match.alt.alternateSetting);
    }
  }

  async close() {
    try { await this.transaction(OPS.CloseSession, []); } catch (e) {}
    try { await this.device.releaseInterface(this.ifaceNum); } catch (e) {}
    try { await this.device.close(); } catch (e) {}
  }

  buildCommand(code, tid, params) {
    const buf = new ArrayBuffer(12 + params.length * 4);
    const dv = new DataView(buf);
    dv.setUint32(0, buf.byteLength, true);
    dv.setUint16(4, CONTAINER.COMMAND, true);
    dv.setUint16(6, code, true);
    dv.setUint32(8, tid, true);
    params.forEach((p, i) => dv.setUint32(12 + i * 4, p >>> 0, true));
    return buf;
  }

  async transferIn(len) {
    const r = await this.device.transferIn(this.epIn, len);
    if (r.status === 'stall') {
      this.log('bulk-in stall, clearing halt');
      await this.device.clearHalt('in', this.epIn);
      const retry = await this.device.transferIn(this.epIn, len);
      if (retry.status !== 'ok') throw new Error('transferIn failed after clearHalt: ' + retry.status);
      return new Uint8Array(retry.data.buffer, retry.data.byteOffset, retry.data.byteLength);
    }
    if (r.status !== 'ok') throw new Error('transferIn failed: ' + r.status);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async readContainer() {
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
      if (chunk.byteLength === 0 && got < length) throw new Error('unexpected ZLP mid-container');
      parts.push(chunk);
      got += chunk.byteLength;
    }
    const full = new Uint8Array(got);
    let off = 0;
    for (const p of parts) { full.set(p, off); off += p.byteLength; }
    return { length, type, code, tid, payload: full.subarray(12, length) };
  }

  async transaction(op, params = [], dataOut = null) {
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
    let data = null;
    let c = await this.readContainer();
    if (c.type === CONTAINER.DATA) {
      data = c.payload;
      c = await this.readContainer();
    }
    if (c.type !== CONTAINER.RESPONSE) throw new Error('expected response container, got type ' + c.type);
    if (c.tid !== tid) throw new Error(`response tid ${c.tid} does not match command tid ${tid} (stale container on pipe?)`);
    const rparams = [];
    const rv = new Reader(c.payload);
    for (let i = 0; i + 4 <= c.payload.byteLength; i += 4) rparams.push(rv.u32());
    return { code: c.code, params: rparams, data };
  }

  async expectOk(op, params, dataOut = null) {
    const r = await this.transaction(op, params, dataOut);
    if (r.code !== 0x2001) {
      throw new Error(`op 0x${op.toString(16)} failed: ${rcName(r.code)}`);
    }
    return r;
  }

  async getDeviceInfo() {
    const r = await this.expectOk(OPS.GetDeviceInfo, []);
    const rd = new Reader(r.data);
    const info = {};
    info.standardVersion = rd.u16();
    info.vendorExtensionID = rd.u32();
    info.vendorExtensionVersion = rd.u16();
    info.vendorExtensionDesc = rd.string();
    info.functionalMode = rd.u16();
    info.operationsSupported = rd.au16();
    info.eventsSupported = rd.au16();
    info.devicePropertiesSupported = rd.au16();
    info.captureFormats = rd.au16();
    info.playbackFormats = rd.au16();
    info.manufacturer = rd.string();
    info.model = rd.string();
    info.deviceVersion = rd.string();
    info.serialNumber = rd.string();
    return info;
  }

  async openSession() {
    this.tid = 0;
    const r = await this.transaction(OPS.OpenSession, [1]);
    if (r.code === 0x201E) {
      this.log('session already open, closing and reopening');
      await this.transaction(OPS.CloseSession, []);
      this.tid = 0;
      await this.expectOk(OPS.OpenSession, [1]);
    } else if (r.code !== 0x2001) {
      throw new Error('OpenSession failed: ' + rcName(r.code));
    }
  }

  async getStorageIDs() {
    const r = await this.expectOk(OPS.GetStorageIDs, []);
    return new Reader(r.data).au32();
  }

  async getStorageInfo(storageID) {
    const r = await this.expectOk(OPS.GetStorageInfo, [storageID]);
    const rd = new Reader(r.data);
    const s = { id: storageID };
    s.storageType = rd.u16();
    s.filesystemType = rd.u16();
    s.accessCapability = rd.u16();
    s.maxCapacity = rd.u64();
    s.freeSpace = rd.u64();
    s.freeSpaceObjects = rd.u32();
    s.description = rd.string();
    s.volumeLabel = rd.string();
    return s;
  }

  async getObjectHandles(storageID, parent = 0xFFFFFFFF) {
    const r = await this.expectOk(OPS.GetObjectHandles, [storageID, 0, parent]);
    return new Reader(r.data).au32();
  }

  async getObjectInfo(handle) {
    const r = await this.expectOk(OPS.GetObjectInfo, [handle]);
    const rd = new Reader(r.data);
    const o = { handle };
    o.storageID = rd.u32();
    o.format = rd.u16();
    o.protection = rd.u16();
    o.size = rd.u32();
    rd.u16(); // thumb format
    rd.u32(); // thumb size
    rd.u32(); // thumb width
    rd.u32(); // thumb height
    rd.u32(); // image width
    rd.u32(); // image height
    rd.u32(); // image bit depth
    o.parent = rd.u32();
    o.associationType = rd.u16();
    rd.u32(); // association desc
    rd.u32(); // sequence number
    o.filename = rd.string();
    o.dateCreated = rd.string();
    o.dateModified = rd.string();
    o.isFolder = o.format === FMT_ASSOCIATION;
    return o;
  }

  // Receive a file: returns its bytes.
  async getObject(handle) {
    const r = await this.expectOk(OPS.GetObject, [handle]);
    return r.data;
  }

  // Send a file. SendObjectInfo tells the responder what is coming and where
  // (storage + parent); SendObject must follow immediately with the bytes.
  // Returns the new object handle.
  async sendObject(storageID, parent, filename, bytes, format = null) {
    const w = new Writer();
    w.u32(storageID);
    w.u16(format ?? formatForName(filename));
    w.u16(0); // protection
    w.u32(bytes.byteLength);
    w.u16(0); w.u32(0); w.u32(0); w.u32(0); // thumb format/size/width/height
    w.u32(0); w.u32(0); w.u32(0); // image width/height/bit depth
    w.u32(0); // parent (taken from the command params)
    w.u16(0); w.u32(0); w.u32(0); // association type/desc, sequence number
    w.string(filename);
    w.string(''); // date created
    w.string(''); // date modified
    w.string(''); // keywords
    const info = await this.expectOk(OPS.SendObjectInfo, [storageID, parent], w.build());
    const handle = info.params[2];
    await this.expectOk(OPS.SendObject, [], bytes);
    return handle;
  }

  async deleteObject(handle) {
    await this.expectOk(OPS.DeleteObject, [handle, 0]);
  }
}

window.MtpDevice = MtpDevice;
window.MTP_OPS = OPS;
