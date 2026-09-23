<script lang="ts">
  import type { Snapshot, Zone } from '@shared/types'
  import { actions, activeId, drag, hostOf, workspace } from '../lib/api.svelte'
  import Essentials from './Essentials.svelte'
  import Favicon from './Favicon.svelte'
  import Icon from './Icon.svelte'
  import TreeItem from './TreeItem.svelte'

  let {
    snap,
    renaming = $bindable(),
    editingWorkspace = $bindable(),
    onpalette
  }: {
    snap: Snapshot
    renaming: string | null
    editingWorkspace: string | null
    onpalette: (mode: 'new' | 'edit') => void
  } = $props()

  const ws = $derived(workspace(snap))
  const current = $derived(activeId(snap))
  const rt = $derived(current ? snap.tabs[current] : undefined)
  const url = $derived(rt?.url ?? (current ? snap.state.items[current]?.url : undefined))
  let showArchive = $state(false)

  // Two-finger horizontal swipe switches workspaces, like in Arc
  let swipe = 0
  let swipeLock = false
  function onWheel(e: WheelEvent): void {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || swipeLock) return
    swipe += e.deltaX
    if (Math.abs(swipe) > 90) {
      actions.cycleWorkspace(swipe > 0 ? 1 : -1)
      swipe = 0
      swipeLock = true
      setTimeout(() => (swipeLock = false), 450)
    }
  }

  function zoneDrop(zone: Zone, length: number) {
    return {
      ondragover: (e: DragEvent) => {
        if (drag.id) e.preventDefault()
      },
      ondrop: (e: DragEvent) => {
        e.preventDefault()
        if (drag.id) actions.move(drag.id, { zone, index: length })
        drag.id = null
      }
    }
  }

  function commitWorkspace(e: SubmitEvent): void {
    e.preventDefault()
    const data = new FormData(e.target as HTMLFormElement)
    actions.updateWorkspace(ws.id, {
      name: String(data.get('name') || ws.name),
      emoji: String(data.get('emoji') || ''),
      color: String(data.get('color') || ws.color)
    })
    editingWorkspace = null
  }

  function autofocus(node: HTMLInputElement): void {
    node.focus()
    node.select()
  }
</script>

