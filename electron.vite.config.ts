import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared }, build: { sourcemap: true } },
  preload: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared } },
  renderer: { plugins: [svelte()], resolve: { alias: shared } }
})
