<script lang="ts">
  import { liveQuery } from 'dexie';
  import type { Anchor } from '@happybook/shared';
  import { db, addLink, saveProgress, softDelete, type LocalDocument, type LocalLink, type LocalNotebook, type LocalProgress } from '$lib/db';
  import { importDocument, IMPORT_ACCEPT } from '$lib/import';
  import { scheduleSync, setPriorityNotebook } from '$lib/sync-client';
  import PdfViewer from './PdfViewer.svelte';
  import EpubViewer from './EpubViewer.svelte';
  import BacklinksPanel from './BacklinksPanel.svelte';
  import DocSwitcher from './DocSwitcher.svelte';
  import DeviceSync from './DeviceSync.svelte';
  import { immersive } from '$lib/ui';

  let { notebookId }: { notebookId: string } = $props();

  let notebook = $state<LocalNotebook | null>(null);
  let documents = $state<LocalDocument[]>([]);
  let loaded = $state(false);
  let activeDocId = $state<string | null>(null);
  let pendingLink = $state<{ fromDocumentId: string; anchor: Anchor } | null>(null);
  let showPanel = $state(false);
  let importing = $state(false);
  let error = $state<string | null>(null);
  let undoLink = $state<LocalLink | null>(null);
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  let viewer = $state<{
    getViewState: () => { scrollTop: number; scale: number };
    getPosition: () => { page?: number; percentage: number };
  } | null>(null);
  let progressByDoc = $state(new Map<string, LocalProgress>());
  let jumpRequest = $state<{ documentId: string; anchor: Anchor } | null>(null);
  let fileInput: HTMLInputElement | undefined = $state();

  // Per-document scroll/zoom, so flipping tabs (e.g. while setting up a link)
  // never loses your spot. Read on remount via initialView.
  const viewStates = new Map<string, { scrollTop: number; scale: number }>();

  function saveViewState() {
    if (activeDocId && viewer) viewStates.set(activeDocId, viewer.getViewState());
    flushProgress();
  }

  function switchTab(docId: string) {
    if (docId === activeDocId) return;
    saveViewState();
    activeDocId = docId;
  }

  // ---- synced reading position: restored on a doc's first open this session,
  // written back (debounced) as the reader moves. The in-memory viewStates map
  // always wins over the synced record; it holds the exact in-session spot.

  let pendingProgress: { doc: LocalDocument; pos: { page?: number; percentage: number } } | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;

  function handlePositionChange(pos: { page?: number; percentage: number }) {
    const doc = activeDoc;
    if (!doc) return;
    pendingProgress = { doc, pos };
    clearTimeout(progressTimer);
    progressTimer = setTimeout(flushProgress, 5000);
  }

  function flushProgress() {
    clearTimeout(progressTimer);
    const p = pendingProgress;
    pendingProgress = null;
    if (p) void saveProgress(p.doc, p.pos);
  }

  $effect(() => flushProgress);

  function initialPositionFor(doc: LocalDocument): { page?: number; percentage: number } | null {
    if (viewStates.has(doc.id)) return null;
    const p = progressByDoc.get(doc.id);
    if (!p) return null;
    const page = (doc.format ?? 'pdf') === 'pdf' ? Number.parseInt(p.progress, 10) : NaN;
    return {
      ...(Number.isFinite(page) && page > 0 ? { page } : {}),
      percentage: p.percentage,
    };
  }

  $effect(() => {
    const id = notebookId;
    const sub = liveQuery(async () => ({
      nb: (await db.notebooks.get(id)) ?? null,
      docs: await db.documents.where('notebookId').equals(id).filter((d) => d.deleted === 0).sortBy('addedAt'),
    })).subscribe(({ nb, docs }) => {
      notebook = nb && nb.deleted === 0 ? nb : null;
      documents = docs;
      loaded = true;
      if (!activeDocId || !docs.some((d) => d.id === activeDocId)) {
        activeDocId = docs[0]?.id ?? null;
      }
    });
    return () => sub.unsubscribe();
  });

  // Progress lives in its own liveQuery, NOT the one above: progress writes
  // land every few seconds while reading, and folding them into the notebook
  // query would re-emit `documents` with fresh object identities each time,
  // re-running the viewers' load() and yanking the scroll position around.
  $effect(() => {
    const id = notebookId;
    const sub = liveQuery(() =>
      db.progress.where('notebookId').equals(id).filter((p) => p.deleted === 0).toArray(),
    ).subscribe((prog) => {
      progressByDoc = new Map(prog.map((p) => [p.documentId, p]));
    });
    return () => sub.unsubscribe();
  });

  const activeDoc = $derived(documents.find((d) => d.id === activeDocId) ?? null);

  // ---- browser-style tab strip: show what fits, spill the rest into a menu

  let menuOpen = $state(false);
  let tabsWidth = $state(0);
  // Room taken by the non-tab chrome in the strip: notebook title, divider,
  // add button, overflow button, Links toggle, gaps.
  const RESERVED_PX = 440;
  const MIN_TAB_PX = 130;

  const strip = $derived.by(() => {
    const fit = Math.max(1, Math.floor((tabsWidth - RESERVED_PX) / MIN_TAB_PX));
    if (documents.length <= fit) return { visible: documents, overflow: 0 };
    let visible = documents.slice(0, fit);
    // The active document always keeps a visible tab, like a browser does
    // when you pick something from the overflow list.
    if (activeDocId && !visible.some((d) => d.id === activeDocId)) {
      const active = documents.find((d) => d.id === activeDocId);
      if (active) visible = [...visible.slice(0, Math.max(0, fit - 1)), active];
    }
    return { visible, overflow: documents.length - visible.length };
  });

  function selectFromMenu(id: string) {
    menuOpen = false;
    switchTab(id);
  }

  // Opening a notebook syncs immediately and puts its PDFs at the front of
  // the download queue, so a new device fills in without waiting for a tick.
  $effect(() => {
    setPriorityNotebook(notebookId);
    scheduleSync(0);
    return () => setPriorityNotebook(null);
  });

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    importing = true;
    error = null;
    try {
      const { documentId } = await importDocument(file, notebookId);
      activeDocId = documentId;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not import that file.';
    } finally {
      importing = false;
      if (fileInput) fileInput.value = '';
    }
  }

  function startLink(anchor: Anchor) {
    if (!activeDocId) return;
    pendingLink = { fromDocumentId: activeDocId, anchor };
  }

  async function completeLink(anchor: Anchor) {
    if (!pendingLink || !activeDocId) return;
    // $state proxies cannot be structured-cloned into IndexedDB; snapshot first.
    const from = {
      documentId: pendingLink.fromDocumentId,
      anchor: $state.snapshot(pendingLink.anchor) as Anchor,
    };
    const to = { documentId: activeDocId, anchor: $state.snapshot(anchor) as Anchor };
    pendingLink = null;
    const link = await addLink(notebookId, from, to);
    undoLink = link;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => (undoLink = null), 6000);
  }

  async function undo() {
    if (undoLink) await softDelete('links', undoLink.id);
    undoLink = null;
  }

  function navigateTo(documentId: string, anchor: Anchor) {
    if (activeDocId !== documentId) {
      saveViewState();
      activeDocId = documentId;
    }
    // Handed to the (possibly remounting) viewer as a prop; it clears the
    // request via onJumped once the scroll lands.
    jumpRequest = { documentId, anchor: $state.snapshot(anchor) as Anchor };
  }

  function handleNavigateLink(link: LocalLink, clickedSide: 'source' | 'target') {
    // Clicking either end of a link jumps to the other end.
    if (clickedSide === 'source') navigateTo(link.toDocumentId, link.toAnchor);
    else navigateTo(link.fromDocumentId, link.fromAnchor);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (menuOpen) menuOpen = false;
    else if (pendingLink) pendingLink = null;
    else if ($immersive) immersive.set(false);
  }

  // Immersive mode belongs to a reading session, not the app: entering or
  // leaving a notebook always restores the chrome.
  $effect(() => {
    immersive.set(false);
    return () => immersive.set(false);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if !loaded}
  <p class="center muted">Loading…</p>
{:else if !notebook}
  <div class="center">
    <p>This notebook does not exist on this device.</p>
    <p class="muted">If it lives in your account, sign in and let it sync.</p>
    <a href="/">Back to notebooks</a>
  </div>
{:else}
  <div class="workspace">
    {#if pendingLink}
      <div class="banner">
        Select text or click a spot in any document to finish the link. <kbd>Esc</kbd> cancels.
        <button onclick={() => (pendingLink = null)}>Cancel</button>
      </div>
    {/if}
    {#if undoLink}
      <div class="banner ok">
        Link created.
        <button onclick={undo}>Undo</button>
      </div>
    {/if}
    {#if error}
      <div class="banner err">{error}<button onclick={() => (error = null)}>×</button></div>
    {/if}

    <div class="tabbar" class:hidden={$immersive}>
      <div class="tabs" role="tablist" bind:clientWidth={tabsWidth}>
        <span class="nb-title" title={notebook.title}>{notebook.title}</span>
        <span class="divider"></span>
        {#each strip.visible as d (d.id)}
          <button
            role="tab"
            aria-selected={d.id === activeDocId}
            class:active={d.id === activeDocId}
            onclick={() => switchTab(d.id)}
            title={d.title}
          >
            {d.title}
          </button>
        {/each}
        {#if strip.overflow > 0}
          <button class="more" onclick={() => (menuOpen = !menuOpen)}>
            {strip.overflow} more ▾
          </button>
        {/if}
        {#if activeDoc}
          <button class="switcher" onclick={() => (menuOpen = !menuOpen)} title="Switch document">
            <span class="badge">{activeDoc.format === 'epub' ? 'EPUB' : 'PDF'}</span>
            <span class="switcher-title">{activeDoc.title}</span>
            <span class="count">{documents.length}</span>
            ▾
          </button>
        {/if}
        <button
          class="add"
          disabled={importing}
          onclick={() => fileInput?.click()}
          title="Add a PDF or EPUB to this notebook"
        >
          {importing ? '…' : '+ Add'}
        </button>
        <input
          bind:this={fileInput}
          type="file"
          accept={IMPORT_ACCEPT}
          hidden
          onchange={(e) => handleFiles(e.currentTarget.files)}
        />
        <span class="spacer"></span>
        <DeviceSync {notebookId} />
        <button class="panel-toggle" class:active={showPanel} onclick={() => (showPanel = !showPanel)}>
          Links
        </button>
      </div>
      {#if menuOpen}
        <DocSwitcher {documents} {activeDocId} onSelect={selectFromMenu} onClose={() => (menuOpen = false)} />
      {/if}
    </div>

    <div class="main">
      {#if activeDoc}
        {#key activeDoc.id}
          {@const Viewer = activeDoc.format === 'epub' ? EpubViewer : PdfViewer}
          <Viewer
            bind:this={viewer}
            doc={activeDoc}
            initialView={viewStates.get(activeDoc.id) ?? null}
            initialPosition={initialPositionFor(activeDoc)}
            jumpTo={jumpRequest?.documentId === activeDoc.id ? jumpRequest.anchor : null}
            onJumped={() => (jumpRequest = null)}
            onPositionChange={handlePositionChange}
            linkArmed={pendingLink !== null}
            onLinkSource={startLink}
            onLinkTarget={completeLink}
            onNavigateLink={handleNavigateLink}
          />
        {/key}
      {:else}
        <div class="center">
          <p class="muted">No documents in this notebook yet.</p>
        </div>
      {/if}
      {#if showPanel && activeDocId && !$immersive}
        <BacklinksPanel {activeDocId} {documents} onNavigate={navigateTo} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .workspace {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .banner {
    padding: 0.5rem 1rem;
    background: #2c4a7c;
    color: #fff;
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .banner.ok {
    background: #2e6b43;
  }
  .banner.err {
    background: #8c2f23;
  }
  .banner button {
    background: rgba(255, 255, 255, 0.15);
    border: none;
    color: inherit;
    border-radius: 0.35rem;
    padding: 0.2rem 0.6rem;
    cursor: pointer;
  }
  kbd {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 0.25rem;
    padding: 0 0.3rem;
  }
  .tabbar {
    position: relative;
    flex-shrink: 0;
  }
  .tabbar.hidden {
    display: none;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.4rem 0.6rem 0;
    border-bottom: 1px solid var(--rule);
    flex-shrink: 0;
  }
  .nb-title {
    font-size: 0.85rem;
    font-weight: 700;
    padding: 0.35rem 0.4rem;
    max-width: 11rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .divider {
    width: 1px;
    align-self: stretch;
    margin: 0.4rem 0.15rem;
    background: var(--rule);
    flex-shrink: 0;
  }
  .tabs [role='tab'] {
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: none;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 0.5rem 0.5rem 0 0;
    padding: 0.45rem 0.8rem;
    cursor: pointer;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .tabs [role='tab'].active {
    background: var(--card);
    border-color: var(--rule);
    color: inherit;
    font-weight: 600;
  }
  .add,
  .more,
  .panel-toggle {
    background: none;
    border: 1px dashed var(--rule);
    border-radius: 0.4rem;
    padding: 0.35rem 0.7rem;
    cursor: pointer;
    color: var(--muted);
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .more {
    border-style: solid;
    flex-shrink: 0;
  }
  /* Phone-only: the current document + a menu, instead of a strip of tabs. */
  .switcher {
    display: none;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    flex: 1;
    background: var(--well);
    border: 1px solid var(--rule);
    border-radius: 0.4rem;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    color: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    text-align: left;
  }
  .switcher-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    flex-shrink: 0;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--muted);
    border: 1px solid var(--rule);
    border-radius: 0.3rem;
    padding: 0.1rem 0.3rem;
  }
  .count {
    flex-shrink: 0;
    font-weight: 400;
    color: var(--muted);
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: 0.3rem;
    padding: 0 0.35rem;
    font-size: 0.75rem;
  }
  .panel-toggle.active {
    border-style: solid;
    border-color: var(--accent);
    color: var(--accent);
  }
  .spacer {
    flex: 1;
  }
  .main {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 3rem 1rem;
    text-align: center;
  }
  .muted {
    color: var(--muted);
  }
  @media (max-width: 560px) {
    .tabs {
      flex-wrap: wrap;
      row-gap: 0.35rem;
      padding-bottom: 0.4rem;
    }
    .tabs [role='tab'],
    .more,
    .divider {
      display: none;
    }
    .nb-title {
      flex-basis: 100%;
      max-width: none;
      padding: 0 0.4rem;
    }
    .switcher {
      display: flex;
    }
  }
</style>
