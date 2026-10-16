/**
 * Renumbering of a family at its first start under the id rule of 2026-10-08 (`<number>-<MARKET>`, bots.ts `botIdOf`): every bot of the family, active and retired, gets a number in the order it was launched
 * (its `debut`, ties by its current id). The plan is pure; direct.ts applies it (definitions, journal files, etat.json, bots.json) and writes the line `renumbering` in programme.jsonl.
 */

import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { parseJson } from './core/radinusMessages'
import { botIdOf } from './bots'

export type RenumberItem = { id: string; market: string; debutMs: number }
export type RenumberStep = { from: string; to: string }

/** The new id of every item, in launch order, and the number the next launch takes. */
export function planRenumbering(items: RenumberItem[]): { steps: RenumberStep[]; nextNumber: number } {
  const ordered = [...items].sort((a, b) => a.debutMs - b.debutMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { steps: ordered.map((it, k) => ({ from: it.id, to: botIdOf(k + 1, it.market) })), nextNumber: ordered.length + 1 }
}

const HEAD_BYTES = 65536

/** The market and the start instant that a journal's `demarrage` line says, `null` when the file is missing or has no such line in its first 64 KB (a retired bot whose journal is gone is placed first, by id). */
export function startOfJournal(path: string): { market: string; debutMs: number } | null {
  if (!existsSync(path)) return null
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(HEAD_BYTES)
  const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
  closeSync(fd)
  const lines = buf.toString('utf8', 0, n).split('\n')
  lines.pop()
  for (const raw of lines) {
    const l = raw.length === 0 ? undefined : parseJson(raw)
    if (typeof l !== 'object' || l === null) continue
    const e = l as Record<string, unknown>
    if (e.evenement === 'demarrage' && typeof e.marche === 'string' && typeof e.heure === 'string' && !Number.isNaN(Date.parse(e.heure))) return { market: e.marche, debutMs: Date.parse(e.heure) }
  }
  return null
}
