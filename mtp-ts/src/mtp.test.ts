import { describe, expect, test } from 'bun:test';
import {
  MtpDevice,
  type UsbAlternateLike,
  type UsbConfigurationLike,
  type UsbDeviceLike,
  type UsbInterfaceLike,
  type UsbTransferInResultLike,
} from './mtp';

// A bulk in/out endpoint pair on the given endpoint number.
function bulkPair(n: number) {
  return [
    { endpointNumber: n, direction: 'in', type: 'bulk' },
    { endpointNumber: n, direction: 'out', type: 'bulk' },
  ];
}

function iface(
  num: number, cls: number, sub: number, proto: number,
  endpoints: { endpointNumber: number; direction: string; type: string }[],
  name?: string,
): UsbInterfaceLike {
  const alt: UsbAlternateLike = {
    alternateSetting: 0, interfaceClass: cls, interfaceSubclass: sub,
    interfaceProtocol: proto, interfaceName: name, endpoints,
  };
  return { interfaceNumber: num, alternates: [alt] };
}

// A GetDeviceInfo DATA container (type 2) followed by an OK RESPONSE container
// (type 3, code 0x2001), which is what a real MTP interface answers.
function ptpDeviceInfoReplies(): DataView[] {
  const data = new ArrayBuffer(12 + 16); // header + >=12 bytes of dataset
  const ddv = new DataView(data);
  ddv.setUint32(0, data.byteLength, true);
  ddv.setUint16(4, 2, true);      // DATA
  ddv.setUint16(6, 0x1001, true); // GetDeviceInfo
  ddv.setUint32(8, 0, true);      // tid 0

  const resp = new ArrayBuffer(12);
  const rdv = new DataView(resp);
  rdv.setUint32(0, 12, true);
  rdv.setUint16(4, 3, true);      // RESPONSE
  rdv.setUint16(6, 0x2001, true); // OK
  rdv.setUint32(8, 0, true);      // tid 0
  return [ddv, rdv];
}

interface FakeOpts {
  config: UsbConfigurationLike;
  // interfaceNumbers that answer GetDeviceInfo like a real MTP device
  respondingIfaces: Set<number>;
  // interfaceNumbers whose bulk-in read never returns (forces the timeout path)
  hangingIfaces?: Set<number>;
}

// Minimal UsbDeviceLike whose reads depend on which interface is claimed,
// modelling a composite gadget where only some interfaces speak MTP.
class FakeDevice implements UsbDeviceLike {
  productName = 'FakeGadget';
  configuration: UsbConfigurationLike | null;
  claimed: number | null = null;
  claimLog: number[] = [];
  private replies: DataView[] = [];
  constructor(private o: FakeOpts) { this.configuration = o.config; }

  async open() {}
  async close() {}
  async selectConfiguration() {}
  async claimInterface(num: number) { this.claimed = num; this.claimLog.push(num); this.replies = []; }
  async releaseInterface(num: number) { if (this.claimed === num) this.claimed = null; }
  async selectAlternateInterface() {}
  async clearHalt() {}

  async transferOut(_ep: number, data: BufferSource): Promise<unknown> {
    const dv = new DataView(
      data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer,
    );
    const code = dv.getUint16(6, true);
    if (code === 0x1001 && this.claimed !== null && this.o.respondingIfaces.has(this.claimed)) {
      this.replies.push(...ptpDeviceInfoReplies());
    }
    return { status: 'ok', bytesWritten: dv.getUint32(0, true) };
  }

  async transferIn(_ep: number, _len: number): Promise<UsbTransferInResultLike> {
    if (this.claimed !== null && this.o.hangingIfaces?.has(this.claimed)) {
      return new Promise<UsbTransferInResultLike>(() => {}); // never resolves
    }
    const next = this.replies.shift();
    if (next) return { status: 'ok', data: next };
    return new Promise<UsbTransferInResultLike>(() => {}); // no scripted reply -> hang
  }
}

