// Research/demo UI for the mtp-ts library: file browser with folder
// navigation, transfers both directions, and an automation surface on window.

import {
  MtpDevice, MtpFs, ROOT_PARENT, connectMtp, getGrantedMtpDevice,
  mountedStorageIds, requestMtpDevice, usbSupported,
  type ObjectInfo, type StorageInfo,
} from '../src/index';

type StorageView = StorageInfo & { objects: ObjectInfo[] };

interface AppState {
  status: string;
  error: string | null;
  deviceInfo: unknown;
  storages: StorageView[];
  cwd: { storageId: number; path: { handle: number; name: string }[] } | null;
  cwdObjects: ObjectInfo[];
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const state: AppState = {
  status: 'idle', error: null, deviceInfo: null, storages: [], cwd: null, cwdObjects: [],
};
declare global {
  interface Window {
    __mtp: AppState;
    __mtpDevice: MtpDevice;
    __mtpApi: Record<string, unknown>;
  }
}
window.__mtp = state;

let mtp: MtpDevice | null = null;
let fsBySid = new Map<number, MtpFs>();

function log(msg: string): void {
  console.log('[mtp-ts] ' + msg);
  $('log').textContent += msg + '\n';
  $('log').scrollTop = $('log').scrollHeight;
}
function setStatus(s: string): void {
  state.status = s;
  state.error = null;
  $('status').textContent = s;
  log('status: ' + s);
}
function fail(e: unknown): void {
  state.error = String(e);
  state.status = 'error';
  $('status').textContent = 'error: ' + (e instanceof Error ? e.message : String(e));
  console.error('[mtp-ts]', e);
  if (/claim/i.test(String(e))) {
    log('hint: on macOS another process may hold the PTP interface (ptpcamerad / Image Capture / Photos).');
  }
}
function fmtSize(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GiB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MiB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
  return n + ' B';
}

function storageById(id: number): StorageView | undefined {
  return state.storages.find((s) => s.id === id);
}
function breadcrumbText(): string {
  if (!state.cwd) return '/';
  const s = storageById(state.cwd.storageId);
  return '/' + [s ? (s.description || s.volumeLabel || 'storage') : '?',
                ...state.cwd.path.map((p) => p.name)].join('/');
}

function renderCrumbs(): void {
  const el = $('crumbs');
  el.innerHTML = '';
  const rootLink = document.createElement('a');
  rootLink.textContent = 'device';
  rootLink.onclick = () => { navigateTo(null).catch(fail); };
  el.appendChild(rootLink);
  if (!state.cwd) return;
  const s = storageById(state.cwd.storageId);
  const segs = [{ name: s ? (s.description || s.volumeLabel || 'storage') : '?', depth: 0 },
                ...state.cwd.path.map((p, i) => ({ name: p.name, depth: i + 1 }))];
  for (const seg of segs) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    el.appendChild(sep);
    if (seg.depth === segs.length - 1) {
      const here = document.createElement('span');
      here.className = 'here';
      here.textContent = seg.name;
      el.appendChild(here);
    } else {
      const a = document.createElement('a');
      a.textContent = seg.name;
      a.onclick = () => { navigateTo(seg.depth).catch(fail); };
      el.appendChild(a);
    }
  }
}

