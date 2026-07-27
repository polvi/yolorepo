<script lang="ts">
  import { goto } from '$app/navigation';
  import { liveQuery } from 'dexie';
  import { db, deleteNotebookDeep, renameNotebook, type LocalNotebook } from '$lib/db';
  import { importDocument, IMPORT_ACCEPT } from '$lib/import';
  import { focusAndSelect } from '$lib/focus';

  let notebooks = $state<LocalNotebook[] | null>(null);
  let docCounts = $state<Map<string, number>>(new Map());
  let importing = $state(false);
  let error = $state<string | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    const sub = liveQuery(async () => {
      const list = await db.notebooks.filter((n) => n.deleted === 0).reverse().sortBy('updatedAt');
      const docs = await db.documents.filter((d) => d.deleted === 0).toArray();
      const counts = new Map<string, number>();
      for (const d of docs) counts.set(d.notebookId, (counts.get(d.notebookId) ?? 0) + 1);
      return { list, counts };
    }).subscribe(({ list, counts }) => {
      notebooks = list;
      docCounts = counts;
    });
    return () => sub.unsubscribe();
  });

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    importing = true;
    error = null;
    try {
      const { notebookId } = await importDocument(file);
      await goto(`/n/${notebookId}`);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not import that file.';
    } finally {
      importing = false;
      if (fileInput) fileInput.value = '';
    }
  }

  async function remove(notebook: LocalNotebook) {
    if (confirm(`Delete “${notebook.title}” and its highlights and links?`)) {
      await deleteNotebookDeep(notebook.id);
    }
  }

  let renamingId = $state<string | null>(null);
  let renameValue = $state('');

  function startRename(notebook: LocalNotebook) {
    renamingId = notebook.id;
    renameValue = notebook.title;
  }

  async function commitRename() {
    if (!renamingId) return;
    const id = renamingId;
    const title = renameValue.trim();
    renamingId = null; // clear first so the input's blur becomes a no-op
    if (title) await renameNotebook(id, title);
  }
</script>

<div class="wrap">
  <div class="head">
    <h1>Notebooks</h1>
    <button class="new" disabled={importing} onclick={() => fileInput?.click()}>
      {importing ? 'Importing…' : '+ New notebook'}
    </button>
    <input
      bind:this={fileInput}
      type="file"
      accept={IMPORT_ACCEPT}
      hidden
      onchange={(e) => handleFiles(e.currentTarget.files)}
    />
  </div>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if notebooks === null}
    <p class="muted">Loading…</p>
  {:else if notebooks.length === 0}
    <div class="empty">
      <p>A notebook starts with a PDF or an EPUB.</p>
      <p class="muted">Add one and you can highlight it, add more documents, and link passages between them.</p>
    </div>
  {:else}
    <ul>
      {#each notebooks as nb (nb.id)}
        <li>
          {#if renamingId === nb.id}
            <input
              class="rename"
              bind:value={renameValue}
              use:focusAndSelect
              onblur={commitRename}
              onkeydown={(e) => {
                if (e.key === 'Enter') void commitRename();
                if (e.key === 'Escape') renamingId = null;
              }}
            />
          {:else}
            <a href={`/n/${nb.id}`}>
              <span class="title">{nb.title}</span>
              <span class="meta">{docCounts.get(nb.id) ?? 0} doc{(docCounts.get(nb.id) ?? 0) === 1 ? '' : 's'}</span>
            </a>
          {/if}
          <button class="edit" title="Rename notebook" onclick={() => startRename(nb)}>✎</button>
          <button class="del" title="Delete notebook" onclick={() => remove(nb)}>×</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .wrap {
    max-width: 40rem;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1.25rem;
  }
  h1 {
    font-size: 1.4rem;
    margin: 0;
  }
  .new {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 0.5rem;
    padding: 0.55rem 1rem;
    font-weight: 600;
    cursor: pointer;
  }
  .new:disabled {
    opacity: 0.6;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  li a {
    flex: 1;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    padding: 0.8rem 0.9rem;
    margin-bottom: 0.5rem;
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: 0.6rem;
    text-decoration: none;
    color: inherit;
  }
  li a:hover {
    border-color: var(--accent);
  }
  .title {
    font-weight: 600;
  }
  .meta {
    font-size: 0.8rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .del,
  .edit {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 1.1rem;
    cursor: pointer;
  }
  .edit {
    font-size: 0.9rem;
  }
  .del:hover {
    color: #c0392b;
  }
  .edit:hover {
    color: var(--accent);
  }
  .rename {
    flex: 1;
    font: inherit;
    font-weight: 600;
    color: inherit;
    background: var(--card);
    border: 1px solid var(--accent);
    border-radius: 0.6rem;
    padding: 0.8rem 0.9rem;
    margin-bottom: 0.5rem;
    min-width: 0;
  }
  .empty {
    text-align: center;
    padding: 3.5rem 1rem;
    border: 1.5px dashed var(--rule);
    border-radius: 0.75rem;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: #c0392b;
  }
</style>
