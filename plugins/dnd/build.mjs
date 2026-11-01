import { buildPlugin } from '@basaltnotes/plugin-sdk/build'

await buildPlugin({ root: import.meta.dirname, server: 'src/server.ts', web: 'src/web.tsx' })
console.log('D&D-Plugin gebaut')
