/**
 * Anbindung an die Android-App (android/): Die App zeigt diese Oberfläche im WebView und stellt window.BasaltApp bereit.
 * Alles hier wirkt für die ganze Seite, also auch für Plugins – sie brauchen für Downloads und Zwischenablage nichts Eigenes.
 */

interface NativeBridge {
  version(): string
  server(): string
  changeServer(): void
  /** Fehlt in App-Versionen vor der Update-Funktion */
  checkUpdates?(): void
  getShare(): string | null
  clearShare(): void
  copy(text: string): void
  setBars(color: string): void
  saveFile(name: string, mime: string, base64: string): void
}

export const nativeApp = (globalThis as any).BasaltApp as NativeBridge | undefined

/** Die Plattform, auf der die Oberfläche gerade läuft (für Plugins im SDK) */
export const platform: 'web' | 'android' = nativeApp ? 'android' : 'web'

export interface SharedContent {
  title: string | null
  text: string | null
  files: { name: string; type: string; url: string }[]
}

export function nativeShare(): SharedContent | null {
  const raw = nativeApp?.getShare()
  return raw ? JSON.parse(raw) : null
}

async function saveBlob(bridge: NativeBridge, blob: Blob, name: string) {
  const reader = new FileReader()
  const data = await new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  bridge.saveFile(name, blob.type, data.slice(data.indexOf(',') + 1))
}

export function installNativeBridge() {
  const bridge = nativeApp
  if (!bridge) return

  // Im Browser erzeugte Downloads (blob:) kann der WebView nicht selbst speichern. Lesen per fetch verbietet die CSP
  // des Servers, deshalb merken wir uns die Blobs beim Erzeugen der Adresse.
  const blobs = new Map<string, Blob>()
  const createObjectURL = URL.createObjectURL.bind(URL)
  const revokeObjectURL = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = createObjectURL(obj)
    if (obj instanceof Blob) blobs.set(url, obj)
    return url
  }
  URL.revokeObjectURL = (url: string) => {
    blobs.delete(url)
    revokeObjectURL(url)
  }
  const intercept = (a: HTMLAnchorElement) => {
    const blob = a.hasAttribute('download') ? blobs.get(a.href) : undefined
    if (!blob) return false
    void saveBlob(bridge, blob, a.download || 'download')
    return true
  }
  const click = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (!intercept(this)) click.call(this)
  }
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a')
      if (a && intercept(a)) e.preventDefault()
    },
    true,
  )

  // navigator.clipboard gibt es nur bei https – die App kann es auch im Heimnetz über http
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => bridge.copy(text) },
    })
  }

  // Zurück-Taste: erst Dialoge und Seitenleiste schließen; true = erledigt
  ;(window as any).basaltBack = () => {
    const overlay = document.querySelector<HTMLElement>('.overlay.open')
    if (overlay) {
      overlay.click()
      return true
    }
    if (document.querySelector('.modal-backdrop')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      return true
    }
    return false
  }

  // Systemleisten folgen dem Farbschema der Oberfläche
  const syncBars = () => bridge.setBars(getComputedStyle(document.documentElement).getPropertyValue('--bg-2').trim())
  new MutationObserver(syncBars).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncBars)
  syncBars()
}
