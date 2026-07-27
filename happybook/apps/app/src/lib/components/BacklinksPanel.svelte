<script lang="ts">
  import { liveQuery } from 'dexie';
  import type { Anchor } from '@happybook/shared';
  import { db, softDelete, type LocalDocument, type LocalLink } from '$lib/db';
  import { describeAnchor } from '$lib/anchors';

  let {
    activeDocId,
    documents,
    onNavigate,
  }: {
    activeDocId: string;
    documents: LocalDocument[];
    onNavigate: (documentId: string, anchor: Anchor) => void;
  } = $props();

  let links = $state<LocalLink[]>([]);
  $effect(() => {
    const docId = activeDocId;
    const sub = liveQuery(() =>
      db.links
        .where('fromDocumentId')
        .equals(docId)
        .or('toDocumentId')
        .equals(docId)
        .filter((l) => l.deleted === 0)
        .toArray(),
    ).subscribe((v) => (links = v));
    return () => sub.unsubscribe();
  });

  const outgoing = $derived(links.filter((l) => l.fromDocumentId === activeDocId));
  const incoming = $derived(links.filter((l) => l.toDocumentId === activeDocId));

  const docTitle = (id: string) => documents.find((d) => d.id === id)?.title ?? 'missing document';
  /** "p.N" for PDFs, "ch.N" for EPUBs (anchor.page counts spine chapters there). */
  const locLabel = (docId: string, anchor: Anchor) =>
    documents.find((d) => d.id === docId)?.format === 'epub' ? `ch.${anchor.page}` : `p.${anchor.page}`;
</script>

<aside class="panel">
  <h2>Links</h2>

  {#if links.length === 0}
    <p class="empty">No links yet. Select text and choose “Link…” to connect documents.</p>
  {/if}

  {#if outgoing.length > 0}
    <h3>From this document</h3>
    <ul>
      {#each outgoing as link (link.id)}
        <li>
          <button class="jump" onclick={() => onNavigate(link.toDocumentId, link.toAnchor)}>
            <span class="quote">“{describeAnchor(link.fromAnchor)}”</span>
            <span class="dest">→ {docTitle(link.toDocumentId)} · {locLabel(link.toDocumentId, link.toAnchor)}</span>
          </button>
          <button class="del" title="Delete link" onclick={() => softDelete('links', link.id)}>×</button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if incoming.length > 0}
    <h3>Into this document</h3>
    <ul>
      {#each incoming as link (link.id)}
        <li>
          <button class="jump" onclick={() => onNavigate(link.fromDocumentId, link.fromAnchor)}>
            <span class="quote">“{describeAnchor(link.toAnchor)}”</span>
            <span class="dest">← {docTitle(link.fromDocumentId)} · {locLabel(link.fromDocumentId, link.fromAnchor)}</span>
          </button>
          <button class="del" title="Delete link" onclick={() => softDelete('links', link.id)}>×</button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .panel {
    width: 17rem;
    border-left: 1px solid var(--rule);
    background: var(--card);
    overflow-y: auto;
    padding: 0.9rem;
    flex-shrink: 0;
  }
  h2 {
    font-size: 0.95rem;
    margin: 0 0 0.5rem;
  }
  h3 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 0.9rem 0 0.3rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: 0.25rem;
    margin-bottom: 0.45rem;
  }
  .jump {
    flex: 1;
    text-align: left;
    background: none;
    border: 1px solid var(--rule);
    border-radius: 0.4rem;
    padding: 0.45rem 0.55rem;
    cursor: pointer;
    color: inherit;
    display: block;
  }
  .jump:hover {
    border-color: var(--accent);
  }
  .quote {
    display: block;
    font-size: 0.8rem;
    line-height: 1.3;
  }
  .dest {
    display: block;
    font-size: 0.72rem;
    color: var(--accent);
    margin-top: 0.25rem;
  }
  .del {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 1rem;
    padding: 0.2rem;
  }
  .del:hover {
    color: #c0392b;
  }
  .empty {
    font-size: 0.8rem;
    color: var(--muted);
  }
  @media (max-width: 720px) {
    .panel {
      position: fixed;
      inset: auto 0 0 0;
      width: auto;
      max-height: 45vh;
      border-left: none;
      border-top: 1px solid var(--rule);
      border-radius: 0.9rem 0.9rem 0 0;
      box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.2);
      z-index: 20;
    }
  }
</style>
