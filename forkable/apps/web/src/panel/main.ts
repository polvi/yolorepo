import { kvSet, MODE_KEY } from '../lib/state';
import { commitAndPush, ensureRepo, hasChanges, listFiles, readFile, writeFile } from '../lib/repo';
import { runTurn, type ChatMessage } from '../lib/agent';
import {
  DEFAULT_BUDGET,
  DEFAULT_ISSUER,
  GrantGoneError,
  buildGrantUrl,
  getModel,
  getSpent,
  getTokens,
  loadModels,
  revokeGrant,
  setModel,
  usd,
} from '../lib/tpx';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (text: string, isError = false) => {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('err', isError);
};
const tell = (forkable: string) => window.parent.postMessage({ forkable }, location.origin);

const chatLog = $('chat-log');
const chatInput = $<HTMLTextAreaElement>('chat-input');
const modelSelect = $<HTMLSelectElement>('model');
const fileSelect = $<HTMLSelectElement>('file-select');
const textarea = $<HTMLTextAreaElement>('content');

let userId = '';
let busy = false;
const history: ChatMessage[] = JSON.parse(sessionStorage.getItem('forkable.chat') ?? '[]');

function saveHistory(): void {
  sessionStorage.setItem('forkable.chat', JSON.stringify(history.slice(-24)));
}

function bubble(cls: 'user' | 'assistant' | 'note', text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

// ---------- grant state ----------
function updateGrantUi(): void {
  const granted = !!getTokens();
  $('grant').classList.toggle('active', !granted);
  $('chat-pane').classList.toggle('active', granted && activeTab === 'chat');
  updateBudgetLine();
}

function updateBudgetLine(): void {
  const t = getTokens();
  $('budget-line').textContent = t ? `spent ${usd(getSpent())} of ${usd(t.budget)}` : '';
}

window.addEventListener('storage', () => {
  updateGrantUi();
  if (getTokens()) status('connected — describe your change');
});

$('grant-go').addEventListener('click', async () => {
  $('grant-err').textContent = '';
  try {
    const url = await buildGrantUrl(
      Number($<HTMLInputElement>('grant-budget').value) || DEFAULT_BUDGET,
      $<HTMLInputElement>('grant-provider').value || DEFAULT_ISSUER
    );
    window.open(url, 'forkable-grant', 'popup,width=480,height=720');
  } catch (e) {
    $('grant-err').textContent = e instanceof Error ? e.message : String(e);
  }
});

$('revoke').addEventListener('click', async () => {
  await revokeGrant();
  updateGrantUi();
});

// ---------- tabs ----------
let activeTab: 'chat' | 'files' = 'chat';
function setTab(tab: 'chat' | 'files'): void {
  activeTab = tab;
  $('tab-chat').classList.toggle('active', tab === 'chat');
  $('tab-files').classList.toggle('active', tab === 'files');
  $('files-pane').classList.toggle('active', tab === 'files');
  updateGrantUi();
}
$('tab-chat').addEventListener('click', () => setTab('chat'));
$('tab-files').addEventListener('click', () => {
  setTab('files');
  void refreshFiles(fileSelect.value || undefined);
});

// ---------- chat ----------
async function publish(note: string): Promise<void> {
  await commitAndPush(userId, note);
  await kvSet(MODE_KEY, 'fork');
  tell('reload');
}

$('send').addEventListener('click', () => void send());
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});

async function send(): Promise<void> {
  const content = chatInput.value.trim();
  if (!content || busy) return;
  busy = true;
  chatInput.value = '';
  bubble('user', content);
  const working = bubble('note', 'thinking…');
  try {
    const result = await runTurn(history, content, (note) => {
      working.textContent = note;
      chatLog.scrollTop = chatLog.scrollHeight;
    });
    working.remove();
    history.push({ role: 'user', content }, { role: 'assistant', content: result.reply });
    saveHistory();
    bubble('assistant', result.reply);
    updateBudgetLine();
    if (await hasChanges()) {
      status('saving your draft…');
      await publish(content.slice(0, 72));
      status('draft updated — the page shows your version');
    } else {
      status('no file changes this turn');
    }
  } catch (e) {
    working.remove();
    chatInput.value = content;
    if (e instanceof GrantGoneError) {
      status('your inference grant expired — connect again', true);
      updateGrantUi();
    } else {
      const code = (e as { code?: string }).code;
      if (code === 'budget_exhausted') {
        status(`budget spent (${usd(getSpent())}) — grant a new budget`, true);
        await revokeGrant();
        updateGrantUi();
      } else if (code === 'model_not_permitted' || code === 'model_not_found') {
        status(`this grant can't use ${getModel()}; pick another model`, true);
      } else {
        status(e instanceof Error ? e.message : String(e), true);
      }
    }
  } finally {
    busy = false;
  }
}

// ---------- files (debug editor) ----------
async function refreshFiles(selected?: string): Promise<void> {
  const files = await listFiles();
  fileSelect.innerHTML = '';
  for (const file of files) {
    const option = document.createElement('option');
    option.value = option.textContent = file;
    fileSelect.appendChild(option);
  }
  fileSelect.value = selected ?? files[0] ?? '';
  textarea.value = fileSelect.value ? await readFile(fileSelect.value) : '';
}

fileSelect.addEventListener('change', async () => {
  textarea.value = fileSelect.value ? await readFile(fileSelect.value) : '';
});

$('save').addEventListener('click', async () => {
  if (!fileSelect.value) return;
  try {
    status('saving…');
    await writeFile(fileSelect.value, textarea.value);
    await publish(`edit ${fileSelect.value}`);
    status('saved — the page shows your version');
  } catch (e) {
    status(`save failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
});

// ---------- header ----------
$('view-original').addEventListener('click', () => tell('view-original'));
$('close').addEventListener('click', () => tell('close'));

// ---------- boot ----------
async function main(): Promise<void> {
  const res = await fetch('/__forkable__/api/me', { credentials: 'include' });
  if (!res.ok) {
    status('sign-in required — close and reopen the editor', true);
    return;
  }
  userId = ((await res.json()) as { user_id: string }).user_id;

  status('getting your copy of the site…');
  await navigator.serviceWorker.register('/__forkable__/sw.js', { type: 'module', scope: '/' });
  await ensureRepo(userId);

  for (const msg of history) bubble(msg.role === 'user' ? 'user' : 'assistant', msg.content);
  updateGrantUi();
  void loadModels().then((ids) => {
    const saved = getModel();
    modelSelect.innerHTML = '';
    for (const id of ids) {
      const option = document.createElement('option');
      option.value = option.textContent = id;
      modelSelect.appendChild(option);
    }
    modelSelect.value = ids.includes(saved) ? saved : ids[0] ?? saved;
  });
  modelSelect.addEventListener('change', () => setModel(modelSelect.value));

  status(getTokens() ? 'this is your own copy — describe a change' : 'connect inference to start');
}

void main();
