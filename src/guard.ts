/**
 * What leaves the PC: the program talks only to the hosts of the data source it was started with (`src/sources/`).
 * `guardNetwork` wraps the `fetch` and the `WebSocket` the copied core code uses as they are: any other host is refused,
 * and every call is counted, so the program says at the end what it really asked.
 */

import type { Source } from './sources/types'

export type NetworkCounts = { fetches: Map<string, number>; sockets: number; summary: () => string }

export function guardNetwork(source: Pick<Source, 'name' | 'fetchHosts' | 'socketHosts'>): NetworkCounts {
  const fetches = new Map<string, number>()
  const counts: NetworkCounts = { fetches, sockets: 0, summary: () => '' }
  const socketHosts = new Set<string>()
  const inner = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (!source.fetchHosts.includes(url.hostname)) throw new Error(`host refused: ${url.hostname} (the ${source.name} source talks only to ${source.fetchHosts.join(' and ')})`)
    const key = `${url.hostname}${url.pathname}`
    fetches.set(key, (fetches.get(key) ?? 0) + 1)
    return inner(input, init)
  }) as typeof fetch
  const Inner = globalThis.WebSocket
  class GuardedWebSocket extends Inner {
    constructor(url: string | URL, protocols?: string | string[]) {
      const host = new URL(typeof url === 'string' ? url : url.href).hostname
      if (!source.socketHosts.includes(host)) throw new Error(`socket refused: ${host} (the ${source.name} source opens a socket only on ${source.socketHosts.join(' and ')})`)
      counts.sockets++
      socketHosts.add(host)
      super(url, protocols)
    }
  }
  globalThis.WebSocket = GuardedWebSocket as typeof WebSocket
  counts.summary = () => `${counts.sockets} socket connection(s)${socketHosts.size === 0 ? '' : ` (${[...socketHosts].join(', ')})`}; ${[...fetches].map(([k, n]) => `${k} x${n}`).join(', ') || 'no call'}`
  return counts
}
