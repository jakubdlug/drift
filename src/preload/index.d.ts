import type { DriftApi } from './index'

declare global {
  interface Window {
    drift: DriftApi
  }
}
