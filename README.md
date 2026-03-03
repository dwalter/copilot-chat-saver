# Copilot Chat Saver

A dead-simple VS Code extension that automatically saves all your GitHub Copilot
chat sessions — including **Claude thinking/reasoning blocks** — as Markdown
files in your workspace.

## Why?

- **100% local** — no telemetry, no network, no cloud. Your chats stay on your
  machine.
- **Zero dependencies** — uses only Node.js stdlib (fs, path, crypto).
- **Handles both formats** — VS Code stores chats as `.json` (older) and `.jsonl`
  (newer incremental format). Both are parsed correctly.
- **Includes thinking** — Claude Opus/Sonnet 4.x thinking blocks are extracted
  and rendered as collapsible `<details>` sections.
- **De-duplicated** — content-hashed so unchanged sessions aren't rewritten.
- **Auto-saves** — polls every 30 seconds (configurable) for new/updated chats.

## Install

### From source (recommended for trust)

```bash
cd copilot-chat-saver
npm install
npm run compile
npm run package       # creates copilot-chat-saver-1.0.0.vsix
code --install-extension copilot-chat-saver-1.0.0.vsix
```

### Development / debugging

Open this folder in VS Code and press **F5** to launch the extension in a
development host.

## Usage

The extension activates automatically when VS Code starts. It:

1. Finds the `chatSessions/` directory in your workspace storage
2. Parses every `.json` and `.jsonl` chat session file
3. Converts them to clean Markdown
4. Saves into `.chat-history/` in your workspace root

### Commands

| Command | Description |
|---------|-------------|
| **Copilot Chat Saver: Save All Chats Now** | Manually trigger a save |
| **Copilot Chat Saver: Toggle Auto-Save** | Enable/disable auto-save |
| **Copilot Chat Saver: Open History Folder** | Reveal the history folder in Finder |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotChatSaver.autoSave` | `true` | Auto-save on a timer |
| `copilotChatSaver.outputDirectory` | `.chat-history` | Output folder (relative to workspace) |
| `copilotChatSaver.pollIntervalSeconds` | `30` | Poll interval in seconds |
| `copilotChatSaver.includeThinking` | `true` | Include Claude thinking blocks |
| `copilotChatSaver.includeToolCalls` | `true` | Include tool call details |

## Output format

Each chat session becomes a single Markdown file like:

```
.chat-history/
├── 2026-03-01_fix-entity-editor-crash_a1b2c3d4.md
├── 2026-03-02_refactor-settings-tab_e5f6g7h8.md
└── 2026-03-03_deploy-troubleshooting_i9j0k1l2.md
```

Each file contains:
- Session metadata (date, model, user, session ID)
- Every user message
- Every assistant response with full text
- Claude thinking blocks in collapsible `<details>` sections
- Tool call summaries (file reads, searches, edits)

## Where does VS Code store chats?

```
~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/
```

Each workspace has a unique hash. The extension finds the right one automatically.

## Privacy

This extension:
- **Never** makes network requests
- **Never** collects telemetry
- **Never** sends your data anywhere
- Reads only from VS Code's local workspace storage
- Writes only to your workspace folder
- Has zero runtime dependencies

You can audit the entire source in a single file:
[src/extension.ts](src/extension.ts)
