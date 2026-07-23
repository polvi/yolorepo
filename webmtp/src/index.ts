export * from './mtp';
export * from './fs';

import { MtpDevice, type UsbDeviceLike } from './mtp';

interface UsbLike {
  getDevices(): Promise<UsbDeviceLike[]>;
  requestDevice(options: { filters: unknown[] }): Promise<UsbDeviceLike>;
}

function usb(): UsbLike | null {
  const nav = globalThis.navigator as { usb?: UsbLike } | undefined;
  return nav?.usb ?? null;
}

/** True when this browser exposes WebUSB (Chromium in a secure context). */
export function usbSupported(): boolean {
  return usb() !== null;
}

/** A device the user has already granted, if any — no picker, no gesture needed. */
export async function getGrantedMtpDevice(): Promise<UsbDeviceLike | null> {
  const u = usb();
  if (!u) return null;
  const devices = await u.getDevices();
  return devices[0] ?? null;
}

/** Show the browser device picker. Must be called from a user gesture. */
export async function requestMtpDevice(): Promise<UsbDeviceLike> {
  const u = usb();
  if (!u) throw new Error('WebUSB is not available in this browser');
  return u.requestDevice({ filters: [] });
}

/** Open the device and an MTP session; ready for transactions. */
export async function connectMtp(device: UsbDeviceLike): Promise<MtpDevice> {
  const mtp = new MtpDevice(device);
  await mtp.open();
  await mtp.openSession();
  return mtp;
}

/** Storage IDs whose media is actually present (low word non-zero). */
export function mountedStorageIds(ids: number[]): number[] {
  return ids.filter((id) => (id & 0xffff) !== 0);
}
