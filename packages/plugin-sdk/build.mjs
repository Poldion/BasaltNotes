/**
 * Build-Hilfe für BasaltNotes-Plugins (esbuild).
 *
 *   import { buildPlugin } from '@basaltnotes/plugin-sdk/build'
 *   await buildPlugin({ root: import.meta.dirname, server: 'src/server.ts', web: 'src/web.tsx', styles: 'src/web.css' })
 *
 * Server-Teil: ein ESM-Bündel für Node. Oberflächen-Teil: ein ESM-Bündel für den Browser, in dem React,
 * react-router-dom und '@basaltnotes/plugin-sdk/web' NICHT enthalten sind – sie kommen zur Laufzeit von der App
 * (globalThis.basalt), damit Plugin und App dieselben Instanzen benutzen.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'

/** Namen, die die App unter globalThis.basalt.sdk bereitstellt */
export const WEB_SDK_EXPORTS = ['api', 'enc', 'qs', 'useApp', 'useTypes', 'useVaultEvents', 'Modal', 'Spinner', 'TypeDot', 'relTime', 'fmtDate', 'fmtDateTime', 'tr', 'lang', 'locale', 'Icon', 'embedNavigate', 'slugify']

const IDENT = /^[A-Za-z_$][\w$]*$/

async function namesOf(root, mod) {
  const require = createRequire(path.join(root, 'package.json'))
  const m = require(mod)
  return Object.keys(m).filter((k) => k !== 'default' && IDENT.test(k))
}

function shim(global, names, withDefault = true) {
  return [`const M = globalThis.basalt.${global};`, withDefault ? 'export default M;' : '', ...names.map((n) => `export const ${n} = M.${n};`)].join('\n')
}

/** esbuild-Plugin: App-Module aus globalThis.basalt statt mitbündeln */
export async function appGlobals(root) {
  const modules = {
    react: shim('React', await namesOf(root, 'react')),
    'react/jsx-runtime': shim('jsxRuntime', ['jsx', 'jsxs', 'Fragment'], false),
    'react-router-dom': shim('ReactRouterDom', await namesOf(root, 'react-router-dom'), false),
    '@basaltnotes/plugin-sdk/web': shim('sdk', WEB_SDK_EXPORTS, false),
  }
  return {
    name: 'basalt-app-globals',
    setup(build) {
      build.onResolve({ filter: /^(react|react\/jsx-runtime|react-router-dom|@basaltnotes\/plugin-sdk\/web)$/ }, (args) => ({ path: args.path, namespace: 'basalt-app' }))
      build.onLoad({ filter: /.*/, namespace: 'basalt-app' }, (args) => ({ contents: modules[args.path], loader: 'js' }))
    },
  }
}

export async function buildPlugin({ root, server, web, styles, outdir = 'dist', minify = true }) {
  const out = path.join(root, outdir)
  fs.mkdirSync(out, { recursive: true })
  if (server) {
    await esbuild.build({
      entryPoints: [path.join(root, server)],
      outfile: path.join(out, 'server.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      // Laufzeit-Abhängigkeiten der App nicht mitbündeln
      external: ['fastify'],
      minify,
      legalComments: 'none',
    })
  }
  if (web) {
    await esbuild.build({
      entryPoints: [path.join(root, web)],
      outfile: path.join(out, 'web.js'),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      jsx: 'automatic',
      plugins: [await appGlobals(root)],
      minify,
      legalComments: 'none',
    })
  }
  if (styles) fs.copyFileSync(path.join(root, styles), path.join(out, 'web.css'))
}
