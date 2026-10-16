/**
 * `/bot`'s chart drawings (a study aid, never read by the bot): lines, horizontal lines and Fibonacci retracements, kept per market.
 * A point is {time (unix seconds, the chart's own time), price}, so a drawing stays where it was put whatever the zoom and whichever view (1m or 1s) shows it. The tool being used and the first point of a drawing in progress live here too; the chart's input (`drawingsInput.ts`) writes them, the toolbar and the primitive read them. No React.
 */

export type Point = { time: number; price: number }
export type DrawingKind = 'line' | 'hline' | 'fib'
/** `b` is null for a horizontal line. `name` is optional (trimmed, may be empty): the script reads a drawing by it (`state.drawing(name)`). */
export type Drawing = { id: string; kind: DrawingKind; a: Point; b: Point | null; name?: string }
export type Tool = DrawingKind | 'erase' | null
/** What changed: the drawings (`list`: a drawing added, removed, renamed, or a drag ended; also what the draft saves and the bot replays on), a point while it is dragged (`move`: the primitives redraw, nothing else), the tool / the drawing in progress, the transient note, or the selection. */
export type DrawingsEvent = 'list' | 'move' | 'tool' | 'note' | 'select'

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const
/** The kept drawings are bounded: a draft that grew past this is cut, not trusted. */
const MAX_PER_MARKET = 200
const NOTE_MS = 1500
const MAX_NAME = 40

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isPoint = (x: unknown): x is Point => typeof x === 'object' && x !== null && isNum((x as Point).time) && isNum((x as Point).price)

/** One market's drawings read back (the draft, a bot definition sent to `radinus/`): at most `MAX_PER_MARKET`, anything that is not a well-formed drawing dropped, names trimmed and cut. */
export function sanitizeDrawings(value: unknown): Drawing[] {
  const kept: Drawing[] = []
  if (!Array.isArray(value)) return kept
  for (const x of value.slice(0, MAX_PER_MARKET) as Partial<Drawing>[]) {
    if (typeof x !== 'object' || x === null || typeof x.id !== 'string' || !isPoint(x.a)) continue
    const name = typeof x.name === 'string' && x.name.trim() !== '' ? { name: x.name.trim().slice(0, MAX_NAME) } : {}
    if (x.kind === 'hline') kept.push({ id: x.id, kind: 'hline', a: x.a, b: null, ...name })
    else if ((x.kind === 'line' || x.kind === 'fib') && isPoint(x.b)) kept.push({ id: x.id, kind: x.kind, a: x.a, b: x.b, ...name })
  }
  return kept
}

function createDrawings() {
  const byMarket = new Map<string, Drawing[]>()
  const subs = new Set<(e: DrawingsEvent) => void>()
  let market = 'none'
  let tool: Tool = null
  let pending: Point | null = null
  let selected: string | null = null
  let preview: Point | null = null
  let note: string | null = null
  let noteTimer: ReturnType<typeof setTimeout> | null = null
  let seq = 0
  const emit = (e: DrawingsEvent) => {
    for (const fn of subs) fn(e)
  }
  const list = (): Drawing[] => byMarket.get(market) ?? []
  const put = (next: Drawing[]) => {
    if (next.length === 0) byMarket.delete(market)
    else byMarket.set(market, next)
    emit('list')
  }
  const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`
  const reset = () => {
    tool = null
    pending = null
    preview = null
  }
  const select = (id: string | null) => {
    if (id === selected) return
    selected = id
    emit('select')
  }
  return {
    subscribe(fn: (e: DrawingsEvent) => void): () => void {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    market: () => market,
    /** The drawings shown are those of this market (`null` before the page knows it). */
    setMarket(id: number | null) {
      const key = id === null ? 'none' : `m${id}`
      if (key === market) return
      market = key
      reset()
      select(null)
      emit('list')
      emit('tool')
    },
    list,
    /** The drawing picked by a click or a drag (null when none). */
    selected: () => selected,
    select,
    tool: () => tool,
    setTool(next: Tool) {
      tool = tool === next ? null : next
      if (tool !== null) select(null)
      pending = null
      preview = null
      emit('tool')
    },
    /** Escape: leaves the tool, and the drawing in progress with it. */
    cancel() {
      if (tool === null) return
      reset()
      emit('tool')
    },
    /** A click with a drawing tool: a horizontal line is done at once, the others at their second point; the tool is then released. */
    place(p: Point) {
      if (tool === null || tool === 'erase') return
      if (tool === 'hline') {
        put([...list(), { id: newId(), kind: 'hline', a: p, b: null }])
      } else if (pending === null) {
        pending = p
        emit('tool')
        return
      } else {
        put([...list(), { id: newId(), kind: tool, a: pending, b: p }])
      }
      reset()
      emit('tool')
    },
    setPreview(p: Point | null) {
      if (pending === null && preview === null) return
      preview = p
      emit('tool')
    },
    /** The drawing being placed (first point set, second following the mouse), null otherwise. */
    draft(): Drawing | null {
      if (tool === null || tool === 'erase' || tool === 'hline' || pending === null || preview === null) return null
      return { id: 'draft', kind: tool, a: pending, b: preview }
    },
    /** A point dragged: the list is changed in place of `put` and only `move` is emitted; `commit` (pointer up) emits `list` once. */
    move(id: string, which: 'a' | 'b', p: Point) {
      byMarket.set(market, list().map((d) => (d.id !== id ? d : which === 'a' ? { ...d, a: p } : { ...d, b: p })))
      emit('move')
    },
    commit() {
      emit('list')
    },
    /** The drawings of a market by its id (`null`: none), whichever market the chart shows now. */
    of: (id: number | null): readonly Drawing[] => byMarket.get(id === null ? 'none' : `m${id}`) ?? [],
    /** A drawing's name, trimmed; nothing happens when it does not change. */
    rename(id: string, name: string) {
      const next = name.trim().slice(0, MAX_NAME)
      const cur = list()
      if (cur.every((d) => d.id !== id || (d.name ?? '') === next)) return
      put(cur.map((d) => (d.id !== id ? d : { ...d, name: next })))
    },
    remove(id: string) {
      if (id === selected) select(null)
      put(list().filter((d) => d.id !== id))
    },
    clear() {
      select(null)
      put([])
    },
    note: () => note,
    /** A tiny message the toolbar shows for a moment. */
    notify(text: string) {
      note = text
      if (noteTimer !== null) clearTimeout(noteTimer)
      noteTimer = setTimeout(() => {
        note = null
        emit('note')
      }, NOTE_MS)
      emit('note')
    },
    /** One market's drawings replaced by `raw` (a sketch or a bot loaded on `/bot`), anything not well-formed dropped. */
    replaceOf(id: number, raw: unknown) {
      const key = `m${id}`
      const kept = sanitizeDrawings(raw)
      if (key === market) {
        reset()
        select(null)
      }
      if (kept.length === 0) byMarket.delete(key)
      else byMarket.set(key, kept)
      emit('list')
    },
    /** All markets, for the draft (empty markets left out). */
    serialize(): Record<string, Drawing[]> {
      return Object.fromEntries(byMarket)
    },
    /** From the draft: anything that is not a well-formed drawing is dropped. */
    restore(raw: unknown) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
      for (const [key, value] of Object.entries(raw)) {
        if (!Array.isArray(value)) continue
        const kept = sanitizeDrawings(value)
        if (kept.length > 0) byMarket.set(key, kept)
      }
      emit('list')
    },
  }
}

export const chartDrawings = createDrawings()