function objectTable(storageId: number, objects: ObjectInfo[]): HTMLTableElement {
  const table = document.createElement('table');
  table.innerHTML = '<tr><th>name</th><th>type</th><th>size</th><th>modified</th><th></th></tr>';
  const sorted = [...objects].sort((a, b) =>
    (Number(b.isFolder) - Number(a.isFolder)) || a.filename.localeCompare(b.filename));
  for (const o of sorted) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    if (o.isFolder) {
      const a = document.createElement('a');
      a.className = 'folder';
      a.textContent = o.filename + '/';
      a.onclick = () => { enterFolder(storageId, o).catch(fail); };
      name.appendChild(a);
    } else {
      name.textContent = o.filename;
    }
    tr.appendChild(name);
    const type = document.createElement('td');
    type.textContent = o.isFolder ? 'folder' : '0x' + o.format.toString(16);
    tr.appendChild(type);
    const size = document.createElement('td');
    size.textContent = o.isFolder ? '' : fmtSize(o.size);
    tr.appendChild(size);
    const mod = document.createElement('td');
    mod.textContent = o.dateModified || '';
    tr.appendChild(mod);
    const act = document.createElement('td');
    if (!o.isFolder) {
      const get = document.createElement('a');
      get.className = 'act';
      get.textContent = 'get';
      get.onclick = () => { downloadObject(o).catch(fail); };
      act.appendChild(get);
      act.appendChild(document.createTextNode(' '));
    }
    const del = document.createElement('a');
    del.className = 'act danger';
    del.textContent = 'del';
    del.onclick = () => {
      const what = o.isFolder ? o.filename + '/ (and its contents)' : o.filename;
      if (confirm('Delete ' + what + ' from the device?')) {
        deleteObject(o).catch(fail);
      }
    };
    act.appendChild(del);
    tr.appendChild(act);
    table.appendChild(tr);
  }
  return table;
}

function render(): void {
  renderCrumbs();
  const el = $('listing');
  el.innerHTML = '';
  if (state.cwd) {
    el.appendChild(objectTable(state.cwd.storageId, state.cwdObjects));
    return;
  }
  for (const s of state.storages) {
    const head = document.createElement('div');
    head.className = 'storage-head';
    head.textContent = `storage 0x${s.id.toString(16)} — ${s.description || s.volumeLabel || '(unnamed)'} ` +
      `(${fmtSize(s.freeSpace)} free of ${fmtSize(s.maxCapacity)})`;
    el.appendChild(head);
    el.appendChild(objectTable(s.id, s.objects));
  }
}

async function listObjects(storageId: number, parent: number): Promise<ObjectInfo[]> {
  const handles = await mtp!.getObjectHandles(storageId, parent);
  const capped = handles.slice(0, 500);
  const objects: ObjectInfo[] = [];
  for (const h of capped) objects.push(await mtp!.getObjectInfo(h));
  if (handles.length > capped.length) log(`(showing first ${capped.length} of ${handles.length})`);
  return objects;
}

async function loadCwd(): Promise<void> {
  const { storageId, path } = state.cwd!;
  const parent = path.length ? path[path.length - 1]!.handle : ROOT_PARENT;
  setStatus('listing ' + breadcrumbText());
  state.cwdObjects = await listObjects(storageId, parent);
  render();
  setStatus(`${breadcrumbText()} — ${state.cwdObjects.length} objects`);
}

async function refresh(): Promise<void> {
  if (state.cwd) return loadCwd();
  setStatus('GetStorageIDs');
  const ids = await mtp!.getStorageIDs();
  state.storages = [];
  for (const id of mountedStorageIds(ids)) {
    const s = await mtp!.getStorageInfo(id) as StorageView;
    setStatus('listing root of 0x' + id.toString(16));
    s.objects = await listObjects(id, ROOT_PARENT);
    state.storages.push(s);
    render();
  }
  setStatus('/ — ' + state.storages.reduce((n, s) => n + s.objects.length, 0) + ' objects');
}

async function enterFolder(storageId: number, o: ObjectInfo): Promise<void> {
  const samePath = state.cwd && state.cwd.storageId === storageId ? state.cwd.path : [];
  state.cwd = { storageId, path: [...samePath, { handle: o.handle, name: o.filename }] };
  await loadCwd();
}

// depth: null = storages overview, 0 = storage root, n = nth folder in the path.
async function navigateTo(depth: number | null): Promise<void> {
  if (depth === null) {
    state.cwd = null;
    return refresh();
  }
  state.cwd!.path = state.cwd!.path.slice(0, depth);
  await loadCwd();
}

async function downloadObject(o: ObjectInfo): Promise<Uint8Array> {
  setStatus(`GetObject ${o.filename} (${fmtSize(o.size)})`);
  const t0 = performance.now();
  const bytes = await mtp!.getObject(o.handle);
  const ms = Math.round(performance.now() - t0);
  log(`received ${bytes.byteLength} bytes in ${ms}ms`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart]));
  a.download = o.filename;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('saved ' + o.filename);
  return bytes;
}

