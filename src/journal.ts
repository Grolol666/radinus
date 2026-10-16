/**
 * A bot's journal: a text file, one JSON object per line, appended to, never rewritten. The times are those of the DATA (never the machine's clock): a replay
 * interrupted then resumed gives the same file, byte for byte.
 *
 * Resume: the existing file is read again; for each line the program produces, as long as there is a line already written at that place it must be identical (otherwise the replay is not the one that wrote the journal: it stops),
 * then lines are appended. A cut last line (no newline: the program died while writing it) is dropped.
 */

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, truncateSync, writeFileSync } from 'node:fs'

const TAIL_CHUNK = 65536

/** The last `n` whole lines of a journal file, oldest first, read from the end of the file in chunks (the page asks for 200 lines of a file that may hold days). A file that is missing gives no line. */
export function tailLines(path: string, n: number): string[] {
  if (!existsSync(path)) return []
  const fd = openSync(path, 'r')
  let end = statSync(path).size
  let text = Buffer.alloc(0)
  // Chunks are joined as bytes, decoded once: a chunk boundary can fall inside a multi-byte character.
  while (end > 0 && text.toString('utf8').split('\n').length <= n + 1) {
    const size = Math.min(TAIL_CHUNK, end)
    const chunk = Buffer.alloc(size)
    readSync(fd, chunk, 0, size, end - size)
    text = Buffer.concat([chunk, text])
    end -= size
  }
  closeSync(fd)
  const lines = text.toString('utf8').split('\n')
  // Without a start of file in hand, the first piece may be the end of a longer line: dropped. The last piece is what follows the final newline (empty, or a line still being written).
  if (end > 0) lines.shift()
  lines.pop()
  return lines.slice(-n)
}

export class Journal {
  readonly path: string
  private readonly existing: string[]
  private written = 0
  /** Called at each line written (the live console, the state to write). */
  observer: ((event: Record<string, unknown>) => void) | null = null

  private constructor(path: string, existing: string[]) {
    this.path = path
    this.existing = existing
  }

  /** A new journal: the file must not exist, or be empty. */
  static fresh(path: string): Journal {
    if (existsSync(path) && readFileSync(path, 'utf8').length > 0) throw new Error(`${path} already exists: take it up with "resume", or choose another folder`)
    writeFileSync(path, '')
    return new Journal(path, [])
  }

  /** A live journal: the file is created if it is missing and lines are appended, without reading or checking anything (a live run cannot be replayed: the world writes it). A cut last line is removed. */
  static append(path: string): Journal {
    if (!existsSync(path)) writeFileSync(path, '')
    const text = readFileSync(path, 'utf8')
    const cut = text.lastIndexOf('\n') + 1
    if (cut < text.length) truncateSync(path, Buffer.byteLength(text.slice(0, cut)))
    return new Journal(path, [])
  }

  /** A journal to resume: its whole lines are read again, a cut line at the end is removed from the file. */
  static resume(path: string): Journal {
    if (!existsSync(path)) return Journal.fresh(path)
    const text = readFileSync(path, 'utf8')
    const cut = text.lastIndexOf('\n') + 1
    if (cut < text.length) truncateSync(path, Buffer.byteLength(text.slice(0, cut)))
    return new Journal(path, text.slice(0, cut).split('\n').filter((l) => l.length > 0))
  }

  /** How many lines are written (taken up or appended). */
  get count(): number {
    return this.written
  }

  write(event: Record<string, unknown>): void {
    const line = JSON.stringify(event)
    if (this.written < this.existing.length) {
      if (this.existing[this.written] !== line) throw new Error(`${this.path} line ${this.written + 1}: the replay would write something other than what the journal holds\n  journal: ${this.existing[this.written]}\n  replay : ${line}`)
    } else appendFileSync(this.path, `${line}\n`)
    this.written++
    this.observer?.(event)
  }
}
