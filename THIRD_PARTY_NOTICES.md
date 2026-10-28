# Third-party software

The code of this repository is licensed under the [MIT license](LICENSE). Dependencies are installed via npm and are not
part of the repository. In the Docker image `poldion/basaltnotes` they are included with their license files under
`node_modules/`.

BasaltNotes ships no machine-learning models and no third-party data. The language model you connect via Ollama keeps its
own license. The example vault (“Beispiel – Die Nebelküste”) is original content of this project.

## Direct dependencies

| Component | License | Purpose |
|---|---|---|
| [Fastify](https://github.com/fastify/fastify) and `@fastify/*` (cookie, cors, multipart, rate-limit, static, swagger) | MIT | Server |
| [@node-rs/argon2](https://github.com/napi-rs/node-rs) | MIT | Password hashes |
| [chokidar](https://github.com/paulmillr/chokidar) | MIT | Detecting changes in the vault |
| [diff](https://github.com/kpdecker/jsdiff) | BSD-3-Clause | Diff view |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | BSD-2-Clause | Reading Word documents |
| [jszip](https://github.com/Stuk/jszip) (via mammoth) | MIT or GPL-3.0 – used under **MIT** | ZIP handling |
| [markdown-it](https://github.com/markdown-it/markdown-it) | MIT | Markdown rendering |
| [sanitize-html](https://github.com/apostrophecms/sanitize-html) | MIT | Sanitising HTML |
| [ulid](https://github.com/ulid/javascript) | MIT | Stable note IDs |
| [unpdf](https://github.com/unjs/unpdf) (pdf.js) | MIT (pdf.js: Apache-2.0) | Reading PDFs |
| [yaml](https://github.com/eemeli/yaml) | ISC | Frontmatter |
| [React](https://github.com/facebook/react), React DOM, [React Router](https://github.com/remix-run/react-router) | MIT | User interface |
| [CodeMirror 6](https://github.com/codemirror/dev) and [Lezer](https://github.com/lezer-parser) | MIT | Editor |
| [d3-force](https://github.com/d3/d3-force) | ISC | Graph view |
| [esbuild](https://github.com/evanw/esbuild) | MIT | Building plugins (build time only) |

## Docker image

| Component | License | Purpose |
|---|---|---|
| [Node.js](https://nodejs.org/) (`node:24-bookworm-slim`, Debian base) | MIT (Debian packages: their respective licenses) | Runtime |
| [git](https://git-scm.com/) | GPL-2.0 | Version history of the vaults; called as a separate program, not linked |
| [tini](https://github.com/krallin/tini) | MIT | Init process in the container |

## Other dependencies

All other runtime dependencies are under permissive licenses (MIT, ISC, BSD-2/3-Clause, Apache-2.0, BlueOak-1.0.0, 0BSD,
Zlib, PSF-2.0). `lightningcss` (MPL-2.0) is only used to build the user interface and is not part of the finished program.

## Trademarks

“Obsidian” is a trademark of Dynalist Inc. “Dungeons & Dragons” and “D&D” are trademarks of Wizards of the Coast.
BasaltNotes is an independent project and not affiliated with either.
