# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project uses
[Semantic Versioning](https://semver.org/).

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

[0.24.0]: https://github.com/Poldion/BasaltNotes/releases/tag/v0.24.0
[0.23.0]: https://github.com/Poldion/BasaltNotes/releases/tag/v0.23.0
