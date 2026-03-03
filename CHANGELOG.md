# Changelog

All notable changes to the **Copilot Chat Saver** extension will be documented
in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.0.0] — 2026-03-03

### Added

- Automatic saving of GitHub Copilot chat sessions as Markdown files
- Support for both `.json` and `.jsonl` (incremental) chat session formats
- Claude thinking/reasoning blocks rendered as collapsible `<details>` sections
- Tool call summaries (file reads, searches, edits)
- Content-hashed deduplication — unchanged sessions are never rewritten
- Configurable poll interval (default 30 seconds)
- Configurable output directory (default `.chat-history/`)
- Toggle to include/exclude thinking blocks
- Toggle to include/exclude tool call details
- Commands: Save All Chats Now, Toggle Auto-Save, Open History Folder
- Status bar item with quick save button
- Cross-platform support (macOS, Linux, Windows)
