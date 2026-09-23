<script lang="ts">
  import type { Snapshot } from '@shared/types'
  import { actions, activeId, hostOf } from '../lib/api.svelte'
  import Favicon from './Favicon.svelte'

  let { snap, mode, onclose }: { snap: Snapshot; mode: 'new' | 'edit'; onclose: () => void } = $props()

  type Suggestion = Awaited<ReturnType<typeof actions.suggest>>[number]

  // The palette is re-created on every open, so reading the initial values is intended
  // svelte-ignore state_referenced_locally
  const current = activeId(snap)
  // svelte-ignore state_referenced_locally
  let query = $state(mode === 'edit' && current ? (snap.tabs[current]?.url ?? snap.state.items[current]?.url ?? '') : '')
  let results = $state<Suggestion[]>([])
  let selected = $state(0)
  let seq = 0
  const looksLikeUrl = $derived(/^\S+\.\S+$/.test(query.trim()))

  $effect(() => {
    const q = query
    const mine = ++seq
    actions.suggest(q).then((r) => {
      if (mine === seq) {
        results = r
        selected = 0
      }
    })
  })

  function go(s?: Suggestion): void {
    if (s?.kind === 'tab' && s.id) actions.open(s.id)
    else {
      const target = s?.url ?? query.trim()
      if (!target) return
      if (mode === 'edit' && current) actions.navigate(target)
      else actions.newTab(target)
    }
    onclose()
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onclose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      selected = Math.min(selected + 1, results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selected = Math.max(selected - 1, 0)
    } else if (e.key === 'Enter') {
      // Row 0 is always "use what I typed"
      go(selected === 0 ? undefined : results[selected - 1])
    }
  }

  function autofocus(node: HTMLInputElement): void {
    node.focus()
    node.select()
  }
</script>

<div class="backdrop" role="presentation" onmousedown={onclose}>
  <div class="palette" role="dialog" tabindex="-1" onmousedown={(e) => e.stopPropagation()}>
    <input
      bind:value={query}
      use:autofocus
      onkeydown={onKey}
      placeholder={mode === 'new' ? 'Szukaj lub wpisz adres…' : 'Adres'}
      spellcheck="false"
    />
    {#if query.trim()}
      <div class="results">
        <button class="res" class:sel={selected === 0} onmouseenter={() => (selected = 0)} onclick={() => go()}>
          <span class="kind">↵</span>
          <span class="t">{query}</span>
          <span class="u">{looksLikeUrl ? 'Otwórz' : 'Szukaj w Google'}</span>
        </button>
        {#each results as r, i}
          <button class="res" class:sel={selected === i + 1} onmouseenter={() => (selected = i + 1)} onclick={() => go(r)}>
            <Favicon src={r.favicon ?? `https://www.google.com/s2/favicons?domain=${hostOf(r.url)}&sz=64`} label={r.title} />
            <span class="t">{r.title}</span>
            <span class="u">{r.kind === 'tab' ? 'Przełącz na kartę' : hostOf(r.url)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.25);
    display: flex;
    justify-content: center;
    padding-top: 16vh;
    z-index: 100;
  }
  .palette {
    width: min(640px, 90vw);
    height: fit-content;
    background: rgba(32, 32, 36, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 14px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
    overflow: hidden;
    color: #f0f0f2;
  }
  input {
    width: 100%;
    height: 54px;
    padding: 0 18px;
    font-size: 17px;
    background: transparent;
    border: 0;
    outline: none;
  }
  .results { border-top: 1px solid rgba(255, 255, 255, 0.08); padding: 6px; }
  .res {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    height: 38px;
    padding: 0 12px;
    border-radius: 8px;
    text-align: left;
  }
  .res.sel { background: rgba(108, 140, 255, 0.28); }
  .kind { width: 16px; text-align: center; opacity: 0.6; }
  .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .u { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.5; font-size: 12px; }
</style>
