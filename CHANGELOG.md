# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project uses
[Semantic Versioning](https://semver.org/).

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

[0.23.0]: https://github.com/Poldion/BasaltNotes/releases/tag/v0.23.0
