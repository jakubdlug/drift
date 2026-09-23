<script lang="ts">
  let { src, label = '', size = 16 }: { src?: string; label?: string; size?: number } = $props()
  let failed = $state(false)
  $effect(() => {
    src
    failed = false
  })
</script>

{#if src && !failed}
  <img {src} alt="" width={size} height={size} style="border-radius:3px;flex:none" onerror={() => (failed = true)} draggable="false" />
{:else}
  <span class="letter" style="width:{size}px;height:{size}px;font-size:{size * 0.62}px">{label.slice(0, 1).toUpperCase()}</span>
{/if}

<style>
  .letter {
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 4px;
    background: var(--active);
    font-weight: 600;
  }
</style>
