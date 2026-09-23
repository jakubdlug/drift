import { contextBridge, ipcRenderer } from 'electron'
import type { Snapshot } from '@shared/types'

const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(channel, ...args),
  onSnapshot: (fn: (s: Snapshot) => void): void => {
    ipcRenderer.on('snapshot', (_e, s: Snapshot) => fn(s))
  },
  onCommand: (fn: (cmd: Record<string, string>) => void): void => {
    ipcRenderer.on('command', (_e, cmd) => fn(cmd))
  }
}

contextBridge.exposeInMainWorld('drift', api)

export type DriftApi = typeof api