<aside class="sidebar" onwheel={onWheel}>
  <header class="top">
    <div class="traffic"></div>
    <button class="ib" title="Ukryj sidebar (⌘S)" onclick={actions.toggleCompact}><Icon name="sidebar" /></button>
    <div class="spacer"></div>
    <button class="ib" disabled={!rt?.canGoBack} onclick={() => actions.nav('back')}><Icon name="back" /></button>
    <button class="ib" disabled={!rt?.canGoForward} onclick={() => actions.nav('forward')}><Icon name="forward" /></button>
    <button class="ib" onclick={() => actions.nav('reload')}><Icon name="reload" /></button>
  </header>

  <div class="url" role="button" tabindex="0" onclick={() => onpalette(current ? 'edit' : 'new')} onkeydown={() => {}}>
    <span class="host">{url ? hostOf(url) : 'Szukaj lub wpisz adres'}</span>
    {#if url}
      <button
        class="ib small"
        title="Kopiuj link (⌘⇧C)"
        onclick={(e) => {
          e.stopPropagation()
          actions.copyUrl()
        }}><Icon name="link" size={15} /></button
      >
    {/if}
  </div>

  <div class="scroll">
    <Essentials {snap} />

    <div
      class="ws-title"
      role="button"
      tabindex="0"
      oncontextmenu={(e) => {
        e.preventDefault()
        actions.workspaceMenu(ws.id)
      }}
      ondblclick={() => (editingWorkspace = ws.id)}
      onkeydown={() => {}}
    >
      <span class="emoji">{ws.emoji ?? '•'}</span>
      <span>{ws.name}</span>
    </div>

    {#if editingWorkspace === ws.id}
      <form class="ws-edit" onsubmit={commitWorkspace}>
        <input name="emoji" class="e" value={ws.emoji ?? ''} maxlength="4" />
        <input name="name" value={ws.name} use:autofocus />
        <input name="color" type="color" value={ws.color} />
        <button type="submit" class="ok">OK</button>
      </form>
    {/if}

    <section class="pinned" role="tree" {...zoneDrop('pinned', ws.pinned.length)}>
      {#each ws.pinned as id, i (id)}
        <TreeItem {snap} {id} zone="pinned" index={i} bind:renaming />
      {/each}
      {#if !ws.pinned.length}
        <div class="placeholder">Przeciągnij tu karty, aby je przypiąć</div>
      {/if}
    </section>

    <div class="divider">
      <span class="line"></span>
      {#if ws.today.length}
        <button class="txt" title="Sortuj według domeny" onclick={actions.tidy}><Icon name="broom" size={13} /> Tidy</button>
        <button class="txt" onclick={actions.clear}>Clear</button>
      {/if}
    </div>

    <button class="new-tab" onclick={() => onpalette('new')}>
      <Icon name="plus" size={15} />
      <span>New Tab</span>
    </button>

    <section class="today" role="tree" {...zoneDrop('today', ws.today.length)}>
      {#each ws.today as id, i (id)}
        <TreeItem {snap} {id} zone="today" index={i} bind:renaming />
      {/each}
    </section>
  </div>

  {#if showArchive}
    <div class="archive">
      <div class="archive-head">Archiwum <button class="ib small" onclick={() => (showArchive = false)}><Icon name="x" size={14} /></button></div>
      {#each snap.state.archive.slice(0, 80) as a, i (a.archivedAt + a.url)}
        <button
          class="arow"
          onclick={() => {
            actions.restoreArchived(i)
            showArchive = false
          }}
        >
          <Favicon src={a.favicon} label={a.title} />
          <span class="t">{a.title}</span>
        </button>
      {:else}
        <div class="placeholder">Brak zamkniętych kart</div>
      {/each}
    </div>
  {/if}

  <footer class="bottom">
    <button class="ib" title="Archiwum" onclick={() => (showArchive = !showArchive)}><Icon name="archive" /></button>
    <div class="dots">
      {#each snap.state.workspaces as w (w.id)}
        <button
          class="dot"
          class:on={w.id === ws.id}
          title={w.name}
          onclick={() => actions.switchWorkspace(w.id)}
          oncontextmenu={(e) => {
            e.preventDefault()
            actions.workspaceMenu(w.id)
          }}
        >
          {#if w.id === ws.id}{w.emoji ?? '●'}{:else}<span></span>{/if}
        </button>
      {/each}
    </div>
    <button class="ib" title="Nowy workspace" onclick={actions.newWorkspace}><Icon name="plus" /></button>
  </footer>
</aside>

<style>
  .sidebar {
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 0 8px 0 10px;
    background: var(--ws);
    background-image: linear-gradient(rgba(var(--fg-rgb), 0.025), rgba(var(--fg-rgb), 0));
  }
  .top {
    height: 44px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    -webkit-app-region: drag;
  }
  .traffic { width: 66px; }
  .spacer { flex: 1; }
  .ib {
    -webkit-app-region: no-drag;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 7px;
    color: var(--dim);
    flex: none;
  }
  .ib:hover:not(:disabled) { background: var(--hover); color: var(--fg); }
  .ib:disabled { opacity: 0.35; }
  .ib.small { width: 24px; height: 24px; }
  .url {
    flex: none;
    display: flex;
    align-items: center;
    height: 36px;
    padding: 0 6px 0 12px;
    margin-bottom: 10px;
    border-radius: 10px;
    background: var(--tile);
  }
  .url:hover { background: var(--active); }
  .host { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; margin-right: -4px; padding-right: 4px; }
  .ws-title {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 10px;
    font-weight: 600;
    color: var(--dim);
  }
  .emoji { font-size: 14px; }
  .ws-edit { display: flex; gap: 4px; padding: 0 6px 8px; }
  .ws-edit input {
    min-width: 0;
    flex: 1;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid rgba(var(--fg-rgb), 0.15);
    border-radius: 6px;
    padding: 4px 6px;
    outline: none;
  }
  .ws-edit .e { flex: none; width: 36px; text-align: center; }
  .ws-edit input[type='color'] { flex: none; width: 30px; padding: 0 2px; }
  .ok { padding: 0 8px; border-radius: 6px; background: var(--accent); color: white; }
  .pinned { min-height: 12px; }
  .placeholder { padding: 8px 10px; color: var(--faint); font-size: 12px; }
  .divider { display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 8px; }
  .line { flex: 1; height: 1px; background: rgba(var(--fg-rgb), 0.1); }
  .txt { display: flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--faint); font-weight: 500; }
  .txt:hover { color: var(--fg); }
  .new-tab {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 36px;
    padding: 0 10px;
    border-radius: 9px;
    color: var(--dim);
  }
  .new-tab:hover { background: var(--hover); }
  .today { min-height: 80px; padding-bottom: 12px; }
  .bottom {
    flex: none;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dots { flex: 1; display: flex; justify-content: center; align-items: center; gap: 2px; overflow: hidden; }
  .dot {
    width: 20px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    font-size: 14px;
  }
  .dot span { width: 5px; height: 5px; border-radius: 50%; background: var(--faint); }
  .dot:hover span { background: var(--fg); }
  .archive {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 48px;
    max-height: 60%;
    overflow-y: auto;
    padding: 6px;
    border-radius: 12px;
    background: rgba(28, 28, 32, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    z-index: 10;
    color: #f0f0f2;
  }
  .archive-head { display: flex; justify-content: space-between; align-items: center; padding: 2px 6px 6px; font-weight: 600; }
  .arow { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px; border-radius: 7px; text-align: left; }
  .arow:hover { background: rgba(255, 255, 255, 0.08); }
  .arow .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
