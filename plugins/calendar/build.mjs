import { buildPlugin } from '@basaltnotes/plugin-sdk/build'

await buildPlugin({ root: import.meta.dirname, server: 'src/server.ts', web: 'src/web.tsx', styles: 'src/web.css' })
console.log('Kalender-Plugin gebaut')
