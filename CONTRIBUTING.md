# Contributing

Thanks for your interest! Bug reports, ideas, translations, plugins and code are all welcome. Issues and pull requests
may be written in English or German.

When reporting a bug, please include the version (Settings or `GET /api/v1/health`), how you run BasaltNotes (Docker,
TrueNAS, `npm`), what you did, what you expected and what happened – for server errors the matching lines from the
container log. Please **don't paste real notes, tokens or passwords** into issues. Security issues go through
[SECURITY.md](SECURITY.md), not public issues.

## Development setup

Requirements: Node.js ≥ 22.13 (24 recommended) and git.

```bash
npm install
npm run dev            # API on :8080, data in ./data
npm run dev:web        # UI on :5173, proxies /api to :8080
npm run build          # build server, UI, SDK and built-in plugins
docker build -t basaltnotes:dev .
```

On the first start `ADMIN_PASSWORD=... npm run dev` creates the account `admin`. The setup step can create an
**example vault** with a fictional campaign so there is something to try right away.

The AI features need a local [Ollama](https://ollama.com) (`LLM_URL=http://localhost:11434`).

Layout:

| Folder | Contents |
|---|---|
| `server/` | Fastify API, vault handling (Markdown + git), index (SQLite via `node:sqlite`), curator, chat, plugin manager |
| `web/` | User interface (React, CodeMirror 6, Vite) |
| `packages/client/` | JS SDK for other apps (`@basaltnotes/client`) |
| `packages/plugin-sdk/` | Types and build helper for plugins |
| `plugins/` | Built-in plugins (e.g. `calendar`: Calendar & CalDAV) |
| `docs/` | Manual (English `manual.md`, German `handbuch.md`, incl. API reference) and plans |

## Tests

```bash
npm test               # server tests (Vitest), no LLM needed – a fake model lives in server/test/helpers.ts
npm run i18n:check     # missing translations and broken placeholders
```

New endpoints and curator behaviour get a test in `server/test/`. `npm run build && npm test` must pass; the CI
(GitHub Actions) runs build, tests, the translation check and a Docker build on every push and pull request.

## Guidelines

- **The files are the source of truth.** A vault stays a plain folder of Markdown files that can be opened in Obsidian.
  The index can be rebuilt at any time.
- **Never overwrite silently.** Every change is a git commit; curator changes can be undone.
- **Small local models.** Whatever can be done programmatically (pre-selection, linking, matching) happens without the LLM.
- **AI is optional.** Without a language model BasaltNotes must be a complete note app.
- **Style:** TypeScript, Prettier formatting as in the existing code (2 spaces, no semicolons, single quotes, lines up to
  about 180 characters). Code comments are German; match the surrounding code.
- **Commit messages:** a short summary line, then what changed and why. Write in English or German.
- **No private data in tests or examples:** use invented names, `nas.local`/`localhost` addresses and placeholder tokens.
- New API endpoints go into the manual (`docs/manual.md` and `docs/handbuch.md`, section API reference).
- Pull requests: short description of what, why and how it was tested.

## Translations

The interface is available in English and German. Visible texts are written in German in the code and go through `tr()`:

```tsx
import { tr } from '../lib/i18n'
tr('Neue Notiz')                       // → “New note”
tr('{n} Notizen', { n: items.length }) // placeholders in curly braces
```

- **Interface:** English texts in [`web/src/locales/en.json`](web/src/locales/en.json) (key = German text). If an entry
  is missing, the German text is shown.
- **API messages:** in [`server/src/locales/en.ts`](server/src/locales/en.ts); `{x}` stands for inserted values. The
  server answers in English with `X-Basalt-Lang: en` (sent by the interface) or `Accept-Language: en`.
- **Don't translate stored values:** statuses, choice values (`offen`, `erledigt` …) and type names stay German in the
  code and in the notes; only their display is translated (`tr(value)`).
- `npm run i18n:check` shows missing translations and wrong placeholders (the CI checks this too).
- Another language: add `web/src/locales/<code>.json` and register it in `web/src/lib/i18n.ts` (`LANGS`, `DICTS`).
- Plugins bring their own translations: `ctx.registerTranslations('en', { 'Mein Text': 'My text' })`.

## Writing plugins

A plugin is a folder with `manifest.json` and optionally a server part and a UI part. The built-in calendar plugin in
[`plugins/calendar`](plugins/calendar) is a complete example; the interface is described in the
[manual, section “Plugins”](docs/manual.md#plugins).

Smallest example – a page with a menu entry:

```json
{ "id": "hello", "name": "Hello", "version": "0.1.0", "web": "dist/web.js", "default_enabled": true }
```

```tsx
// src/web.tsx
import type { WebPluginContext } from '@basaltnotes/plugin-sdk/web'
import { useApp } from '@basaltnotes/plugin-sdk/web'

function Hello() {
  const { me } = useApp()
  return <div className="page"><h1>Hello {me?.name}</h1></div>
}

export default function activate(ctx: WebPluginContext) {
  ctx.registerPage({ path: 'hello', scope: 'vault', component: Hello })
  ctx.registerNav({ id: 'hello', label: 'Hello', icon: 'sparkle', path: 'hello' })
}
```

```js
// build.mjs
import { buildPlugin } from '@basaltnotes/plugin-sdk/build'
await buildPlugin({ root: import.meta.dirname, web: 'src/web.tsx' })
```

Put the built folder (with `manifest.json` and `dist/`) into `/data/plugins/hello/` and restart the container. React and
the app's building blocks are provided by BasaltNotes – don't bundle them. `icon` takes the name of one of the app's
line icons (see `Icon` in `@basaltnotes/plugin-sdk/web`). Plugins run with the app's privileges; server endpoints get the
same permission and area checks as the core via `ctx.helpers`.

## License

By contributing you agree that your contribution is published under the project's [MIT license](LICENSE).

## Deutsch

Beiträge auf Deutsch sind willkommen – Issues, Pull Requests und Diskussionen dürfen deutsch sein. Die Kommentare im Code
sind deutsch, das Handbuch gibt es auf Deutsch ([`docs/handbuch.md`](docs/handbuch.md)) und Englisch; die Pläne unter
`docs/` sind nur deutsch.
