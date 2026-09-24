<script lang="ts">
  import { call } from '../lib/api.svelte'
  import Icon from './Icon.svelte'

  let query = $state('')
  let result = $state<{ active: number; total: number } | null>(null)
  let input: HTMLInputElement

  window.drift.onFound((r) => (result = r))
  window.drift.onCommand((cmd) => {
    if (cmd.type === 'find-focus') input.select()
    if (cmd.type === 'find-next') step(true)
    if (cmd.type === 'find-prev') step(false)
  })

  function step(forward: boolean): void {
    if (query) call('find', query, forward, true)
  }

  $effect(() => {
    const q = query
    if (!q) result = null
    call('find', q, true, false)
  })

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') call('find-close')
    if (e.key === 'Enter') step(!e.shiftKey)
  }
</script>

<div class="bar">
  <input bind:this={input} bind:value={query} onkeydown={onKey} placeholder="Find on page" spellcheck="false" autofocus />
  <span class="count">{result && query ? `${result.active}/${result.total}` : ''}</span>
  <button title="Previous (⇧↵)" onclick={() => step(false)}><Icon name="back" size={14} /></button>
  <button title="Next (↵)" onclick={() => step(true)}><Icon name="forward" size={14} /></button>
  <button title="Close (Esc)" onclick={() => call('find-close')}><Icon name="x" size={14} /></button>
</div>

<style>
  .bar {
    margin: 4px;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px 0 12px;
    border-radius: 12px;
    background: rgba(32, 32, 36, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
    color: #f0f0f2;
  }
  input { flex: 1; min-width: 0; background: none; border: 0; outline: none; font-size: 14px; }
  .count { font-size: 12px; opacity: 0.55; min-width: 36px; text-align: right; }
  button { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 6px; opacity: 0.75; }
  button:hover { background: rgba(255, 255, 255, 0.1); opacity: 1; }
</style>
