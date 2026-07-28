import { kvSet, MODE_KEY } from '../lib/state';
import { commitAndPush, ensureRepo, listFiles, readFile, writeFile } from '../lib/repo';

// Phase 2 debug editor: pick a file, edit it, save to your draft. The chat
// panel replaces this UI in Phase 3; the plumbing underneath stays.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (text: string) => ($('status').textContent = text);
const tell = (forkable: string) => window.parent.postMessage({ forkable }, location.origin);

const select = $<HTMLSelectElement>('file-select');
const textarea = $<HTMLTextAreaElement>('content');

let userId = '';

async function refreshFiles(selected?: string): Promise<void> {
  const files = await listFiles();
  select.innerHTML = '';
  for (const file of files) {
    const option = document.createElement('option');
    option.value = option.textContent = file;
    select.appendChild(option);
  }
  select.value = selected ?? files[0] ?? '';
  if (select.value) textarea.value = await readFile(select.value);
}

async function main(): Promise<void> {
  const res = await fetch('/__forkable__/api/me', { credentials: 'include' });
  if (!res.ok) {
    status('sign-in required — close and reopen the editor');
    return;
  }
  userId = ((await res.json()) as { user_id: string }).user_id;

  status('getting your copy of the site…');
  await navigator.serviceWorker.register('/__forkable__/sw.js', { type: 'module', scope: '/' });
  await ensureRepo(userId);
  await refreshFiles();
  status('ready — this is your own copy, edit freely');
}

select.addEventListener('change', async () => {
  textarea.value = select.value ? await readFile(select.value) : '';
});

$('save').addEventListener('click', async () => {
  if (!select.value) return;
  try {
    status('saving…');
    await writeFile(select.value, textarea.value);
    await commitAndPush(userId, `edit ${select.value}`);
    await kvSet(MODE_KEY, 'fork');
    status('saved — reloading page with your draft');
    tell('reload');
  } catch (err) {
    status(`save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

$('view-original').addEventListener('click', () => tell('view-original'));
$('close').addEventListener('click', () => tell('close'));

void main();
