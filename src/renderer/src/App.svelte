<script lang="ts">
  import type { Snapshot } from '@shared/types'
  import { actions, app, themeVars, workspace } from './lib/api.svelte'
  import Palette from './components/Palette.svelte'
  import Sidebar from './components/Sidebar.svelte'

  let palette = $state<'new' | 'edit' | null>(null)
  let renaming = $state<string | null>(null)
  let editingWorkspace = $state<string | null>(null)
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  window.drift.invoke('snapshot').then((s) => (app.snap = s as Snapshot))
  window.drift.onSnapshot((s) => (app.snap = s))
  window.drift.onCommand((cmd) => {
    if (cmd.type === 'palette') openPalette(cmd.mode as 'new' | 'edit')
    if (cmd.type === 'rename') {
      renaming = cmd.id
      if (app.snap?.mode === 'edge') actions.setMode('peek')
    }
    if (cmd.type === 'edit-workspace') editingWorkspace = cmd.id
  })

  async function openPalette(mode: 'new' | 'edit'): Promise<void> {
    await actions.palette(true)
    palette = mode
  }

  function closePalette(): void {
    palette = null
    actions.palette(false)
    actions.focusPage()
  }

  const snap = $derived(app.snap)
  const compact = $derived(snap?.state.settings.compact ?? false)
  const width = $derived(snap?.state.settings.sidebarWidth ?? 264)
</script>

{#if snap}
  <div class="root" style="{themeVars(workspace(snap).color)}--sw:{width}px">
    {#if snap.mode === 'edge'}
      <div class="edge" role="presentation" onmouseenter={() => actions.setMode('peek')}></div>
    {:else if snap.mode === 'peek'}
      <div
        class="panel peek"
        role="presentation"
        onmouseenter={() => clearTimeout(hideTimer)}
        onmouseleave={() => (hideTimer = setTimeout(() => !renaming && !editingWorkspace && actions.setMode('edge'), 180))}
      >
        <Sidebar {snap} bind:renaming bind:editingWorkspace onpalette={openPalette} />
      </div>
    {:else if !(snap.mode === 'full' && compact)}
      <div class="panel"><Sidebar {snap} bind:renaming bind:editingWorkspace onpalette={openPalette} /></div>
    {/if}

    {#if palette}
      {#key palette}
        <Palette {snap} mode={palette} onclose={closePalette} />
      {/key}
    {/if}
  </div>
{/if}

<style>
  .root { height: 100%; }
  .panel { width: var(--sw); height: 100%; }
  .peek {
    border-radius: 0 12px 12px 0;
    overflow: hidden;
    box-shadow: 4px 0 16px rgba(0, 0, 0, 0.45);
    animation: slide 0.14s ease-out;
  }
  @keyframes slide { from { transform: translateX(-24px); opacity: 0.4; } }
  .edge { width: 100%; height: 100%; background: var(--ws); }
</style>
