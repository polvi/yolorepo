<script lang="ts">
  import { page } from '$app/state';
  import Workspace from '$lib/components/Workspace.svelte';

  const notebookId = $derived(page.params.id ?? '');
</script>

<svelte:head>
  <title>Happybook</title>
</svelte:head>

{#key notebookId}
  <Workspace {notebookId} />
{/key}
