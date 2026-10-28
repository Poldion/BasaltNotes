import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Mutex } from './lib/util.js'

export interface GitCommit {
  rev: string
  date: string
  message: string
  author: string
}

/** git je Vault – Verlauf, Diff, Wiederherstellen, Rückgängig. */
export class Git {
  private mutex = new Mutex()
  /** Grund, falls das Repository unbrauchbar ist – dann wird nicht committet, die Notizen bleiben nutzbar. */
  broken: string | null = null
  constructor(readonly dir: string) {}

  private exec(args: string[], opts: { allowFail?: boolean; input?: string } = {}): Promise<{ stdout: string; code: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        ['-c', 'core.quotepath=off', '-c', 'core.autocrlf=false', ...args],
        { cwd: this.dir, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
        (err, stdout, stderr) => {
          const code = err ? ((err as any).code ?? 1) : 0
          if (err && !opts.allowFail) reject(new Error(`git ${args[0]} fehlgeschlagen: ${stderr || err.message}`))
          else resolve({ stdout: String(stdout), stderr: String(stderr), code: typeof code === 'number' ? code : 1 })
        },
      )
      if (opts.input !== undefined) child.stdin?.end(opts.input)
    })
  }

  async init(): Promise<void> {
    const gitDir = path.join(this.dir, '.git')
    if (fs.existsSync(gitDir)) {
      if (await this.valid()) return
      // Leerer/angefangener .git-Ordner (ohne HEAD): ergänzen – git init überschreibt nichts Vorhandenes
      if (!fs.existsSync(path.join(gitDir, 'HEAD'))) await this.exec(['init', '-q', '-b', 'main'], { allowFail: true })
      if (!(await this.valid())) {
        const r = await this.exec(['rev-parse', '--git-dir'], { allowFail: true })
        this.broken = (r.stderr || 'unbekannter Fehler').trim().split('\n')[0]
        return
      }
      await this.ensureIdentity()
      return
    }
    await this.exec(['init', '-q', '-b', 'main'])
    await this.ensureIdentity()
    const ignore = path.join(this.dir, '.gitignore')
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '.trash/\n.obsidian/workspace*.json\n*.tmp\n', 'utf8')
  }

  private async valid(): Promise<boolean> {
    const r = await this.exec(['rev-parse', '--git-dir'], { allowFail: true })
    return r.code === 0 && path.resolve(this.dir, r.stdout.trim()) === path.join(this.dir, '.git')
  }

  private async ensureIdentity(): Promise<void> {
    await this.exec(['config', 'user.name', 'BasaltNotes'])
    await this.exec(['config', 'user.email', 'basaltnotes@localhost'])
  }

  /** Alles committen. Gibt den Commit-Hash zurück oder null, wenn nichts geändert wurde. */
  commitAll(message: string): Promise<string | null> {
    if (this.broken) return Promise.resolve(null)
    return this.mutex.run(async () => {
      await this.exec(['add', '-A'])
      const st = await this.exec(['status', '--porcelain'])
      if (!st.stdout.trim()) return null
      await this.exec(['commit', '-q', '-m', message])
      return (await this.exec(['rev-parse', 'HEAD'])).stdout.trim()
    })
  }

  log(file?: string, limit = 100): Promise<GitCommit[]> {
    return this.mutex.run(async () => {
      const args = ['log', `-n${limit}`, '--format=%H%x1f%aI%x1f%an%x1f%s%x1e']
      if (file) args.push('--follow', '--', file)
      const r = await this.exec(args, { allowFail: true })
      if (r.code !== 0) return []
      return r.stdout
        .split('\x1e')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => {
          const [rev, date, author, message] = line.split('\x1f')
          return { rev, date, author, message }
        })
    })
  }

  /** Pfad einer Datei zu einem bestimmten Commit (folgt Umbenennungen). */
  async pathAt(rev: string, file: string): Promise<string | null> {
    const r = await this.exec(['log', '--follow', '--name-only', '--format=%H', '--', file], { allowFail: true })
    if (r.code !== 0) return null
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(rev) || rev.startsWith(lines[i])) return lines[i + 1] ?? null
    }
    return null
  }

  show(rev: string, file: string): Promise<string | null> {
    return this.mutex.run(async () => {
      if (!/^[0-9a-f]{4,40}$/i.test(rev)) return null
      const p = (await this.pathAt(rev, file)) ?? file
      const r = await this.exec(['show', `${rev}:${p}`], { allowFail: true })
      return r.code === 0 ? r.stdout : null
    })
  }

  /** Inhalt einer Datei genau zu einem Commit (ohne Umbenennungs-Verfolgung). `rev` darf auf ^ enden. */
  fileAt(rev: string, file: string): Promise<string | null> {
    return this.mutex.run(async () => {
      if (!/^[0-9a-f]{4,40}\^?$/i.test(rev)) return null
      const r = await this.exec(['show', `${rev}:${file}`], { allowFail: true })
      return r.code === 0 ? r.stdout : null
    })
  }

  /** Geänderte Dateien eines Commits mit Status (A, M, D). */
  changes(rev: string): Promise<{ status: string; path: string }[]> {
    return this.mutex.run(async () => {
      const r = await this.exec(['show', '--name-status', '--no-renames', '--format=', rev], { allowFail: true })
      return r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [status, ...rest] = l.split('\t')
          return { status: status[0], path: rest.join('\t') }
        })
    })
  }

  changedFiles(rev: string): Promise<string[]> {
    return this.mutex.run(async () => {
      const r = await this.exec(['show', '--name-only', '--format=', rev], { allowFail: true })
      return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    })
  }

  /** Macht einen Commit rückgängig. Bei Konflikt wird abgebrochen und ein Fehler geworfen. */
  revert(rev: string, message: string): Promise<string> {
    return this.mutex.run(async () => {
      await this.exec(['add', '-A'])
      const st = await this.exec(['status', '--porcelain'])
      if (st.stdout.trim()) await this.exec(['commit', '-q', '-m', 'Ungesicherte Änderungen vor Rückgängig'])
      const r = await this.exec(['revert', '--no-edit', rev], { allowFail: true })
      if (r.code !== 0) {
        await this.exec(['revert', '--abort'], { allowFail: true })
        throw new Error(`Rückgängig nicht möglich (Konflikt mit späteren Änderungen): ${r.stderr.trim()}`)
      }
      await this.exec(['commit', '--amend', '-q', '-m', message], { allowFail: true })
      return (await this.exec(['rev-parse', 'HEAD'])).stdout.trim()
    })
  }
}
