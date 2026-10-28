import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..', '..')
const version = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')).version

describe('Version', () => {
  it('maßgeblich ist package.json im Hauptordner – die Teilpakete der App tragen dieselbe Nummer', () => {
    const v = version('package.json')
    expect(v).toMatch(/^\d+\.\d+\.\d+$/)
    for (const p of ['server/package.json', 'web/package.json', 'packages/client/package.json', 'packages/plugin-sdk/package.json']) {
      expect(version(p), p).toBe(v)
    }
  })

  it('CHANGELOG.md hat einen Eintrag für die aktuelle Version', () => {
    const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
    expect(log).toContain(`## [${version('package.json')}]`)
  })
})