// The real Autel EVO composite: RNDIS control + CDC data + 4 vendor bulk
// interfaces + ADB. No PTP/MTP interface anywhere.
function evoConfig(): UsbConfigurationLike {
  return {
    interfaces: [
      iface(0, 0xe0, 0x01, 0x03, [{ endpointNumber: 2, direction: 'in', type: 'interrupt' }]), // RNDIS ctrl
      iface(1, 0x0a, 0x00, 0x00, bulkPair(1)), // CDC data (RNDIS data pipe)
      iface(2, 0xff, 0x00, 0x00, bulkPair(3)), // vendor
      iface(3, 0xff, 0x00, 0x00, bulkPair(4)), // vendor
      iface(4, 0xff, 0x00, 0x00, bulkPair(5)), // vendor
      iface(5, 0xff, 0x00, 0x00, bulkPair(6)), // vendor
      iface(6, 0xff, 0x42, 0x01, bulkPair(7)), // ADB
    ],
  };
}

describe('MtpDevice.open interface selection', () => {
  test('EVO composite (no MTP) fails fast with a clear error, never hangs', async () => {
    const dev = new FakeDevice({
      config: evoConfig(),
      respondingIfaces: new Set(),          // nothing speaks MTP
      hangingIfaces: new Set([2, 3, 4, 5]), // vendor pipes accept the write, never answer
    });
    const mtp = new MtpDevice(dev);
    mtp.log = () => {};
    const started = Date.now();
    await expect(mtp.open({ readTimeoutMs: 100 })).rejects.toThrow(/does not expose MTP|did not|no interface/i);
    // 4 vendor candidates probed at 100ms each; must resolve quickly, not hang.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('never claims the RNDIS or ADB interface', async () => {
    const dev = new FakeDevice({
      config: evoConfig(),
      respondingIfaces: new Set(),
      hangingIfaces: new Set([2, 3, 4, 5]),
    });
    const mtp = new MtpDevice(dev);
    mtp.log = () => {};
    await mtp.open({ readTimeoutMs: 50 }).catch(() => {});
    // if1 (CDC/RNDIS data) and if6 (ADB) must never have been claimed at all.
    expect(dev.claimLog).not.toContain(1);
    expect(dev.claimLog).not.toContain(6);
    // only the vendor candidates should have been probed.
    expect(dev.claimLog).toEqual([2, 3, 4, 5]);
  });

  test('selects a real class-6 PTP interface directly', async () => {
    const config: UsbConfigurationLike = {
      interfaces: [
        iface(0, 0xe0, 0x01, 0x03, [{ endpointNumber: 1, direction: 'in', type: 'interrupt' }]),
        iface(1, 0x0a, 0x00, 0x00, bulkPair(1)),
        iface(2, 0x06, 0x01, 0x01, bulkPair(2), 'MTP'), // real PTP/MTP
      ],
    };
    const dev = new FakeDevice({ config, respondingIfaces: new Set([2]) });
    const mtp = new MtpDevice(dev);
    mtp.log = () => {};
    await mtp.open({ readTimeoutMs: 500 });
    expect(dev.claimed).toBe(2);
  });

  test('probe skips a dead vendor pipe and picks the responding one', async () => {
    const config: UsbConfigurationLike = {
      interfaces: [
        iface(0, 0xff, 0x00, 0x00, bulkPair(1)), // vendor, dead
        iface(1, 0xff, 0x00, 0x00, bulkPair(2)), // vendor, real MTP
      ],
    };
    const dev = new FakeDevice({
      config,
      respondingIfaces: new Set([1]),
      hangingIfaces: new Set([0]),
    });
    const mtp = new MtpDevice(dev);
    mtp.log = () => {};
    await mtp.open({ readTimeoutMs: 200 });
    expect(dev.claimed).toBe(1);
  });
});
