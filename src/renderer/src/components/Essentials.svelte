<script lang="ts">
  import type { Snapshot } from '@shared/types'
  import { actions, activeId, drag, faviconOf, workspace } from '../lib/api.svelte'
  import Favicon from './Favicon.svelte'

  let { snap }: { snap: Snapshot } = $props()

  const ids = $derived(snap.state.essentials[workspace(snap).profileId] ?? [])
  let dropIndex = $state<number | null>(null)

  function drop(e: DragEvent, index: number): void {
    e.preventDefault()
    e.stopPropagation()
    if (drag.id) actions.move(drag.id, { zone: 'essentials', index })
    drag.id = null
    dropIndex = null
  }
</script>

<div
  class="grid"
  class:empty={!ids.length}
  role="list"
  ondragover={(e) => {
    if (!drag.id) return
    e.preventDefault()
    dropIndex = ids.length
  }}
  ondragleave={() => (dropIndex = null)}
  ondrop={(e) => drop(e, ids.length)}
>
  {#each ids as id, i (id)}
    {@const item = snap.state.items[id]}
    {@const rt = snap.tabs[id]}
    {#if item}
      <button
        class="tile"
        class:active={activeId(snap) === id}
        class:drop={dropIndex === i}
        title={item.title}
        draggable="true"
        ondragstart={() => (drag.id = id)}
        ondragend={() => (drag.id = null)}
        ondragover={(e) => {
          if (!drag.id) return
          e.preventDefault()
          e.stopPropagation()
          dropIndex = i
        }}
        ondrop={(e) => drop(e, i)}
        onclick={() => actions.open(id)}
        oncontextmenu={(e) => {
          e.preventDefault()
          actions.itemMenu(id)
        }}
      >
        <Favicon src={faviconOf(item, rt)} label={item.title} size={17} />
        {#if rt?.badge}<span class="badge"></span>{/if}
      </button>
    {/if}
  {/each}
  {#if !ids.length}
    <div class="hint">Przeciągnij tu kartę, aby dodać ją do Essentials</div>
  {/if}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
    gap: 6px;
    padding: 4px 0 10px;
  }
  .grid.empty { grid-template-columns: 1fr; }
  .tile {
    position: relative;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 10px;
    background: var(--tile);
    transition: background 0.1s;
  }
  .tile:hover { background: var(--active); }
  .tile.active {
    background: rgba(var(--fg-rgb), 0.2);
    box-shadow: inset 0 0 0 1px rgba(var(--fg-rgb), 0.12);
  }
  .tile.drop { box-shadow: -3px 0 0 var(--accent); }
  .badge {
    position: absolute;
    bottom: 6px;
    right: calc(50% - 13px);
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ff4d4d;
    box-shadow: 0 0 0 2px var(--ws);
  }
  .hint {
    border: 1px dashed rgba(var(--fg-rgb), 0.2);
    border-radius: 12px;
    padding: 14px;
    text-align: center;
    color: var(--faint);
    font-size: 12px;
  }
</style>
