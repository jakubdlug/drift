<script lang="ts">
  const paths: Record<string, string> = {
    sidebar: 'M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5zM8 3v14',
    back: 'M12.5 4 6.5 10l6 6',
    forward: 'M7.5 4l6 6-6 6',
    reload: 'M15.5 10a5.5 5.5 0 1 1-1.6-3.9M16 3.5V7h-3.5',
    link: 'M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9',
    folder: 'M3 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 7.8v6.7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z',
    folderOpen: 'M3 14.5V6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.8h5.2A1.5 1.5 0 0 1 16 7.8V9M3 14.5 5 9.5A1.5 1.5 0 0 1 6.4 8.5h10.1a1 1 0 0 1 .9 1.4l-2 4.8A1.5 1.5 0 0 1 14 16H4.5A1.5 1.5 0 0 1 3 14.5z',
    plus: 'M10 4v12M4 10h12',
    x: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
    minus: 'M5 10h10',
    archive: 'M3.5 4.5h13v3h-13zM4.5 7.5v7.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V7.5M8.5 10.5h3',
    speaker: 'M4 8h2.5L10 5v10l-3.5-3H4zM13 7.5a3.5 3.5 0 0 1 0 5M14.8 5.5a6.3 6.3 0 0 1 0 9',
    broom: 'M13 3l-4.5 7M5 11h7l1 6H4zM7 17v-3M10 17v-3'
  }
  let { name, size = 16 }: { name: keyof typeof paths | string; size?: number } = $props()
</script>

<svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={paths[name]} />
</svg>
