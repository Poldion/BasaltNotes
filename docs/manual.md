# BasaltNotes – Manual

🇬🇧 English · 🇩🇪 [Deutsch](handbuch.md)

A self-hosted note-taking app in the spirit of Obsidian – with several vaults, `[[wiki links]]`, backlinks,
properties, full-text search and an **AI curator** that files new content (e.g. session recaps from WhisperNotes)
into your notes on its own: it creates new NPCs, places and quests, extends existing ones, learns spelling variants
(“Cydia” → Zylia) as aliases – and never overwrites anything silently.

The files are the source of truth: every vault is a plain folder of Markdown files (with git history) and can be opened
in Obsidian at the same time.

> **Language note:** the user interface is available in English and German. The built-in templates, type names stored in
> `vault.yaml`, field values such as `offen`/`erledigt` and the curator's section headings (e.g. “Aus den Sessions”) are
> German in the files; the interface shows them translated.

---

## Features

| Area | What it does |
|---|---|
| **Notes** | Markdown + YAML frontmatter, stable IDs (ULID), types with folders, templates and properties. D&D types: campaign, session, script (prep), character, NPC, monster, location, faction, item, quest, lore, facts. Everyday: note, journal, task, list, event, recipe, idea, bookmark, how-to, meeting, person, project – plus **your own types** with fields, folder and template (vault settings → types) |
| **Free vaults** | Vault kind “Free”: only the type “Note”, folders as you like, free properties, a new note is just title + folder. Date fields in the frontmatter (`start`, `date`, `due`) show up in the calendar |
| **Linking mentions** | “Link mentions” in the note menu turns the first mention of other notes (titles, aliases) into a link – with preview, without AI. As the curator mode “Link only” it also runs automatically for the inbox, even with AI switched off |
| **Plugins** | Your own extensions with a server and a UI part (pages, menu entries, settings, endpoints); Calendar & CalDAV is a built-in plugin |
| **Home Assistant** | Calendars and to-do lists via CalDAV (plugin “Calendar & CalDAV”; also phones/Thunderbird – ticking off and adding list items ends up in the note), notes by voice/automation, notes for the dashboard |
| **Calendar** (plugin) | Month and list view per notebook or across all: events (also all-day, multi-day, recurring), due tasks to tick off, sessions, meetings, prep scripts and your own types with a date field |
| **Everyday** | “Today” opens the journal entry of the day; checklists (`- [ ]`) can be ticked off in the reading view – e.g. shopping and packing lists |
| **Editor** | CodeMirror 6 with live preview, `[[` autocomplete incl. aliases, paste/drop images, autosave, conflict detection |
| **Links** | Backlinks with context, outgoing links, unresolved links create the note with one click, renaming updates all links |
| **Search** | Full text (SQLite FTS5) with snippets, filters by type/campaign/tag/property, quick switcher <kbd>Ctrl</kbd>+<kbd>O</kbd>, Dataview-like queries |
| **History** | git commit per save (batched) and per curator run, diff and restore per note, trash, ZIP export |
| **Ask** | Chat with your notes: matching entries are pre-selected without the LLM (names, typos, overviews, mentions, full text), the model only gets those – built for small local models |
| **AI optional** | Curator and chat are off on a fresh install – switch them on in the setup step after the first sign-in or under Settings → Features; only then do inbox, proposals, curator log and Ask appear in the menu |
| **AI curator** | Recognise → match → plan → apply/propose; rules per vault; dry run; progress display with stop button; “undo run” |
| **Documents** | Upload PDF, Word, text and Markdown to the inbox: the text is extracted, the original stored as an attachment, the curator files it |
| **Prep** | Type “Script (prep)” for pre-game scripts: own folder, template with scenes and secrets, status planned/played/discarded, DM only; on the campaign page under “Prep” |
| **Users** | Several accounts with roles (admin, edit, read, player), vault access per account, locking, password reset |
| **Campaigns** | Home page with “previously on”, timeline, open quests, characters, recently changed entries, player view |
| **Integration** | REST API, OpenAPI, server-sent events, webhooks (HMAC-signed), iframe embeds with `postMessage`, JS SDK |
| **Interface** | English and German, light/dark, works down to phone width, installable as a PWA (offline reading), graph view |

---

## Installation on TrueNAS SCALE

The ready-made image is on Docker Hub: **`poldion/basaltnotes`**.

1. **Create a dataset for the vaults:** *Datasets → Add Dataset*, name `BasaltVaults` (preset “Generic” or “Apps”).
   You don't need to set permissions – the container takes care of that at start.
2. **Apps → Discover Apps → ⋮ → Install via YAML** and paste the contents of
   [`docker-compose.yml`](../docker-compose.yml). Adjust:
   - replace `./vaults` with the dataset path, e.g. `/mnt/Storage/BasaltVaults` (pool `Storage`)
   - `ADMIN_PASSWORD` – password for the first user `admin` (first start only)
   - `LLM_URL` – address of Ollama or the Ollama proxy (only for the AI features; uncomment the line)
   - the port if needed (`4400:8080` → `HOST:8080`)
3. Start it, open `http://<nas>:4400` and sign in as `admin`.
   Without `ADMIN_PASSWORD` a password is generated and printed once in the app log.
4. Create further accounts under **Settings → Users** and tokens for other apps under **API tokens**.

**Storage:**

| What | Where | Contents |
|---|---|---|
| App data | Docker volume `basaltnotes-data` → `/data` (created by TrueNAS automatically) | `config.yaml`, `index.sqlite` (users, tokens, inbox, curator log, search index) |
| Vaults | dataset `BasaltVaults` → `/data/vaults` (mounted directly) | one folder per vault with Markdown files, attachments and git history |

The container starts briefly as root, sets the ownership of `/data` (incl. vaults) to `PUID:PGID`
(default `568:568` = TrueNAS user “apps”) and then continues without root privileges.

Elsewhere with Docker Compose it works the same way: `docker compose up -d`.

### Update

Pull the image again and restart the app (TrueNAS: “Update”, or `docker compose pull && docker compose up -d`).
Data and index stay in the volume; the index is rebuilt automatically if needed.

---

## Configuration

