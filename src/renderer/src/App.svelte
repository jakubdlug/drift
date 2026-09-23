<script lang="ts">
  import type { Snapshot } from '@shared/types'
  import { actions, app, themeVars, ui, workspace } from './lib/api.svelte'
  import Palette from './components/Palette.svelte'
  import Sidebar from './components/Sidebar.svelte'

  let palette = $state<'new' | 'edit' | null>(null)
  let renaming = $state<string | null>(null)
  let editingWorkspace = $state<string | null>(null)
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  window.drift.invoke('snapshot').then((s) => {
    app.snap = s as Snapshot
  })
  window.drift.onSnapshot((s) => {
    app.snap = s
  })
  window.drift.onCommand((cmd) => {
    if (cmd.type === 'palette') openPalette(cmd.mode as 'new' | 'edit')
    if (cmd.type === 'rename') {
      renaming = cmd.id
      if (app.snap?.state.settings.compact) peek()
    }
    if (cmd.type === 'edit-workspace') editingWorkspace = cmd.id
    if (cmd.type === 'peek' && app.snap?.state.settings.compact) peek()
  })

  async function openPalette(mode: 'new' | 'edit'): Promise<void> {
    // The palette covers the window; after it the overlay starts closed again
    peekOpen = false
    await actions.palette(true)
    palette = mode
  }

  function closePalette(): void {
    palette = null
    actions.palette(false)
    actions.focusPage()
  }

  // Compact mode: the overlay stays mounted and only slides, so hovering the edge is instant
  let peekOpen = $state(false)

  // Edits of things that no longer exist (deleted workspace, removed item) must not keep the sidebar pinned open
  $effect(() => {
    const st = app.snap?.state
    if (!st) return
    if (editingWorkspace && !st.workspaces.some((w) => w.id === editingWorkspace)) editingWorkspace = null
    if (renaming && !st.items[renaming]) renaming = null
  })

  // Docking (⌘S) ends any peek; a stale "open" would break the next hover
  $effect(() => {
    if (app.snap?.mode === 'docked') peekOpen = false
  })

  async function peek(): Promise<void> {
    clearTimeout(hideTimer)
    hideTimer = undefined
    if (peekOpen) return
    // Grow the native view first, then start the slide on a painted frame
    await actions.setMode('peek')
    requestAnimationFrame(() => requestAnimationFrame(() => (peekOpen = true)))
  }

  function scheduleHide(): void {
    if (hideTimer || !peekOpen) return
    hideTimer = setTimeout(() => {
      hideTimer = undefined
      // Only a form that is actually on screen keeps the panel open
      const editingHere = editingWorkspace && editingWorkspace === app.snap?.state.activeWorkspaceId
      if (!renaming && !editingHere) peekOpen = false
    }, 80)
  }

  /**
   * Track the pointer across the whole view rather than trusting enter/leave on the
   * panel: when the panel slides in under a still cursor, the browser never "enters" it.
   */
  function onPointer(e: MouseEvent): void {
    if (!overlay || palette) return
    if (e.clientX <= width) peek()
    else scheduleHide()
  }

  function onSlideEnd(e: TransitionEvent): void {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return
    ui.animating = false
    // Shrink the view back to the hot-zone only once the panel is fully out
    if (!peekOpen) actions.setMode('edge')
  }

  // Mirror local state for the control channel
  let lastPeek = false
  $effect(() => {
    if (peekOpen !== lastPeek) {
      lastPeek = peekOpen
      ui.animating = true
      // Fallback in case transitionend never fires (e.g. view hidden mid-slide)
      setTimeout(() => (ui.animating = false), 400)
    }
    ui.peekOpen = peekOpen
    ui.palette = palette
    ui.renaming = renaming
    ui.editingWorkspace = editingWorkspace
  })

  const snap = $derived(app.snap)
  const overlay = $derived(
    !!snap && (snap.mode === 'edge' || snap.mode === 'peek' || (snap.mode === 'full' && snap.state.settings.compact))
  )
  const width = $derived(snap?.state.settings.sidebarWidth ?? 264)
</script>

{#if snap}
  <div class="root" role="presentation" onmousemove={onPointer} onmouseleave={() => overlay && scheduleHide()} style="{themeVars(workspace(snap).color)}--sw:{width}px">
    {#if overlay}
      <div class="edge" role="presentation" onmouseenter={peek}></div>
      <div
        class="panel overlay"
        class:open={peekOpen}
        role="presentation"
        ontransitionend={onSlideEnd}
      >
        <Sidebar {snap} bind:renaming bind:editingWorkspace onpalette={openPalette} />
      </div>
    {:else}
      <div class="panel"><Sidebar {snap} bind:renaming bind:editingWorkspace onpalette={openPalette} /></div>
    {/if}

    {#if !snap.hasPage && snap.mode !== 'full'}
      {@const ws = workspace(snap)}
      <div class="empty" style="left:{overlay ? 8 : width}px">
        <div class="empty-card">
          <div class="empty-emoji">{ws.emoji ?? '✨'}</div>
          <div class="empty-title">{ws.name}</div>
          <div class="empty-sub">Brak otwartej karty w tym workspace</div>
          <div class="empty-actions">
            <button onclick={() => openPalette('new')}>Nowa karta <kbd>⌘T</kbd></button>
            {#if overlay}<button onclick={actions.toggleCompact}>Pokaż sidebar <kbd>⌘S</kbd></button>{/if}
          </div>
        </div>
      </div>
    {/if}

    {#if palette}
      {#key palette}
        <Palette {snap} mode={palette} onclose={closePalette} />
      {/key}
    {/if}
  </div>
{/if}

<style>
  .root { position: relative; height: 100%; }
  .panel { width: var(--sw); height: 100%; }
  .edge { position: absolute; inset: 0 auto 0 0; width: 8px; background: var(--ws); }
  .overlay {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 0 12px 12px 0;
    overflow: hidden;
    box-shadow: 6px 0 24px rgba(0, 0, 0, 0.45);
    z-index: 5;
    transform: translateX(calc(-100% - 28px));
    transition: transform 140ms cubic-bezier(0.4, 0, 1, 1);
    will-change: transform;
  }
  .empty {
    position: absolute;
    top: 8px;
    right: 8px;
    bottom: 8px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    background: rgba(var(--fg-rgb), 0.04);
    border: 1px solid rgba(var(--fg-rgb), 0.08);
  }
  .empty-card { text-align: center; }
  .empty-emoji { font-size: 40px; margin-bottom: 8px; }
  .empty-title { font-size: 18px; font-weight: 600; }
  .empty-sub { margin-top: 4px; color: var(--dim); }
  .empty-actions { margin-top: 18px; display: flex; gap: 8px; justify-content: center; }
  .empty-actions button {
    padding: 8px 14px;
    border-radius: 9px;
    background: var(--tile);
    border: 1px solid rgba(var(--fg-rgb), 0.1);
  }
  .empty-actions button:hover { background: var(--active); }
  kbd { margin-left: 6px; color: var(--dim); font: inherit; font-size: 12px; }
  .overlay.open {
    transform: none;
    transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }
</style>
