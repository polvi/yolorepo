<script lang="ts">
  import type { LocalDocument } from '$lib/db';
  import { focusAndSelect } from '$lib/focus';

  let {
    documents,
    activeDocId,
    onSelect,
    onClose,
  }: {
    documents: LocalDocument[];
    activeDocId: string | null;
    onSelect: (id: string) => void;
    onClose: () => void;
  } = $props();

  let filter = $state('');
  const showFilter = $derived(documents.length > 8);
  const shown = $derived(
    filter.trim()
      ? documents.filter((d) => d.title.toLowerCase().includes(filter.trim().toLowerCase()))
      : documents,
  );
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onClose}></div>
<div class="menu" role="menu">
  {#if showFilter}
    <input
      class="filter"
      placeholder="Filter documents…"
      bind:value={filter}
      use:focusAndSelect
    />
  {/if}
  <div class="items">
    {#each shown as d (d.id)}
      <button class="item" class:active={d.id === activeDocId} role="menuitem" onclick={() => onSelect(d.id)}>
        <span class="badge">{d.format === 'epub' ? 'EPUB' : 'PDF'}</span>
        <span class="t">{d.title}</span>
        {#if d.id === activeDocId}<span class="check">✓</span>{/if}
      </button>
    {:else}
      <p class="none">No documents match.</p>
    {/each}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 39;
  }
  .menu {
    position: absolute;
    top: 100%;
    right: 0.6rem;
    z-index: 40;
    min-width: 16rem;
    max-width: 24rem;
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: 0.6rem;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);
    padding: 0.35rem;
    display: flex;
    flex-direction: column;
  }
  .items {
    overflow-y: auto;
    max-height: min(50vh, 22rem);
  }
  .filter {
    font: inherit;
    font-size: 0.85rem;
    color: inherit;
    background: var(--well);
    border: 1px solid var(--rule);
    border-radius: 0.4rem;
    padding: 0.4rem 0.6rem;
    margin: 0.15rem 0.15rem 0.35rem;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    background: none;
    border: none;
    border-radius: 0.4rem;
    padding: 0.5rem 0.55rem;
    cursor: pointer;
    color: inherit;
    font-size: 0.85rem;
    text-align: left;
  }
  .item:hover {
    background: var(--well);
  }
  .item.active {
    font-weight: 600;
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
    min-width: 2.4rem;
    text-align: center;
  }
  .t {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .check {
    color: var(--accent);
    flex-shrink: 0;
  }
  .none {
    color: var(--muted);
    font-size: 0.8rem;
    padding: 0.5rem 0.55rem;
    margin: 0;
  }
  @media (max-width: 560px) {
    .backdrop {
      background: rgba(0, 0, 0, 0.35);
    }
    .menu {
      position: fixed;
      inset: auto 0 0 0;
      top: auto;
      right: 0;
      max-width: none;
      border-radius: 0.9rem 0.9rem 0 0;
      border-left: none;
      border-right: none;
      border-bottom: none;
      box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.25);
      padding: 0.6rem 0.6rem calc(0.6rem + env(safe-area-inset-bottom));
      z-index: 40;
    }
    .item {
      padding: 0.7rem 0.55rem; /* comfortable touch targets */
      font-size: 0.95rem;
    }
  }
</style>
