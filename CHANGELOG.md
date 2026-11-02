# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project uses
[Semantic Versioning](https://semver.org/).

## [0.27.0] – 2026-11-02

### Added

- Android app (`android/`): shows the interface of your own server including all plugins, with sharing from other
  apps, file picker, downloads, back button and updates from GitHub releases.
- Share page (`/p/share`), also as a share target of the installed PWA.
- Touch: editor toolbar above the keyboard, ⋮ actions and moving notes in the file tree, pinch zoom in the graph.
- Plugin SDK: `platform` (`web` or `android`).

### Fixed

- A page opened directly while signed out opens again after signing in.

## [0.26.0] – 2026-11-01

### Added

- Overview page at the start of the app: all vaults you can access with template, number of notes and last change,
  plus the most recently changed notes across them. Player accounts with a single vault still go straight to it. The
  BasaltNotes logo in the sidebar leads here.

### Fixed

- Deleting a vault failed when `/data/vaults` is a separate mount, as in the recommended setup. The folder is now
  copied to `data/deleted-vaults` in that case, including its history. If copying fails, the vault stays untouched.
- A failed vault deletion now shows an error message instead of doing nothing, and no longer stops the vault's file
  watcher.

## [0.25.0] – 2026-11-01

### Added

- Plugin catalog, similar to HACS in Home Assistant: under Settings → Plugins, browse, install, update and remove
  plugins from GitHub releases. The official repo [BasaltNotes-Plug](https://github.com/Poldion/BasaltNotes-Plug) is
  preconfigured; any other GitHub repo can be added by URL. Updates are shown, a warning appears before installing, and
  plugins with a server part ask for a server restart. Packages are not reviewed or signed.
- New plugin interfaces: `presets` (templates for new vaults), `profiles` (rules for curator, inbox and chat), `roles`
  (account roles) and `registerHomeSection` (sections on a notebook's home page). `GET /presets` lists the templates.

### Changed

- BasaltNotes is now universal: everything specific to D&D moved into the built-in plugin "D&D": campaigns with home
  page and timeline, the player view and player accounts, the D&D template, the curator's rules and the example vault.
- New installations start with one vault "Notizen" and the D&D plugin switched off. The example vault is only offered
  while a plugin provides one.
- Existing D&D vaults keep working without any step: the plugin switches itself on while a vault uses the `dnd`
  template. Notes, API paths and the `campaign` and `visibility` fields stay the same.
- Managing plugins now requires server admin rights; an admin level on a single notebook is no longer enough.

## [0.24.0] – 2026-11-01

### Added

- New token scope `create_vault`: other projects can create their own vaults through the API and have all rights in
  them, and only there (up to 20 per token).
- Token permissions can be changed afterwards (name, expiry, permissions) without changing the token value.

### Changed

- One permission system: tokens get one level per notebook (`read`, `inbox`, `read_inbox`, `curate`, `write`,
  `write_curate`, `admin`, also for all notebooks with `*`). Existing tokens keep working.
- User accounts use the same levels: the new role `member` gets one level per notebook, optionally limited to an area.
  The roles `editor` and `viewer` keep working and become members when edited.
- The web interface shows actions according to the rights in the open vault. Vault settings are available to anyone
  with `admin` in that vault.
- The file tree is now available to access limited to an area and shows only notes in that area.

### Security

- A token with `admin` for individual vaults can no longer manage the server (users, tokens, webhooks). That now
  requires `admin` for all vaults.

## [0.23.1] – 2026-10-29

### Fixed

- The rate limit now applies to the API only. Pages and scripts of the web interface are never blocked, so the app no
  longer shows a JSON error page instead of the interface.
- Adding a large folder at once (e.g. hundreds of files) no longer floods the server: live updates are bundled and the
  interface reloads once instead of once per file.
- Graph view with many notes: from 150 notes the layout settles before it is shown, movements are damped more strongly,
  unconnected notes drift gently to the centre and the view follows smoothly instead of jumping.

## [0.23.0] – 2026-10-28

### Added

- Initial public release.
- Vaults of Markdown notes with YAML frontmatter, `[[wiki links]]`, backlinks, properties and full-text search; every
  vault is a plain folder with git history that can also be opened in Obsidian.
- Free vaults and template vaults for D&D and everyday life, your own note types, an example vault with a fictional
  campaign.
- Editor with live preview, link autocomplete, image paste, autosave and conflict detection; graph view and quick
  switcher.
- Optional AI curator (local LLM via Ollama) that files inbox content and uploaded documents into notes, with proposals,
  dry runs and undo; “link mentions” without AI.
- Chat with your notes, with pre-selection of matching entries without the LLM – built for small local models.
- Campaign pages, player view, roles and per-vault API tokens with area grants.
- Plugin interface; built-in Calendar & CalDAV plugin (also for Home Assistant).
- REST API with OpenAPI, server-sent events, signed webhooks, iframe embeds and a JS SDK.
- User interface in English and German; API error messages in both languages; template folder names follow the
  language a vault is created in.

[0.26.0]: https://github.com/Poldion/BasaltNotes/releases/tag/v0.26.0
[0.25.0]: https://github.com/Poldion/BasaltNotes/releases/tag/v0.25.0
[0.24.0]: https://github.com/Poldion/BasaltNotes/releases/tag/v0.24.0
[0.23.0]: https://github.com/Poldion/BasaltNotes/releases/tag/v0.23.0