async function deleteObject(o: ObjectInfo): Promise<void> {
  setStatus('DeleteObject ' + o.filename);
  await mtp!.deleteObject(o.handle);
  await refresh();
}

async function uploadBytes(filename: string, bytes: Uint8Array): Promise<number> {
  const sid = state.cwd ? state.cwd.storageId : state.storages[0]!.id;
  const parent = state.cwd && state.cwd.path.length
    ? state.cwd.path[state.cwd.path.length - 1]!.handle : ROOT_PARENT;
  setStatus(`SendObject ${filename} (${fmtSize(bytes.byteLength)}) to ${breadcrumbText()}`);
  const t0 = performance.now();
  const handle = await mtp!.sendObject(sid, parent, filename, bytes);
  const ms = Math.round(performance.now() - t0);
  log(`sent ${bytes.byteLength} bytes in ${ms}ms, new handle 0x${handle.toString(16)}`);
  await refresh();
  return handle;
}

async function makeFolder(name: string): Promise<number> {
  const sid = state.cwd ? state.cwd.storageId : state.storages[0]!.id;
  const parent = state.cwd && state.cwd.path.length
    ? state.cwd.path[state.cwd.path.length - 1]!.handle : ROOT_PARENT;
  setStatus(`SendObjectInfo (folder) ${name} in ${breadcrumbText()}`);
  const handle = await mtp!.createFolder(sid, parent, name);
  log(`created folder ${name}, handle 0x${handle.toString(16)}`);
  await refresh();
  return handle;
}

function fs(): MtpFs {
  const sid = state.cwd ? state.cwd.storageId : state.storages[0]!.id;
  let f = fsBySid.get(sid);
  if (!f) { f = new MtpFs(mtp!, sid); fsBySid.set(sid, f); }
  return f;
}

async function connect(fromPicker: boolean): Promise<void> {
  try {
    const device = fromPicker
      ? (setStatus('waiting for device picker'), await requestMtpDevice())
      : await getGrantedMtpDevice();
    if (!device) {
      setStatus('no granted device — click Connect');
      return;
    }
    if (!fromPicker) log('using previously granted device: ' + (device.productName ?? '(unnamed)'));
    setStatus('opening ' + (device.productName ?? 'device'));
    mtp = new MtpDevice(device);
    mtp.log = log;
    await mtp.open();
    setStatus('GetDeviceInfo');
    const info = await mtp.getDeviceInfo();
    state.deviceInfo = info;
    log(`device: ${info.manufacturer} ${info.model} (fw ${info.deviceVersion})`);
    log(`vendor ext: ${info.vendorExtensionDesc}`);
    setStatus('OpenSession');
    await mtp.openSession();
    window.__mtpDevice = mtp;
    ($('refresh') as HTMLButtonElement).disabled = false;
    ($('upload') as HTMLButtonElement).disabled = false;
    ($('mkdir') as HTMLButtonElement).disabled = false;
    await refresh();
  } catch (e) {
    fail(e);
  }
}

$('connect').addEventListener('click', () => { connect(true); });
$('mkdir').addEventListener('click', () => {
  (async () => {
    const input = $('foldername') as HTMLInputElement;
    const name = input.value.trim();
    if (!name) { setStatus('type a folder name first'); return; }
    await makeFolder(name);
    input.value = '';
  })().catch(fail);
});
$('refresh').addEventListener('click', () => { refresh().catch(fail); });
$('upload').addEventListener('click', () => {
  (async () => {
    const f = ($('file') as HTMLInputElement).files?.[0];
    if (!f) { setStatus('pick a file first'); return; }
    await uploadBytes(f.name, new Uint8Array(await f.arrayBuffer()));
  })().catch(fail);
});

// Automation/debug surface.
window.__mtpApi = {
  refresh, enterFolder, navigateTo, uploadBytes, makeFolder,
  fs,
  getBytes: (handle: number) => mtp!.getObject(handle),
  download: downloadObject,
  deleteHandle: (handle: number) => mtp!.deleteObject(handle),
};

if (!usbSupported()) {
  setStatus('WebUSB not available in this browser');
} else {
  connect(false);
}
