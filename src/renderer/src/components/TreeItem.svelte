<script lang="ts">
  import type { ItemId, Snapshot, Zone } from '@shared/types'
  import { actions, activeId, displayTitle, drag, faviconOf } from '../lib/api.svelte'
  import Favicon from './Favicon.svelte'
  import Icon from './Icon.svelte'
  import Self from './TreeItem.svelte'

  let {
    snap,
    id,
    zone,
    parentId,
    index,
    depth = 0,
    renaming = $bindable()
  }: {
    snap: Snapshot
    id: ItemId
    zone: Zone
    parentId?: ItemId
    index: number
    depth?: number
    renaming: ItemId | null
  } = $props()

  const item = $derived(snap.state.items[id])
  const rt = $derived(snap.tabs[id])
  const active = $derived(activeId(snap) === id)
  const today = $derived(zone === 'today')
  const loaded = $derived(!!rt && !rt.sleeping)

  let dropPos = $state<'before' | 'after' | 'into' | null>(null)

  function onDragOver(e: DragEvent): void {
    if (!drag.id || drag.id === id) return
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = (e.clientY - r.top) / r.height
    dropPos = item.kind === 'folder' && y > 0.25 && y < 0.75 ? 'into' : y < 0.5 ? 'before' : 'after'
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const dragged = drag.id
    const pos = dropPos
    dropPos = null
    drag.id = null
    if (!dragged || !pos) return
    if (pos === 'into') actions.move(dragged, { zone: 'folder', parentId: id, index: 0 })
    else actions.move(dragged, { zone, parentId, index: pos === 'before' ? index : index + 1 })
  }

  function commitRename(e: Event): void {
    const value = (e.target as HTMLInputElement).value.trim()
    if (value) actions.rename(id, value)
    renaming = null
  }

  function autofocus(node: HTMLInputElement): void {
    node.focus()
    node.select()
  }
</script>

{#if item}
  <div
    class="row"
    class:active
    class:incognito={item.incognito}
    class:folder={item.kind === 'folder'}
    class:dim={item.kind === 'tab' && !loaded && !today}
    class:drop-before={dropPos === 'before'}
    class:drop-after={dropPos === 'after'}
    class:drop-into={dropPos === 'into'}
    style="padding-left:{10 + depth * 14}px"
    draggable="true"
    role="treeitem"
    aria-selected={active}
    tabindex="-1"
    ondragstart={(e) => {
      drag.id = id
      e.dataTransfer?.setData('text/plain', item.url ?? item.title)
    }}
    ondragend={() => (drag.id = null)}
    ondragover={onDragOver}
    ondragleave={() => (dropPos = null)}
    ondrop={onDrop}
    onclick={() => actions.open(id)}
    onauxclick={(e) => e.button === 1 && item.kind === 'tab' && actions.close(id)}
    oncontextmenu={(e) => {
      e.preventDefault()
      actions.itemMenu(id)
    }}
    ondblclick={() => item.kind === 'folder' && (renaming = id)}
    onkeydown={() => {}}
  >
    {#if item.kind === 'folder'}
      <span class="icon"><Icon name={item.collapsed ? 'folder' : 'folderOpen'} /></span>
    {:else}
      <span class="icon" class:loading={rt?.loading}>
        <Favicon src={faviconOf(item, rt)} label={item.title} />
      </span>
    {/if}

    {#if renaming === id}
      <input
        class="rename"
        value={item.title}
        use:autofocus
        onblur={commitRename}
        onkeydown={(e) => {
          if (e.key === 'Enter') commitRename(e)
          if (e.key === 'Escape') renaming = null
        }}
        onclick={(e) => e.stopPropagation()}
      />
    {:else}
      <span class="title">{displayTitle(item, rt, today)}</span>
    {/if}

    {#if item.incognito}<span class="private" title="Incognito">🕶</span>{/if}
    {#if rt?.audible}<span class="audio"><Icon name="speaker" size={14} /></span>{/if}

    {#if item.kind === 'tab' && (today || loaded)}
      <button
        class="close"
        title={today ? 'Close' : 'Unload'}
        onclick={(e) => {
          e.stopPropagation()
          actions.close(id)
        }}
      >
        <Icon name={today ? 'x' : 'minus'} size={14} />
      </button>
    {/if}
  </div>

  {#if item.kind === 'folder' && !item.collapsed}
    {#each item.children ?? [] as child, i (child)}
      <Self {snap} id={child} zone="folder" parentId={id} index={i} depth={depth + 1} bind:renaming />
    {/each}
    {#if !item.children?.length}
      <div class="empty" style="padding-left:{34 + depth * 14}px">Empty folder</div>
    {/if}
  {/if}
{/if}

<style>
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding-right: 6px;
    margin: 1px 0;
    border-radius: 9px;
    white-space: nowrap;
  }
  .row:hover { background: var(--hover); }
  .row.active {
    background: var(--active);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .row.dim .title { opacity: 0.72; }
  .row.incognito { background: rgba(140, 100, 255, 0.1); }
  .row.incognito.active { background: rgba(140, 100, 255, 0.24); }
  .private { font-size: 12px; opacity: 0.8; }
  .folder .title { font-weight: 600; }
  .icon {
    flex: none;
    width: 16px;
    height: 16px;
    display: grid;
    place-items: center;
    color: var(--dim);
  }
  .icon.loading { animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13.5px;
  }
  .audio { color: var(--dim); display: grid; }
  .close {
    display: none;
    width: 22px;
    height: 22px;
    place-items: center;
    border-radius: 6px;
    color: var(--dim);
  }
  .row:hover .close { display: grid; }
  .close:hover { background: var(--hover); color: var(--fg); }
  .rename {
    flex: 1;
    min-width: 0;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--accent);
    border-radius: 5px;
    padding: 2px 5px;
    outline: none;
  }
  .empty { height: 28px; line-height: 28px; color: var(--faint); font-size: 12px; }
  .drop-before::before,
  .drop-after::after {
    content: '';
    position: absolute;
    left: 8px;
    right: 8px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  .drop-before::before { top: -2px; }
  .drop-after::after { bottom: -2px; }
  .drop-into { outline: 2px solid var(--accent); outline-offset: -2px; }
</style>
