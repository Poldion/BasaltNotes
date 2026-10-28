// Service Worker: App-Shell cachen, API-Lesezugriffe „Netzwerk zuerst“ mit Cache-Rückfall (Offline-Lesen)
const SHELL = 'basalt-shell-v1'
const DATA = 'basalt-data-v1'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/icon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/v1/events')) return
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(DATA).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() => caches.match(req).then((r) => r || new Response(JSON.stringify({ error: { code: 'offline', message: 'Offline – keine zwischengespeicherte Version.' } }), { status: 503, headers: { 'content-type': 'application/json' } }))),
    )
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); return res })))
    return
  }
  // Navigation: Netzwerk zuerst, sonst App-Shell
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put('/', copy)); return res }).catch(() => caches.match('/')))
  }
})
