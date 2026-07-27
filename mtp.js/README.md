# mtp.js

MTP (Media Transfer Protocol) over WebUSB, as a TypeScript library. Talk to
Android phones, e-readers, and other MTP devices directly from a browser page
(Chromium, secure context): list storages, walk folders, read and write files.

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
"dependencies": { "mtp.js": "file:../mtp.js" }
```

```ts
import {
  usbSupported, requestMtpDevice, connectMtp, mountedStorageIds, MtpFs,
} from 'mtp.js';

if (!usbSupported()) throw new Error('needs WebUSB');
const device = await requestMtpDevice(); // must be called from a user gesture
const mtp = await connectMtp(device);

const [storageId] = mountedStorageIds(await mtp.getStorageIDs());
const fs = new MtpFs(mtp, storageId);
for (const entry of await fs.readdir('/')) console.log(entry.filename);
await fs.writeFile('/Books/notes.txt', new TextEncoder().encode('hello'));
await mtp.close();
```

## Demo

```sh
bun install
bun serve.ts   # file browser on http://localhost:8321
```

Plug in an MTP device (an Android phone with file transfer enabled, or a USB
e-reader), click connect, and browse.