Environment variables take precedence over `/data/config.yaml`.

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | – | Password of the first user (only if no user exists yet) |
| `ADMIN_USER` | `admin` | Name of the first user |
| `ADMIN_PASSWORD_RESET` | `false` | `true`: resets the password of `ADMIN_USER` to `ADMIN_PASSWORD` at start (emergency) |
| `FEATURE_CURATOR` / `FEATURE_CHAT` | `false` | Switch the AI curator or AI chat on at the **first** start. Afterwards the switch under Settings → Features applies (stored in `config.yaml`). Existing installations that already use the curator keep it when updating |
| `LLM_URL` | `http://localhost:11434` | Ollama or Ollama proxy for curator and chat (in a container usually `http://<ollama-host>:11434`); can also be changed under Settings → “LLM server and model” |
| `LLM_MODEL` | – | empty = the currently loaded model (`/api/ps`, otherwise `/api/tags`) |
| `LLM_NUM_CTX` | – | empty = automatic: `/api/ps` → proxy `/admin/state` (`forced_options.num_ctx`) → 4096 |
| `LLM_TIMEOUT_MS` | `600000` | Maximum wait for the **first** token (reading the prompt, possibly waiting behind other requests) |
| `LLM_IDLE_TIMEOUT_MS` | `120000` | Maximum time **without a new token**. Responses are streamed – slow models may write as long as they keep delivering |
| `LLM_THINK_CHAT` / `LLM_THINK_CURATOR` | `off` | Thinking in chat or for the curator: `off`, `on`, `low`, `medium`, `high` (levels only for gpt-oss, otherwise like `on`). Models without thinking fall back to off automatically |
| `LLM_CHAT_CONTEXT_CHARS` | `6000` | At most this many characters of notes go to the LLM per chat question (also limited by the model's context). Smaller = faster |
| `CORS_ORIGINS` | – | Comma-separated origins that may access the API from a browser (e.g. the DM panel) |
| `EMBED_ORIGINS` | = `CORS_ORIGINS` | Origins that may embed BasaltNotes as an iframe |
| `AUTH_HEADER` | – | Sign-in via a reverse proxy, e.g. `Remote-User` (Authelia/Authentik). **Only set this if the container can be reached exclusively through the proxy.** The user must exist in BasaltNotes. |
| `SESSION_TTL_HOURS` | `720` | Lifetime of a sign-in |
| `PUID` / `PGID` | `568` / `568` | User/group the app runs as and that owns the files |
| `UMASK` | `002` | Permissions of newly created files |
| `PORT` / `DATA_DIR` | `8080` / `/data` | |
| `COMMIT_DELAY_MS` | `5000` | Saves are batched into one git commit for this long |
| `WATCH_FILES` | `true` | Detect changes made from outside (SMB, Obsidian) |
| `LOG_LEVEL` / `LOG_REQUESTS` | `info` / `false` | Logging |

> **Address, model, context size and thinking can also be changed in the interface** (Settings → *LLM server and model*,
> admins only): “Test connection” lists the installed models, saving applies immediately to curator and chat without a
> restart. The values are stored as `llm_override` in `/data/config.yaml` and take **precedence** over `LLM_URL`/`LLM_MODEL`/
> `LLM_NUM_CTX`; “Reset to compose values” removes them again.

**Language:** the interface follows the browser language and can be switched with the **EN/DE** button at the bottom of the
sidebar (stored per browser). API error messages are German by default and English for requests with
`X-Basalt-Lang: en` or `Accept-Language: en`; the error `code` never changes.

### Layout of the volume

```
/data
├─ config.yaml            # settings (secret, LLM, …)
├─ index.sqlite           # index, users, tokens, inbox, runs, proposals
└─ vaults/
   ├─ dnd/                # vault “DnD” – a plain Markdown folder
   │  ├─ .basalt/vault.yaml      # types, folders, curator rules
   │  ├─ .basalt/templates/      # templates per type
   │  ├─ .git/                   # history
   │  ├─ _inbox/ _attachments/ .trash/
   │  └─ Curse of Strahd/NPCs/Zylia.md …
   └─ notizen/
```

**Backup:** the `BasaltVaults` dataset including git is the backup of your notes (plus TrueNAS snapshots).
`index.sqlite` in the app volume also holds users, tokens and the curator log – the volume lives in the apps pool and is
covered by its snapshots.

---

## Users and roles

| Role | May |
|---|---|
| **Administration** | everything, incl. users, tokens, webhooks, vault settings |
| **Member** | one permission level per notebook, like tokens (see “Grants per notebook”), optionally only an area |
| **Player** | only notes and sections with `visibility: players`, optionally only one campaign; no inbox/curator |

The older roles **Edit** (`editor`) and **Read** (`viewer`) keep working and become members with the same level when edited.
Administration and player accounts can be limited to individual vaults. Locked accounts and accounts whose permissions changed are signed out
immediately. The last admin can neither be deleted nor downgraded.
Passwords are stored with Argon2, tokens only as a hash.

---

## AI curator

```
Inbox → 1 Recognise → 2 Match → 3 Plan → 4 Apply/propose → log + git commit
```

- **Recognise:** the LLM gets the text and the known names/aliases of the campaign and answers in a fixed JSON schema
  (Ollama `format`). Long texts are split into sections of about four pages; the response is streamed, the interface shows
  the section and the tokens produced.
- **Duration:** mainly determined by the model's response speed. At ~8 tokens/s about 1–4 minutes per section,
  plus 10–20 s per uncertain name.
- **Linking:** the LLM also returns relations (quest giver, quest target, whereabouts, faction, owner, “located in”,
  allies, enemies). Both notes get a section “Beziehungen” (relations) with links in both directions
  (e.g. quest “Ziel: [[Muffgallerte]]” ↔ monster “Ziel von: [[Beseitigung des Gestanks]]”). Matching properties
  (`giver`, `location`, `faction`, `owner`, `parent`) are set directly on new entries; on existing ones they are only
  proposed, and only if the field is empty.
- **Avoiding duplicates:** entries without a campaign count across campaigns; short forms are matched to the full name
  (“Fyrn” → “Fyrn Linstök”; articles don't count: “Die Eber Jagd” = “Eberjagd”); if an entry with the same title and type
  exists, it is extended instead of creating “Name 2”.
- **Find duplicates:** button on the proposals page (without the LLM, seconds). Finds identical titles, title = alias,
  short form/full name, similar spellings and identical titles with a different type, and creates merge proposals.
  Rejected pairs are not proposed again. When merging, curator contributions move along as sections, missing properties
  are taken over and links are redirected.
- **Rooms:** rooms and areas inside a location (e.g. “Room A” of a dungeon) do not become notes of their own but
  subsections under “Räume” (rooms) in the parent location. Relations link directly to the room
  (`[[Die uralten Tunnel#Raum C – …]]`).
- **Match:** exact hit via title/alias → otherwise candidates via Jaro-Winkler, Levenshtein and Cologne phonetics → if in
  doubt the LLM decides.
- **Plan:** `create_entity`, `append_block`, `add_mention`, `add_alias` run automatically by default;
  `update_property`, `contradiction`, `merge_entities`, `update_quest`, `delete` **always** become proposals.
  Everything below `min_confidence_auto` becomes a proposal. Configurable in `vault.yaml`.
- **Safety:** the curator only writes into **managed sections**
  (`<!-- basalt:block key="…" -->…<!-- /basalt:block -->`). Your own text is kept byte for byte.
  Same source → sections are **replaced**, not duplicated. DM knowledge goes into sections with `visibility="dm"`.
- **Undo:** via git revert; if the notes have been edited since, only the run's contributions are taken back.
- **Curator modes per vault** (vault settings): *Off*, *Link only* (mentions of existing notes become links, no LLM,
  nothing is created – also works with the AI switched off) and *File (AI)*.

---

## Asking your notes (chat)

Under **Ask** in the sidebar (or in the note menu **⋯ → Ask about this note**) you can chat with your notes. So that small
models give good answers too, BasaltNotes first picks out **without the LLM** what belongs to the question and sends only
that – at most `LLM_CHAT_CONTEXT_CHARS` characters:

1. **Main topics:** titles and aliases in the question – also inflected (“Kefirs”), as a partial name (“Fyrn” for
   “Fyrn Linstök”) or with a typo (“Muffelgallerte”). For follow-ups (“And where does he live?”) the topic of the previous
   answer carries over. The main topic's content goes along with its properties; long entries are trimmed to the sections
   that contain the question's terms.
2. **Mentions:** the passages of other entries (sessions and scripts first) that link to the main topic.
3. **Linked:** directly linked entries as one-liners (location, quest giver, …).
4. **Overviews:** “Which quests are open?”, “Which NPCs are there?” → list of the type, filtered by status if needed.
5. **State and history:** “What is the current state?”, “What happened last?”, “Where is the party right now?” →
   timeline of the sessions in the order they were created or uploaded, the **newest session in detail** (sections such
   as “Ereignisse” and “Offene Handlungsstränge” first), plus the end of chronicles. Prep scripts only appear as a list,
   because they have not necessarily been played.
6. **Full text:** entries containing terms of the question, if there is room left.

Follow-ups without a topic of their own (“No, they have already left”) are evaluated together with the previous question.

If nothing is found, BasaltNotes answers directly without asking the LLM. Below every answer are the sources and, on
request, exactly the text the LLM received. Player accounts only see what is released to players (without DM sections and
sections with “(DM)” in the heading). If the curator is running, the question is answered after the current step.

The question detection is tuned for German questions (and works with English names and terms in the notes); German
phrasing gives the best pre-selection.

---

## Plugins

BasaltNotes can be extended with plugins. The **calendar including CalDAV** is a plugin itself (built in, switched on) and
serves as an example: [`plugins/calendar`](../plugins/calendar).
Switch on and off: Settings → Plugins (takes effect immediately, the page reloads).

**Structure** – a folder with `manifest.json`:

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "What it does",
  "server": "dist/server.js",
  "web": "dist/web.js",
  "styles": "dist/web.css",
  "default_enabled": false,
  "http_methods": []
}
```

Your own plugins go into `/data/plugins/<id>/` (a container restart loads them); built-in ones live in the program. A plugin
of your own cannot replace a built-in one (the same `id` is ignored).

**Server part** (`server`, ESM): exports `{ api?(app, ctx), root?(app, ctx) }`.

- `api` – endpoints under `/api/v1`. Sign-in, CSRF, permissions and grants apply as in the core.
- `root` – endpoints from `/` (e.g. `/dav`), with their own sign-in (`ctx.helpers.authenticateToken`).
- `ctx` offers: `db` (read and write access to the index), `vaults` (read/create/change notes),
  `helpers` (`vaultFor`, `noteFor`, `requireScope`, `accessOf`, `restrictSql`, `restrictionAllows`,
  `assertInArea`, `listTasks`/`setTask`/`appendTask`, `json`, `stripLink`, `error` …), `settings` (the plugin's own
  settings in `config.yaml`), `allowArea(method, url, 'read'|'write')` (allow an endpoint for accesses with an area
  restriction) and `log`.
- Switched-off plugins answer with 404 automatically, without a restart.

**UI part** (`web`, ESM in the browser): exports `default function activate(ctx)` with
`ctx.registerPage({ path, scope: 'vault'|'global', component })` (page under `/<vault>/<path>` or `/p/<path>`),
`ctx.registerNav({ id, label, icon, path, order })` (sidebar), `ctx.registerSettings({ id, component })`
(card under Settings) and `ctx.registerTranslations(lang, dict)` (own translations for `tr()`). React,
`react-router-dom` and `@basaltnotes/plugin-sdk/web` (`api`, `useApp`, `useTypes`, `useVaultEvents`, `Modal`,
`Spinner`, `TypeDot`, `tr`, `lang`, `locale` …) are provided by the app – don't bundle them.

**Building:** types and build helper are in [`packages/plugin-sdk`](../packages/plugin-sdk):

```js
// build.mjs
import { buildPlugin } from '@basaltnotes/plugin-sdk/build'
await buildPlugin({ root: import.meta.dirname, server: 'src/server.ts', web: 'src/web.tsx', styles: 'src/web.css' })
```

Plugins run with the app's privileges (server) or those of the signed-in person (UI) – only install plugins you trust.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/plugins` | signed in | Installed plugins `{id, name, version, description, builtin, enabled, error, web, styles}` |
| PUT | `/plugins/{id}` | admin | Switch on/off `{enabled}` |
| GET | `/plugins/{id}/<file>` (without `/api/v1`) | – | UI files (only from the folder of `web`/`styles`) |

---

## Integration

### WhisperNotes → inbox

```http
POST /api/v1/vaults/dnd/inbox
Authorization: Bearer <token with scopes “inbox only” + “read”>
Idempotency-Key: whispernotes:job:ab12cd34:v3

{
  "source": { "app": "whispernotes", "key": "whispernotes:job:ab12cd34", "url": "http://…" },
  "note": { "type": "session", "title": "2026-10-11 Session 1",
            "frontmatter": { "campaign": "Curse of Strahd", "date": "2026-10-11T22:00:00+02:00", "players": [ … ] },
            "body": "## Was bisher geschah\n…" },
  "attachments": [ { "name": "World & lore", "kind": "lore", "markdown": "…", "visibility": "dm" } ],
  "curate": "auto"
}
```

Response `202 {inbox_id, status, note_id}`. The session note is created immediately, the curator runs in the background.
Same `source.key` → contributions are replaced. Whisper glossary:
`GET /api/v1/vaults/dnd/names?campaign=…&types=npc,location,character` (field `glossary`).

### Home Assistant

**1. Create an access:** Settings → API tokens → new token, e.g. “Home Assistant”: notebook “Notizen” with
*read + write* (optionally “DnD” with *read only* for D&D dates). Put the token into `secrets.yaml`:

```yaml
basalt_token: "Bearer bn_…"
```

**2. Calendars and to-do lists (CalDAV, the plugin “Calendar & CalDAV” must be switched on):** *Settings → Devices &
services → Add integration → CalDAV*

| Field | Value |
|---|---|
| URL | `http://nas.local:4400/dav/` |
| User name | anything, e.g. `ha` |
| Password | the token (without “Bearer”) |

Afterwards there is one calendar per notebook, `calendar.<notebook>_termine` (events, sessions, due entries – the type
“Event” can also be edited from Home Assistant), and to-do lists: “<Notebook> – Aufgaben” (notes of type task) and
**one to-do list per list note** (e.g. `todo.einkauf`). Ticking off, adding and deleting in Home Assistant changes the
checklist in the note directly. So Assist works out of the box too: “Add milk to shopping”.

The same address works in Thunderbird, on iOS (Settings → Calendar → Accounts → CalDAV) and on Android with DAVx⁵.
Notes: BasaltNotes and the apps understand recurrence as daily, weekly, monthly or yearly (up to an end date) – more
complex rules from other apps (e.g. “every 2nd Tuesday”) are stored as a simple recurrence. Times are in the
container's time zone `TZ` (default `Europe/Berlin`).

**3. Notes by voice or automation:** `POST /api/v1/vaults/{vault}/capture` stores text – without a target as a line with
the time in today's journal, with `"list": "Einkauf"` as an item on a list, with `"to": "note"` as a new note.

```yaml
# configuration.yaml
rest_command:
  basalt_note:
    url: "http://nas.local:4400/api/v1/vaults/notizen/capture"
    method: POST
    headers:
      Authorization: !secret basalt_token
    content_type: "application/json; charset=utf-8"
    payload: '{"text": {{ text | tojson }}}'

intent_script:
  BasaltNote:
    action:
      - action: rest_command.basalt_note
        data:
          text: "{{ text }}"
    speech:
      text: "Noted."
```

```yaml
# custom_sentences/en/basalt.yaml – “Note heating bled”
language: "en"
intents:
  BasaltNote:
    data:
      - sentences:
          - "note {text}"
          - "write in my journal {text}"
lists:
  text:
    wildcard: true
```

The same works in automations, e.g. when leaving the house: `action: rest_command.basalt_note` with
`data: { text: "Left the house, windows closed" }`.

**4. Notes on the dashboard:** `?clean=1` returns the text without frontmatter and without `[[ ]]`.

```yaml
# configuration.yaml
rest:
  - resource: "http://nas.local:4400/api/v1/vaults/notizen/notes/by-title?title=Wochenplan&fields=title,body&clean=1"
    headers:
      Authorization: !secret basalt_token
    scan_interval: 300
    sensor:
      - name: "Weekly plan"
        value_template: "{{ value_json.title }}"
        json_attributes:
          - body
```

Markdown card on the dashboard: `content: "{{ state_attr('sensor.weekly_plan', 'body') }}"`. Events are shown by the
normal calendar card with `calendar.notizen_termine`, lists by the to-do card.

### DM panel

- Campaign home page in one call: `GET /api/v1/vaults/dnd/campaigns/{campaign}/overview?visibility=dm|players`
- Wiki in your own layout: `GET …/notes/{id}/html?link_base=/wiki/{vault}/{id}` + `…/backlinks`
- Editing inside the panel: iframe `/embed/dnd/note/{id}?mode=edit&links=parent&theme=dark`
- Reviewing proposals: iframe `/embed/dnd/proposals?campaign=…`
- Live: `GET /api/v1/events?vault=dnd` (SSE) or webhooks (`X-Basalt-Signature: sha256=HMAC(secret, body)`)

`postMessage` of the embeds: `basalt:ready`, `basalt:navigate {noteId, title, noteType}`, `basalt:resize {height}`,
`basalt:saved {noteId, version}`; to the embed: `basalt:open {noteId}`, `basalt:setTheme {theme}`, `basalt:search {q}`.

### JS SDK

[`packages/client`](../packages/client) (`@basaltnotes/client`):

```ts
import { BasaltNotes } from '@basaltnotes/client'
const b = new BasaltNotes({ baseUrl: 'https://notes.home', token })
const overview = await b.campaigns.overview('dnd', 'curse-of-strahd')
const html = await b.notes.html('dnd', noteId, { linkBase: '/wiki/{vault}/{id}' })
b.events.on('inbox.processed', (e) => toast(`${e.data.created} new entries`), { vault: 'dnd' })
```

All endpoints are listed in the [API reference](#api-reference).

---

## API reference

Base URL: `http://<host>:4400/api/v1` · JSON (UTF-8) · timestamps ISO-8601 with time zone.
The server provides the machine-readable description (OpenAPI 3) at **`GET /api/v1/openapi.json`**.

### Basics

#### Authentication

| Method | Use |
|---|---|
| `Authorization: Bearer <token>` | Other apps (WhisperNotes, DM panel, scripts). An admin creates tokens under *Settings → API tokens*. |
| `?token=<token>` | Where headers are not possible: `EventSource`, images, iframe embeds |
| Session cookie `basalt_session` | Web interface. Writing calls also need `X-CSRF-Token` (from login or `/auth/me`). |
| Proxy header (`AUTH_HEADER`) | Optional, e.g. `Remote-User` from Authelia/Authentik |

Reachable without sign-in: `GET /health`, `POST /auth/login`, `GET /openapi.json`.

#### Permissions (scopes)

| Scope | Allows |
|---|---|
| `read` | Reading (included in `write` and `curate`) |
| `write` | Writing notes, folders, sections, attachments, templates (includes `inbox`) |
| `inbox` | Only submitting to the inbox |
| `curate` | Curator: accept/reject proposals, undo runs, curate notes |
| `admin` | Everything, incl. users, tokens, webhooks, vault settings |
| `create_vault` | Creating vaults. The token that creates a vault has all rights in it, and only there (up to 20 own vaults) |

Tokens and users can be limited to individual vaults. Tokens/accounts with the player view (`visibility: players`) only see
notes and sections with `visibility: players` and have no access to inbox, proposals and curator runs. Roles of user
accounts: `admin` (all scopes), `editor` (`read`, `write`, `inbox`, `curate`), `viewer` (`read`), `player` (`read` +
player view). Visibility (`visibility`) only exists in D&D vaults.

Other projects can get their own vault: create a token with `{"name": "MyApp", "scopes": ["create_vault"]}` and let the app call
`POST /vaults` with `{"name": "MyApp"}` (`409` = name is taken; check `GET /vaults` first). The app sees only its own vaults, unless it
also has other scopes or grants. Deleting the vault ends the ownership.

#### Error format

```json
{ "error": { "code": "version_conflict", "message": "The note has been changed in the meantime.", "details": { "current_version": "sha1:…" } } }
```

`message` is German by default and English with `X-Basalt-Lang: en` or `Accept-Language: en`; rely on `code`.

| Code | HTTP | Meaning |
|---|---|---|
| `validation_error` | 400 | Invalid input (e.g. missing title, missing `If-Match`) |
| `unauthorized` | 401 | Not signed in, token invalid/expired, account locked |
| `forbidden` | 403 | Missing scope, no access to the vault, CSRF token missing |
| `not_found` | 404 | Vault, note, version, proposal … not found |
| `version_conflict` | 409 | `If-Match` does not match – `details.current_version` and `details.current` contain the current state |
| `conflict` | 409 | Other conflict (name taken, run already undone, last admin …) |
| `rate_limited` | 429 | Too many requests (login: 10/min, otherwise 1200/min per IP) |
| `llm_unavailable` | 503 | LLM not reachable |

#### Versions, idempotency, pages

- **Version/ETag:** every note has a `version` (`sha1:…` of the file content), also as an `ETag` header.
  `PUT` needs `If-Match: "<version>"` (`*` = no check). `PATCH` only checks if `If-Match` is set.
  Managed sections (`/blocks`) don't need `If-Match`.
- **Idempotency:** `POST` with the header `Idempotency-Key: <key>` returns the same response when repeated
  (header `Idempotent-Replayed: true`), for 7 days.
- **Pages:** lists accept `limit` (default 50, max. 500) and `cursor`; the response contains `next_cursor`
  (`null` = end).
- **Visibility:** many read endpoints accept `?visibility=players` and then filter out DM content.
- **CORS:** only origins from `CORS_ORIGINS`; no wildcard.

---

### System & authentication

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/health` | – | Status, version, notes per vault, LLM (reachable, model, context size and source), queue. `?refresh=1` checks the LLM again |
| GET | `/openapi.json` | – | OpenAPI description |
| GET | `/system/features` | signed in | Enabled features `{curator, chat, setup_done}` (also in `/auth/me`) |
| PUT | `/system/features` | admin | Switch features `{curator?, chat?, setup_done?}` – applies immediately. When off, curator endpoints (proposals, runs, curator status, curate note) or chat endpoints answer with 403; the inbox keeps accepting and just stores |
| GET | `/system/llm` | admin | LLM settings `{url, model, num_ctx, override, env}` |
| GET | `/system/llm/models` | admin | Installed models of a server (`?url=` to test before saving) → `{models: [{name, parameter_size, quantization, size, loaded}]}` |
| PUT | `/system/llm` | admin | Save `{url?, model?, num_ctx?, think_chat?, think_curator?}` (applies immediately, takes precedence over environment variables); `{"reset": true}` removes your own values |
| POST | `/auth/login` | – | `{username, password}` → sets a cookie, returns `{user, csrf, expires}` |
| POST | `/auth/logout` | signed in | Sign out |
| GET | `/auth/me` | signed in | `{kind, name, user_id, display_name, role, vaults, scopes, visibility, campaign, csrf, embed_origins, roles, features}` |
| POST | `/auth/password` | user account | Change your own password `{current, new}` (other sessions are ended) |

### Users

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/users` | admin | All users + available roles |
| POST | `/users` | admin | Create `{username, password, role, grants? (role `member`), vaults?, campaign?, display_name?}` |
| PATCH | `/users/{id}` | admin | Change: `role`, `grants`, `vaults`, `campaign`, `display_name`, `disabled`, `password` (reset) |
| DELETE | `/users/{id}` | admin | Delete (not your own account, not the last admin) |

`vaults` is `"*"` or a list of vault IDs. User name: 2–63 characters (`a-z 0-9 . _ @ -`), password at least 8 characters.

### Tokens

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/tokens` | admin | Tokens (without secret) with “last used” |
| POST | `/tokens` | admin | `{name, grants: [grant], scopes?: ["create_vault"], expires?}` · still possible, classic: `{name, scopes, vaults?, expires?, visibility?: "players", campaign?}` → `{token, …}` – **the token is shown only once** |
| PATCH | `/tokens/{id}` | admin | Change grants `{grants}` – the token value stays the same |
| POST | `/tokens/embed` | `read`/`write` in the vault | Short-lived token for embeds `{vault, scope?: "read"\|"write", ttl? (s, default 3600, max. 7 days), visibility?, campaign?}` |
| DELETE | `/tokens/{id}` | admin | Revoke |

Example WhisperNotes: `{"name": "WhisperNotes", "grants": [{"vault": "dnd", "access": "read_inbox"}, {"vault": "notizen", "access": "read_inbox"}]}`.

**Grants per notebook** (Settings → API tokens): every grant names a notebook (`*` = all) and a permission level.

| Level (`access`) | Rights |
|---|---|
| `read` | Read |
| `inbox` | Only submit to the inbox |
| `read_inbox` | Read + inbox |
| `curate` | Read + inbox + curator |
| `write` | Read + write + inbox |
| `write_curate` | Write + curator |
| `admin` | Everything in the notebook, including its settings |

Managing the server (users, tokens, webhooks) requires `admin` for `*`. Change access at any time with *Permissions* or
`PATCH /tokens/{id}` with `{name?, grants?, create_vault?, expires?}`; the token value stays the same. Tokens created the classic way
keep working and appear the same way. Read, inbox and write can also be limited to an **area**:

```json
{
  "name": "D&D tool",
  "grants": [
    { "vault": "dnd", "access": "read", "campaign": "Curse of Strahd", "types": ["lore", "npc", "location"] },
    { "vault": "notizen", "access": "write", "folders": ["Rezepte"] }
  ]
}
```

| Field | Meaning |
|---|---|
| `campaign` | Only entries of this campaign. `shared` (default `true`) adds entries **without** a campaign (general world/rules) |
| `types` | Only these types (e.g. `lore`, `npc`) |
| `folders` | Only entries in these folders (incl. subfolders) |

An access with an area only sees matching entries in list, search, query, names, graph, campaigns and chat; notes outside
are “not found”, links to them are not resolved. Writing creates new notes inside the area (campaign is set, folder
chosen) and refuses changes that would move a note out of the area. Functions that could show or change content outside
(history, trash, export, inbox, curator, attachments, folders, tags, live events) are blocked for such accesses. Curator
and admin rights only work without an area.

### Vaults

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/vaults` | signed in | Vaults (filtered by access) with `note_count`, `types`, `open_proposals`, `inbox_pending` |
| POST | `/vaults` | admin | Create `{name, preset: "dnd" \| "notes" \| "empty", lang?: "de" \| "en"}` – `empty` = free (only “Note”, curator “link only”); `lang` sets the language of the template's folder names (default: language of the request) |
| POST | `/vaults/example` | admin | Create the example vault “Beispiel – Die Nebelküste” (fictional D&D campaign, German content); 409 if it already exists |
| GET | `/vaults/{vault}` | read | Details incl. curator settings |
| PATCH | `/vaults/{vault}` | admin | `{name?, curator?: {enabled, mode: "full" \| "link", auto_apply, review, min_confidence_auto, learn_aliases, section}}` – `mode: link` = only link mentions (without LLM) |
| DELETE | `/vaults/{vault}` | admin | Delete (the folder is moved to `data/deleted-vaults`) |
| GET | `/vaults/{vault}/types` | read | Types with folder, template and property schema (for dynamic forms); `builtin` = built in |
| GET | `/vaults/{vault}/types/{name}` | read | One type with `template_body` (template) and `note_count` |
| PUT | `/vaults/{vault}/types/{name}` | admin | Create/change a type `{label, folder, properties: [{name, label, type, options?, link_types?}], template_body?}` – `type`: `text`, `number`, `date`, `datetime`, `boolean`, `select`, `list`, `link`, `url`. Folder placeholders `{year}`, `{month}`, `{campaign}`, `{title}` |
| DELETE | `/vaults/{vault}/types/{name}` | admin | Remove a type (only without notes of this type) |
| POST | `/vaults/{vault}/reindex` | write | Rebuild the index from the files → `{notes, ms}` |
| GET / PUT | `/vaults/{vault}/config` | admin | Read / replace `vault.yaml` `{yaml}` |
| GET | `/vaults/{vault}/tree` | read | `{folders, notes: [{id, path, title, type}]}` for file trees |
| POST | `/vaults/{vault}/folders` | write | Create a folder `{path}` |
| PATCH | `/vaults/{vault}/folders` | write | Rename/move a folder `{from, to}` |
| DELETE | `/vaults/{vault}/folders?path=…` | write | Delete a folder (notes → trash) |
| GET | `/vaults/{vault}/trash` | read | Trash |
| POST | `/vaults/{vault}/trash/restore` | write | Restore `{path}` |
| DELETE | `/vaults/{vault}/trash` | admin | Empty the trash (versions stay in git) |
| GET | `/vaults/{vault}/templates` | read | Templates `{name, content}` |
| PUT / DELETE | `/vaults/{vault}/templates/{name}` | write | Save `{content}` / delete a template. Placeholders: `{{title}}`, `{{date}}`, `{{campaign}}`, `{{type}}` |
| GET | `/vaults/{vault}/export.zip` | read | Vault as ZIP |

### Notes

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/vaults/{vault}/calendar` | read | Calendar (plugin “Calendar & CalDAV”) `?from=YYYY-MM-DD&to=YYYY-MM-DD` (default: −7 to +42 days, at most 400 days) → `{items: [{id, note_id, vault, title, type, start, end, all_day, location, done, status, recurrence, field}]}`. The source is a type's first date field: `start` (+`end`, `all_day`, `recurrence`: täglich/wöchentlich/monatlich/jährlich, `until`), `date`, `due` (tasks, `done` from `status`), `planned_for`. Times are local time (`YYYY-MM-DDTHH:mm`), recurrences are expanded |
| GET | `/calendar` | signed in | The same across all accessible notebooks (`?vaults=a,b` to narrow down) |
| POST | `/vaults/{vault}/capture` | write | Quickly store text `{text, to?: "journal"\|"list"\|"note", list?, title?, heading?}` – default: a line with the time in today's journal; with `list` as an item on the list with this title |
| POST | `/vaults/{vault}/journal/today` | write | Journal entry for today (or `{date: "YYYY-MM-DD"}`) – created if necessary → note + `created` |
| GET | `/vaults/{vault}/notes/{id}/tasks` | read | Tasks of the note (`- [ ] …`) → `{items: [{index, checked, text}], version}` |
| POST | `/vaults/{vault}/notes/{id}/link` | write | Link mentions of existing notes (without LLM) `{dry_run?, links?: [title]}` → `{linked, diff, note?}`; only the first mention per target, code/links/headings stay untouched |
| POST | `/vaults/{vault}/notes/{id}/tasks/{index}` | write | Tick off/reset a task `{checked, text?}` – only changes the checkbox (and the modification time); if `text` no longer matches, 409 |
| GET | `/vaults/{vault}/notes` | read | List. Filters: `type` (also comma-separated), `tag`, `campaign`, `folder`, `prop.<name>=<value>`, `q`, `updated_since`, `sort` (e.g. `-updated,title`), `fields` (e.g. `title,type,status`), `limit`, `cursor` |
| GET | `/vaults/{vault}/notes/{id}` | read | Note. `?format=json` (default) \| `markdown` \| `html`; `?fields=…`; `?clean=1`: text without frontmatter, section markers and `[[ ]]` (e.g. for dashboards; also with `by-title`) |
| GET | `/vaults/{vault}/notes/by-path?path=…` | read | Find by path |
| GET | `/vaults/{vault}/notes/by-title?title=…` | read | By title, file name or alias (`&type=`, `&campaign=` optional) |
| POST | `/vaults/{vault}/notes` | write | Create `{title, type?, frontmatter?, body?, folder?, template?}` → `201` |
| PUT | `/vaults/{vault}/notes/{id}` | write | Replace, **`If-Match` required**. Body `{raw}` (whole file) or `{frontmatter, body}` |
| PATCH | `/vaults/{vault}/notes/{id}` | write | `{frontmatter?: {…merged}, remove?: ["field"], append?: "text" \| {text, heading}}` |
| DELETE | `/vaults/{vault}/notes/{id}` | write | Move to trash |
| POST | `/vaults/{vault}/notes/{id}/rename` | write | `{title?, folder?}` – the ID stays, all links in the vault are updated → `{…note, updated_links, updated_notes}` |
| GET | `/vaults/{vault}/notes/{id}/backlinks` | read | Incoming links `{source_id, source_title, source_type, text, heading, context, line}` |
| GET | `/vaults/{vault}/notes/{id}/links` | read | Outgoing links `{target, target_id, resolved, heading, embed}` |
| GET | `/vaults/{vault}/notes/{id}/history` | read | Versions from git `{rev, date, author, message}` |
| GET | `/vaults/{vault}/notes/{id}/history/{rev}` | read | Content of a version; `?diff=1` as a unified diff against the current one |
| POST | `/vaults/{vault}/notes/{id}/restore` | write | Restore a version `{rev}` |
| POST | `/vaults/{vault}/notes/{id}/curate` | curate | Send the note through the curator. `?dry_run=1` → plan with diffs (synchronous), otherwise `202 {job_id}`; `?mode=review` = everything as a proposal |

**Response of `GET /notes/{id}`:**

```json
{
  "id": "01JA8Z6K3P8Q2V9W4X5Y6Z7A8B",
  "vault": "dnd",
  "path": "Curse of Strahd/NPCs/Zylia.md",
  "type": "npc",
  "title": "Zylia",
  "aliases": ["Cydia", "Sylvia"],
  "tags": ["caravan"],
  "campaign": "Curse of Strahd",
  "visibility": "players",
  "frontmatter": { "campaign": "Curse of Strahd", "role": "caravan leader", "status": "lebendig", "visibility": "players" },
  "body": "# Zylia\n\nYour own text …",
  "raw": "---\nid: 01JA…\n---\n# Zylia …",
  "blocks": [{ "key": "whispernotes:job:ab12cd34", "source_note": "[[2026-10-11 Session 1]]", "visibility": null, "updated": "2026-10-12T01:40" }],
  "links": [{ "target_id": "01JB…", "text": "Barovia", "target": "Barovia", "heading": null, "embed": false, "resolved": true, "type": "location" }],
  "backlink_count": 4,
  "version": "sha1:9f2c…",
  "created": "2026-10-12T01:40:00+02:00",
  "updated": "2026-10-12T01:40:00+02:00"
}
```

`frontmatter` contains all properties except `id`, `type`, `title`, `aliases`, `created`, `updated`.
`raw` is missing in the player view.

**Changing with conflict protection:**

```http
PUT /api/v1/vaults/dnd/notes/01JA8Z…
If-Match: "sha1:9f2c…"
Content-Type: application/json

{ "raw": "---\ntype: npc\ntitle: Zylia\n---\n# Zylia\n\nNew text\n" }
```

→ `200` with a new `version`, or `409 version_conflict` with the current state in `details.current`.

### Managed sections

Machines write into marked sections; your own text outside is kept byte for byte:

```markdown
## Aus den Sessions
<!-- basalt:block key="whispernotes:job:ab12cd34" source="[[2026-10-11 Session 1]]" updated="2026-10-12T01:40" -->
- Leads the caravan.
<!-- /basalt:block -->
```

| Method | Path | Scope | Purpose |
|---|---|---|---|
| PUT | `/vaults/{vault}/notes/{id}/blocks/{key}` | write | Set/replace `{content, heading?, source_note?, visibility?: "dm"}`. The same `key` replaces, a new `key` is appended under `heading` (the heading is created if needed) |
| DELETE | `/vaults/{vault}/notes/{id}/blocks/{key}` | write | Remove a section |
| DELETE | `/vaults/{vault}/blocks?key=…` | write | Remove all sections with this key in the vault; `&prefix=1` incl. `key:…` sub-keys |

Pass `key` URL-encoded (`whispernotes%3Ajob%3Aab12cd34`). `source_note` may be a note ID or a title.

### Search, queries, names

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/vaults/{vault}/search?q=…` | read | Full text (prefix search, all words) with `highlights` (`<mark>…</mark>`) and `title_highlight`. Filters: `type`, `campaign`, `tag`, `limit`, `cursor` |
| POST | `/vaults/{vault}/query` | read | Structured query (see below) |
| GET | `/vaults/{vault}/resolve?name=…` | read | Candidates with `score` 0–1 and `match` (`exact`, `similar`, `alias_similar`, `fulltext`); `&type=`, `&campaign=` |
| GET | `/vaults/{vault}/names` | read | All titles + aliases: `{items: [{id, name, type, campaign, aliases}], glossary: [...]}`. `?campaign=…&types=npc,location` |
| GET | `/vaults/{vault}/tags` | read | `[{tag, count}]` |
| GET | `/vaults/{vault}/graph` | read | `{nodes: [{id, title, type, campaign, degree}], edges: [{source, target}]}`; `?campaign=`, `?type=` |
| POST | `/vaults/{vault}/render` | read | Any Markdown in the context of the vault to sanitised HTML `{markdown, link_base?}` |

**Query:**

```json
POST /api/v1/vaults/dnd/query
{
  "where": [
    { "field": "type", "op": "=", "value": "npc" },
    { "field": "campaign", "op": "=", "value": "Curse of Strahd" },
    { "field": "attitude", "op": "in", "value": ["feindlich", "neutral"] }
  ],
  "sort": [{ "field": "updated", "dir": "desc" }],
  "select": ["title", "role", "faction", "status", "updated"],
  "limit": 100
}
```

→ `{items: [{id, title, role, …}], total, next_cursor}`.
Fields: `id`, `type`, `title`, `campaign`, `path`, `visibility`, `created`, `updated`, `tag` and every property from the
frontmatter. Operators: `=`, `!=`, `in`, `not_in`, `contains`, `exists`, `not_exists`, `>`, `<`, `>=`, `<=`
(comparisons are case-insensitive; link values such as `[[Barovia]]` are compared as `Barovia`).
Additionally `q` for full text.

### Chat

| Method | Path | Scope | Description |
|---|---|---|---|
| POST | `/vaults/{vault}/chat` | read | Answer a question → `{answer, llm, sources, focus, chars, budget}` |
| POST | `/vaults/{vault}/chat/context` | read | Only the pre-selection without LLM → `{focus, sources, text, chars, budget, list_types}` |

Body: `{"question": "Who is Kefir?", "history": [{role, content}], "previous": ["<focus of the last answer>"], "focus": ["<note ID>"], "campaign": "Curse of Strahd", "stream": false, "include_context": false}`.
With `"stream": true` the answer comes as server-sent events: `context` (sources), `start` (LLM reading),
`thinking` (`{text}`, only with thinking switched on), `token` (`{text}`), `done` (`{answer, llm}`) or `error`. `sources[].role`: `focus`, `mention`, `related`, `list`, `fulltext`.

### Inbox

| Method | Path | Scope | Purpose |
|---|---|---|---|
| POST | `/vaults/{vault}/inbox` | inbox | Submit → `202 {inbox_id, status, note_id, note_path}` |
| POST | `/vaults/{vault}/inbox/upload` | inbox | Upload a document (multipart, see below) → `202 {inbox_id, status, note_id, note_path}` |
| GET | `/vaults/{vault}/inbox` | read | List; `?status=queued,running,processed,stored,error,cancelled,discarded` |
| GET | `/vaults/{vault}/inbox/{id}` | read | Status, note, result `{run_id, created, updated, proposals}`, run, proposals, raw data |
| POST | `/vaults/{vault}/inbox/{id}/cancel` | curate | Cancel processing (waiting → immediately, running → before writing); status afterwards `cancelled` |
| POST | `/vaults/{vault}/inbox/{id}/reprocess` | curate | Process again (replaces contributions from the same source); optional `{curate: "auto" \| "review"}` |
| DELETE | `/vaults/{vault}/inbox/{id}` | curate | Discard |

```json
POST /api/v1/vaults/dnd/inbox
Idempotency-Key: whispernotes:job:ab12cd34:v3
{
  "source": { "app": "whispernotes", "key": "whispernotes:job:ab12cd34", "url": "http://whispernotes.local:8000/dashboard/#dnd" },
  "note": {
    "type": "session",
    "title": "2026-10-11 Session 1",
    "frontmatter": {
      "campaign": "Curse of Strahd",
      "date": "2026-10-11T22:00:00+02:00",
      "players": [{ "player": "Robin", "character": null, "role": "dm" }, { "player": "Mara", "character": "Lyssara" }],
      "transcript_url": "http://whispernotes.local:8000/api/jobs/ab12cd34/transcript?format=md"
    },
    "body": "## Was bisher geschah\n…\n## Ereignisse\n…"
  },
  "attachments": [
    { "name": "Player recaps", "kind": "players_recap", "markdown": "## Lyssara (Mara)\n…" },
    { "name": "World & lore", "kind": "lore", "markdown": "## NPCs\n…", "visibility": "dm" }
  ],
  "curate": "auto"
}
```

- `curate`: `auto` (rules from `vault.yaml`), `review` (everything as a proposal), `none` (store only).
- The note is created **immediately**, or updated for the same `source.key` (a title change = rename).
  `body` and `attachments` end up as managed sections in the note; your own text in it is kept.
- The campaign is matched by name (case-insensitive) and created as a note if needed; sessions without a `number` are
  numbered consecutively.
- Plain text works without `note` too: `{"text": "The party sold the key", "campaign": "…", "curate": "review"}`.

**Uploading documents** (`multipart/form-data`):

| Field | Required | Meaning |
|---|---|---|
| `file` | yes | `.pdf`, `.docx`, `.txt`, `.md` (max. 50 MB) |
| `campaign` | – | Campaign (created if needed) |
| `title` | – | Title of the note (default: file name) |
| `type` | – | Note type (default: `script` – script (prep) – in a D&D vault, otherwise `note`) |
| `visibility` | – | D&D vault only: `dm` (default) or `players`. Notes vaults have no visibility. |
| `curate` | – | `auto` (default), `review`, `none` |

```sh
curl -X POST "$API/vaults/dnd/inbox/upload" -H "Authorization: Bearer $TOKEN" \
  -F "file=@Curse of Strahd.pdf" -F "campaign=Curse of Strahd" -F "curate=review"
```

- The original goes into `_attachments/`; the note contains `![[file.pdf]]` and the extracted text (for PDFs with
  `## Seite N` headings) as a managed section – so everything is searchable.
- With `visibility: dm` and for scripts the curator treats everything it recognises as DM knowledge: new NPCs, places and
  quests are created with `visibility: dm` and do not appear in the player view.
- For scripts the curator knows that the events are planned and have not happened yet.
- Long documents are split into sections and processed one after another; if a section fails it is skipped and noted in
  the curator run.
- Uploading the same file again updates the same note (detected by content).
- Scanned PDFs without a text layer are rejected (no OCR).

### Proposals and curator runs

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/vaults/{vault}/proposals` | read | `?status=open` (default) \| `accepted` \| `rejected` \| `superseded` \| `discarded` \| `all`, `&campaign=`, `&run_id=`, `&diff=1` |
| GET | `/vaults/{vault}/proposals/{id}` | read | Proposal with `operation`, `reason`, `confidence` and `diff` (unified) |
| PATCH | `/vaults/{vault}/proposals/{id}` | curate | Adjust before accepting: `to`, `title`, `alias`, `field`, `frontmatter`, `type`, `note_id`, `other_id`, `block: {content}` |
| POST | `/vaults/{vault}/proposals/{id}/accept` | curate | Accept (applied and committed) |
| POST | `/vaults/{vault}/proposals/{id}/reject` | curate | Reject |
| POST | `/vaults/{vault}/proposals/bulk` | curate | `{ids: [...], action: "accept" \| "reject"}` |
| GET | `/vaults/{vault}/curator/status` | read | What the curator is doing right now: `{running: [{run_id, inbox_id, title, dry_run, phase, step, steps, started}], queued}` |
| POST | `/vaults/{vault}/curator/duplicates` | curate | **Find duplicates** without LLM → merge proposals `{found, known, created, pairs}`; `?dry_run=1` only lists, `?min_score=0.85` |
| POST | `/vaults/{vault}/curator/stop` | curate | **Stop the curator:** cancel the running run, clear the queue → `{stopped_running, cancelled_queued}` |
| GET | `/vaults/{vault}/runs` | read | Runs with status, commit, number of changes/proposals, model |
| GET | `/vaults/{vault}/runs/{id}` | read | Input, recognition (`extraction` incl. `resolutions`), plan, applied operations, proposals |
| POST | `/vaults/{vault}/runs/{id}/revert` | curate | Undo → `{revert_commit, method: "git" \| "semantic", discarded_proposals}` |

A section for which the LLM delivers nothing for too long, or whose response is cut off, is skipped (noted in the run under
`llm.warnings`); such errors are not retried automatically. Only if the LLM is unreachable does BasaltNotes try again later.

Cancelling always happens **before** writing: the running LLM request is disconnected, the run gets the status
`cancelled`, nothing changes in the vault. If a run is already applying (a few seconds), it still finishes.
Cancelled inbox entries can be processed again with `reprocess`.

Operations (`operation.op`): `create_entity`, `append_block`, `add_mention`, `add_alias` (automatic by default),
`update_property`, `contradiction`, `merge_entities`, `update_quest`, `delete` (always a proposal), `link_mentions`
(curator mode “link only”).

### Campaigns (for the DM panel)

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/vaults/{vault}/campaigns` | read | Campaigns `{id, title, slug, status, system, players}` |
| GET | `/vaults/{vault}/campaigns/{campaign}/overview` | read | Everything for a home page (see below); `?visibility=dm\|players` |
| GET | `/vaults/{vault}/campaigns/{campaign}/timeline` | read | Sessions in chronological order `{id, title, number, date, transcript_url, recap_excerpt}` |

`{campaign}` may be the ID, title or slug (`curse-of-strahd`).

```json
{
  "campaign": { "id": "…", "title": "Curse of Strahd", "slug": "curse-of-strahd", "status": "aktiv", "system": "5e", "players": [], "dm": null },
  "last_session": { "id": "…", "title": "2026-10-11 Session 1", "number": 1, "date": "…", "recap_excerpt": "The party …" },
  "sessions": [{ "id": "…", "number": 1, "date": "…", "title": "…" }],
  "open_quests": [{ "id": "…", "title": "Bridge over the brook", "status": "offen", "giver": "[[Zylia]]" }],
  "characters": [{ "id": "…", "title": "Lyssara", "player": "Mara", "class": null, "status": null }],
  "recent_entities": [{ "id": "…", "type": "npc", "title": "Zylia", "updated": "…" }],
  "counts": { "npc": 12, "location": 7, "item": 4, "faction": 2 },
  "scripts": [{ "id": "…", "title": "Evening 5 – Vallaki", "planned_for": "2026-10-25", "updated": "…" }],
  "open_proposals": 3
}
```

### Rendering and attachments

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/vaults/{vault}/notes/{id}/html` | read | Sanitised HTML; `?link_base=/wiki/{vault}/{id}` (placeholders `{vault}`, `{id}`, `{title}`), `?visibility=players` |
| GET | `/vaults/{vault}/attachments/{name}` | read | Attachment (images, PDFs, audio) |
| POST | `/vaults/{vault}/attachments` | write | Upload (multipart, field `file`, max. 50 MB) → `{name, path, url, embed: "![[name]]"}` |

Links in the HTML: `<a class="internal-link" href="/wiki/dnd/01JA…" data-note-id="01JA…" data-type="npc">Zylia</a>`;
unresolved links carry `class="internal-link unresolved" data-unresolved="Title"`.

### Events and webhooks

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/events?vault=dnd` | read | Server-sent events (several vaults comma-separated) |
| GET | `/webhooks` | admin | Webhooks with the last 20 deliveries |
| POST | `/webhooks` | admin | `{url, events?: [...] \| ["*"], vaults?: [...] \| ["*"], secret?}` → the secret is shown once |
| DELETE | `/webhooks/{id}` | admin | Delete |

Events: `note.created`, `note.updated`, `note.renamed`, `note.deleted`, `inbox.queued`, `inbox.processed`,
`inbox.failed`, `inbox.cancelled`, `proposal.created`, `proposal.resolved`, `run.reverted`.

```json
{ "event": "inbox.processed", "vault": "dnd", "at": "2026-10-12T01:42:00+02:00",
  "data": { "inbox_id": "…", "note_id": "…", "run_id": "…", "created": 3, "updated": 5, "proposals": 2 } }
```

- **SSE:** `event: <name>` + `data: <JSON as above>`; a comment every 25 s as keep-alive. Changes from outside
  (SMB/Obsidian) carry `data.external: true`.
- **Webhooks:** `POST` with a JSON body and the headers `X-Basalt-Event`, `X-Basalt-Delivery` and
  `X-Basalt-Signature: sha256=<HMAC-SHA256(secret, body) hex>`. On failure (no 2xx, 10 s timeout) up to 6 attempts with
  increasing intervals.

Verifying the signature (Node):

```js
const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')
const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(req.headers['x-basalt-signature']))
```

### Embed views (iframe)

| URL | Content |
|---|---|
| `/embed/{vault}/note/{id}?mode=view\|edit` | Read or edit one note |
| `/embed/{vault}/campaign/{campaign}` | Campaign home page |
| `/embed/{vault}/search?q=…&type=…` | Search |
| `/embed/{vault}/proposals?campaign=…` | Review proposals |
| `/embed/{vault}/graph?campaign=…` | Graph |

Parameters: `theme=light|dark|auto`, `visibility=dm|players`, `links=internal|parent`, `token=<embed token>`.
Allowed embedding pages: `EMBED_ORIGINS`.

`postMessage` (only with allowed origins):

| Direction | Message |
|---|---|
| Embed → host | `{type: "basalt:ready"}`, `{type: "basalt:resize", height}`, `{type: "basalt:navigate", noteId, title, noteType}` (with `links=parent`), `{type: "basalt:saved", noteId, version}` |
| Host → embed | `{type: "basalt:open", noteId}`, `{type: "basalt:setTheme", theme}`, `{type: "basalt:search", q}` |

Signing in inside embeds: either the same domain behind the reverse proxy (session cookie) or a short-lived token that the
host server fetches via `POST /tokens/embed` and appends as `?token=`.

### Examples with curl

```sh
TOKEN=bn_…   # from Settings → API tokens
API=http://nas:4400/api/v1

# Create a note
curl -s -X POST "$API/vaults/dnd/notes" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"npc","title":"Zylia","frontmatter":{"campaign":"Curse of Strahd","role":"caravan leader"}}'

# Full-text search
curl -s "$API/vaults/dnd/search?q=caravan&type=npc" -H "Authorization: Bearer $TOKEN"

# Write a section into a note (replaces with the same key)
curl -s -X PUT "$API/vaults/dnd/notes/<id>/blocks/panel%3Aencounter%3A42" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"heading":"Encounters","content":"- Won the fight against the slime monster"}'

# Whisper glossary
curl -s "$API/vaults/dnd/names?campaign=Curse%20of%20Strahd&types=npc,location,character" -H "Authorization: Bearer $TOKEN"

# Live events
curl -N "$API/events?vault=dnd" -H "Authorization: Bearer $TOKEN"
```

---

## Development

Requirements: Node.js ≥ 22.13 (24 recommended), git.

```sh
npm install
npm run dev            # API on :8080 (DATA_DIR=./data)
npm run dev:web        # UI on :5173 with a proxy to the API
npm test               # server tests (incl. golden tests for the curator)
npm run build          # build server, UI, SDK and built-in plugins
npm run i18n:check     # missing or broken translations
```

Building the Docker image:

```sh
docker build -t poldion/basaltnotes:latest .
```

Layout: `server/` (Fastify, TypeScript, SQLite via `node:sqlite`), `web/` (React, CodeMirror 6, Vite),
`packages/client/` (SDK), `packages/plugin-sdk/`, `plugins/`. The original requirements are in
[`anforderungen.md`](anforderungen.md) (historical, German). Contributing and translations: [CONTRIBUTING.md](../CONTRIBUTING.md).
