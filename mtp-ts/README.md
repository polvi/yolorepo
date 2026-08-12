# mtp-ts

MTP (Media Transfer Protocol) over WebUSB, as a TypeScript library. Talk to
Android phones, e-readers, and other MTP devices directly from a browser page
(Chromium, secure context): list storages, walk folders, read and write files.

Try it live at [mtp.proc.io](https://mtp.proc.io) — a file browser
(browse, upload, download, new folder, delete) running entirely client-side.

Verified byte-exact against real hardware. The session/transaction state
machine is modeled in TLA+ (`specs/`) and checked with TLC.

## Layout

- `src/mtp.ts` — protocol core: PTP containers, transactions, sessions,
  `MtpDevice` (open/close, GetDeviceInfo, storage IDs, object listing,
  upload/download/delete).
- `src/fs.ts` — `MtpFs`, a path-based layer on top: `readdir`, `stat`,
  `readFile`, `writeFile`, `mkdirp`, `rm`, with overwrite semantics suited to
  sync use cases.
- `src/index.ts` — WebUSB helpers: device picking, permission checks,
  `connectMtp()`.
- `demo/` — a file browser exercising the whole library.
- `specs/` — TLA+ model of the session/transaction machine (`mtp.tla`), with
  the TLC config that passes (`mtp.cfg`).

## Use

The package ships raw TypeScript (`exports` points at `src/index.ts`), so
consume it from a TS-aware bundler (Vite, bun). Depend on it by path:

```json
"dependencies": { "mtp-ts": "file:../mtp-ts" }
```

```ts
import {
  usbSupported, requestMtpDevice, connectMtp, mountedStorageIds, MtpFs,
} from 'mtp-ts';

if (!usbSupported()) throw new Error('needs WebUSB');
const device = await requestMtpDevice(); // must be called from a user gesture
const mtp = await connectMtp(device);

const [storageId] = mountedStorageIds(await mtp.getStorageIDs());
const fs = new MtpFs(mtp, storageId);
for (const entry of await fs.readdir('/')) console.log(entry.filename);
await fs.writeFile('/Books/notes.txt', new TextEncoder().encode('hello'));
await mtp.close();
```

## Interface selection

A device you pick in the WebUSB dialog is often a composite gadget exposing
several interfaces. `open()` looks for the MTP/PTP one and refuses the rest:

- Prefers a still-image interface (USB class 6) or one whose name says MTP/PTP.
- Never claims interfaces that carry bulk endpoints but never speak MTP —
  RNDIS/CDC networking, HID, mass storage, hubs, and the Android debug/accessory
  signatures (ADB `FF/42/01`, fastboot `FF/42/03`, AOA `FF/FF/00`).
- When only vendor-specific candidates remain, it probes each with a
  `GetDeviceInfo` under a short timeout and keeps the first that answers like
  PTP, instead of committing blind to the first bulk pair.
- If nothing responds, it throws a clear error rather than hanging — reads are
  bounded by `readTimeoutMs` (default 5000).

Some devices (e.g. many Autel drones) present their SD card only as USB Mass
Storage and expose no MTP interface at all; against those `open()` now fails
fast with "does not expose MTP over USB" instead of freezing the page.

```ts
const mtp = await connectMtp(device, { readTimeoutMs: 8000, verify: true });
```

## Demo

```sh
bun install
bun serve.ts   # file browser on http://localhost:8321
```

Plug in an MTP device (an Android phone with file transfer enabled, or a USB
e-reader), click connect, and browse.

## Test

```sh
bun test   # interface-selection unit tests (mocked composite gadgets)
```

## Deploy

The demo deploys as a static-assets Cloudflare Worker at
[mtp.proc.io](https://mtp.proc.io):

```sh
bun run deploy   # bundles demo + index.html into dist/, then wrangler deploy
```
