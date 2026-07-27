<script lang="ts">
  import { onMount } from 'svelte';
  import { initSync } from '$lib/sync-client';
  import { immersive } from '$lib/ui';
  import AuthButton from '$lib/components/AuthButton.svelte';
  import KosyncSettings from '$lib/components/KosyncSettings.svelte';
  import OpdsSettings from '$lib/components/OpdsSettings.svelte';
  import SyncStatus from '$lib/components/SyncStatus.svelte';
  import UpdateCheck from '$lib/components/UpdateCheck.svelte';

  let { children } = $props();

  onMount(() => {
    void initSync();
  });
</script>

<div class="app">
  <header class:hidden={$immersive}>
    <a class="brand" href="/">happy<span>book</span></a>
    <div class="right">
      <UpdateCheck />
      <SyncStatus />
      <OpdsSettings />
      <KosyncSettings />
      <AuthButton />
    </div>
  </header>
  <main>
    {@render children()}
  </main>
</div>

<style>
  :global(:root) {
    --bg: #faf7f2;
    --well: #eee8df;
    --ink: #1e1a16;
    --muted: #6b6259;
    --accent: #c2542e;
    --card: #ffffff;
    --rule: #e0d8cc;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #16130f;
      --well: #0f0d0a;
      --ink: #ece5db;
      --muted: #9c9287;
      --accent: #e0764f;
      --card: #201c17;
      --rule: #322c25;
    }
  }
  :global(*) {
    box-sizing: border-box;
  }
  :global(html),
  :global(body) {
    margin: 0;
    height: 100%;
  }
  :global(body) {
    background: var(--bg);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    overscroll-behavior: none;
  }
  .app {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }
  header.hidden {
    display: none;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--rule);
    background: var(--card);
    flex-shrink: 0;
  }
  .brand {
    font-weight: 700;
    text-decoration: none;
    color: inherit;
    font-size: 1rem;
  }
  .brand span {
    color: var(--accent);
  }
  .right {
    display: flex;
    align-items: center;
    gap: 0.9rem;
  }
  main {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
</style>
