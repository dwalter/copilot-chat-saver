/**
 * Copilot Chat Saver — VS Code Extension
 *
 * Automatically saves all GitHub Copilot and Claude Code chat sessions
 * (including thinking/reasoning blocks) as Markdown files in your workspace.
 *
 * 100% local. No telemetry. No network. No dependencies beyond Node.js stdlib.
 *
 * Storage formats handled:
 *   - .json  (older VS Code Copilot chat sessions)
 *   - .jsonl (newer incremental VS Code Copilot chat sessions, kind=0/1/2)
 *   - .jsonl (Claude Code conversations in ~/.claude/projects/)
 *
 * Copilot chat sessions live in:
 *   ~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/
 *
 * Claude Code conversations live in:
 *   ~/.claude/projects/<project-path-with-dashes>/<session-uuid>.jsonl
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ResponseItem {
    kind?: string;
    value?: string | { value?: string };
    content?: { value?: string };
    id?: string;
    generatedTitle?: string;
    invocationMessage?: { value?: string };
    isConfirmed?: unknown;
    isComplete?: boolean;
    presentation?: string;
    toolName?: string;
    // text items (no kind field)
    supportThemeIcons?: boolean;
    supportHtml?: boolean;
    baseUri?: unknown;
}

interface ChatRequest {
    requestId?: string;
    message?: { text?: string; parts?: unknown[] } | string;
    response?: ResponseItem[];
    modelId?: string;
    agent?: { id?: string; metadata?: { id?: string } };
    timestamp?: number;
    isCanceled?: boolean;
    result?: { metadata?: { modelId?: string } };
}

interface ChatSession {
    version?: number;
    sessionId?: string;
    creationDate?: number;
    lastMessageDate?: number;
    customTitle?: string;
    requesterUsername?: string;
    responderUsername?: string;
    requests?: ChatRequest[];
    initialLocation?: string;
    isImported?: boolean;
    inputState?: {
        selectedModel?: {
            metadata?: { name?: string; id?: string };
            identifier?: string;
        };
        mode?: { id?: string; kind?: string };
    };
}

// ─── Claude Code Types ──────────────────────────────────────────────────────

interface ClaudeCodeMessage {
    type: 'user' | 'assistant' | 'queue-operation' | 'file-history-snapshot';
    parentUuid?: string | null;
    uuid?: string;
    timestamp?: string;
    sessionId?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    cwd?: string;
    version?: string;
    gitBranch?: string;
    toolUseResult?: string;
    message?: {
        role?: string;
        model?: string;
        content?: string | ClaudeCodeContentBlock[];
    };
}

interface ClaudeCodeContentBlock {
    type: string;
    text?: string;
    thinking?: string;
    name?: string;
    input?: Record<string, unknown>;
    id?: string;
    content?: string;
    is_error?: boolean;
    tool_use_id?: string;
}

interface ClaudeCodeSession {
    sessionId: string;
    timestamp: string;
    model: string;
    version: string;
    cwd: string;
    gitBranch: string;
    turns: ClaudeCodeTurn[];
}

interface ClaudeCodeTurn {
    userText: string;
    timestamp: string;
    assistantParts: ClaudeCodeContentBlock[];
    model: string;
    toolResults: Map<string, { content: string; isError: boolean }>;
}

// ─── Extension Entry Points ──────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    const log = vscode.window.createOutputChannel('Copilot Chat Saver');
    const saver = new CopilotChatSaver(context, log);

    context.subscriptions.push(
        log,
        vscode.commands.registerCommand('copilotChatSaver.saveAll', () => saver.saveAllChats(true)),
        vscode.commands.registerCommand('copilotChatSaver.toggleAutoSave', () => saver.toggleAutoSave()),
        vscode.commands.registerCommand('copilotChatSaver.openHistory', () => saver.openHistoryFolder()),
    );

    saver.initialize();
}

export function deactivate() {}

// ─── Main Class ──────────────────────────────────────────────────────────────

class CopilotChatSaver {
    private context: vscode.ExtensionContext;
    private log: vscode.OutputChannel;
    private timer: ReturnType<typeof setInterval> | undefined;
    private statusBar: vscode.StatusBarItem;
    /** Map of sessionId → content hash, to avoid rewriting unchanged files */
    private knownHashes: Map<string, string>;

    constructor(context: vscode.ExtensionContext, log: vscode.OutputChannel) {
        this.context = context;
        this.log = log;
        this.knownHashes = new Map();

        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
        this.statusBar.text = '$(bookmark) Chat Saver';
        this.statusBar.tooltip = 'Copilot Chat Saver — sponsored by Shiny Gen AI — click to save all chats now';
        this.statusBar.command = 'copilotChatSaver.saveAll';
        this.statusBar.show();
        context.subscriptions.push(this.statusBar);
    }

    async initialize() {
        // Restore known hashes
        const saved = this.context.workspaceState.get<[string, string][]>('chatSaverHashes', []);
        this.knownHashes = new Map(saved);

        // Initial save (silent)
        await this.saveAllChats(false);

        // Start auto-save if enabled
        const cfg = vscode.workspace.getConfiguration('copilotChatSaver');
        if (cfg.get<boolean>('autoSave', true)) {
            this.startAutoSave();
        }

        // React to config changes
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('copilotChatSaver.pollIntervalSeconds') ||
                    e.affectsConfiguration('copilotChatSaver.autoSave')) {
                    this.restartAutoSave();
                }
            })
        );

        this.info('Copilot Chat Saver activated');
    }

    // ── Auto-save lifecycle ──────────────────────────────────────────────────

    private startAutoSave() {
        this.stopAutoSave();
        const cfg = vscode.workspace.getConfiguration('copilotChatSaver');
        const seconds = cfg.get<number>('pollIntervalSeconds', 30);
        this.timer = setInterval(() => this.saveAllChats(false), seconds * 1000);
        this.info(`Auto-save started (every ${seconds}s)`);
    }

    private stopAutoSave() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private restartAutoSave() {
        const cfg = vscode.workspace.getConfiguration('copilotChatSaver');
        if (cfg.get<boolean>('autoSave', true)) {
            this.startAutoSave();
        } else {
            this.stopAutoSave();
        }
    }

    toggleAutoSave() {
        const cfg = vscode.workspace.getConfiguration('copilotChatSaver');
        const current = cfg.get<boolean>('autoSave', true);
        cfg.update('autoSave', !current, vscode.ConfigurationTarget.Global);
        if (current) {
            this.stopAutoSave();
            vscode.window.showInformationMessage('Copilot Chat Saver: Auto-save disabled');
        } else {
            this.startAutoSave();
            vscode.window.showInformationMessage('Copilot Chat Saver: Auto-save enabled');
        }
    }

    // ── History folder ───────────────────────────────────────────────────────

    async openHistoryFolder() {
        const outDir = this.getOutputDir();
        if (!outDir) {
            vscode.window.showWarningMessage('No workspace folder open.');
            return;
        }
        if (fs.existsSync(outDir)) {
            const uri = vscode.Uri.file(outDir);
            await vscode.commands.executeCommand('revealFileInOS', uri);
        } else {
            vscode.window.showInformationMessage('No chat history saved yet.');
        }
    }

    // ── Core save logic ──────────────────────────────────────────────────────

    async saveAllChats(showMessage: boolean) {
        const outDir = this.getOutputDir();
        if (!outDir) {
            if (showMessage) {
                vscode.window.showWarningMessage('No workspace folder open.');
            }
            return;
        }

        let saved = 0;
        let errors = 0;

        // ── Save Copilot chats ──
        const chatDir = this.findChatSessionsDir();
        if (chatDir) {
            let files: string[];
            try {
                files = fs.readdirSync(chatDir).filter(f => f.endsWith('.json') || f.endsWith('.jsonl'));
            } catch {
                this.info(`Cannot read chat sessions dir: ${chatDir}`);
                files = [];
            }

            for (const file of files) {
                try {
                    const filePath = path.join(chatDir, file);
                    const session = file.endsWith('.jsonl')
                        ? this.parseJsonlSession(filePath)
                        : this.parseJsonSession(filePath);

                    if (!session || !session.requests?.length) {
                        continue;
                    }

                    const md = this.formatSessionAsMarkdown(session);
                    const hash = crypto.createHash('md5').update(md).digest('hex').slice(0, 12);
                    const sessionId = session.sessionId || path.basename(file, path.extname(file));

                    if (this.knownHashes.get(sessionId) === hash) {
                        continue; // no change
                    }

                    // Write file
                    fs.mkdirSync(outDir, { recursive: true });
                    const outName = this.makeFilename(session, sessionId);
                    const outPath = path.join(outDir, outName);
                    fs.writeFileSync(outPath, md, 'utf-8');

                    this.knownHashes.set(sessionId, hash);
                    saved++;
                    this.info(`Saved: ${outName}`);
                } catch (err) {
                    errors++;
                    this.info(`Error processing ${file}: ${err}`);
                }
            }
        }

        // ── Save Claude Code chats ──
        const claudeResult = this.saveClaudeCodeChats(outDir);
        saved += claudeResult.saved;
        errors += claudeResult.errors;

        // Persist hashes
        await this.context.workspaceState.update(
            'chatSaverHashes',
            Array.from(this.knownHashes.entries())
        );

        if (showMessage) {
            if (saved > 0) {
                vscode.window.showInformationMessage(
                    `Chat Saver: Saved ${saved} chat(s) to ${this.getConfig().outputDirectory}/`
                );
            } else if (!chatDir && !this.findClaudeCodeSessionsDir()) {
                vscode.window.showWarningMessage(
                    'Could not find any chat sessions (Copilot or Claude Code) for this workspace.'
                );
            } else {
                vscode.window.showInformationMessage('Chat Saver: All chats already up to date.');
            }
        }

        if (saved > 0) {
            this.statusBar.text = `$(bookmark) Chat Saver (${saved} saved)`;
            setTimeout(() => { this.statusBar.text = '$(bookmark) Chat Saver'; }, 5000);
        }
    }

    // ── Parsing: JSON format ─────────────────────────────────────────────────

    private parseJsonSession(filePath: string): ChatSession | null {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(raw) as ChatSession;
        } catch {
            return null;
        }
    }

    // ── Parsing: JSONL format ────────────────────────────────────────────────
    //
    // JSONL sessions use an incremental format:
    //   kind=0 : initial state (full session object)
    //   kind=1 : set a property at path k to value v
    //   kind=2 : append items to array at path k
    //

    private parseJsonlSession(filePath: string): ChatSession | null {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const lines = raw.split('\n').filter(l => l.trim());
            if (lines.length === 0) { return null; }

            // First line must be kind=0 (initial state)
            const first = JSON.parse(lines[0]);
            if (first.kind !== 0 || !first.v) { return null; }

            const session: any = first.v;

            // Apply subsequent operations
            for (let i = 1; i < lines.length; i++) {
                try {
                    const entry = JSON.parse(lines[i]);
                    const keyPath: string[] = entry.k || [];
                    const value = entry.v;

                    if (entry.kind === 1 && keyPath.length > 0) {
                        // Set value at path
                        this.setNestedValue(session, keyPath, value);
                    } else if (entry.kind === 2 && keyPath.length > 0) {
                        // Append to array at path
                        const arr = this.getNestedValue(session, keyPath);
                        if (Array.isArray(arr) && Array.isArray(value)) {
                            arr.push(...value);
                        } else if (Array.isArray(value)) {
                            this.setNestedValue(session, keyPath, value);
                        }
                    }
                } catch {
                    // Skip malformed lines
                }
            }

            return session as ChatSession;
        } catch {
            return null;
        }
    }

    private setNestedValue(obj: any, path: string[], value: unknown) {
        let current = obj;
        for (let i = 0; i < path.length - 1; i++) {
            const key = path[i];
            if (current[key] === undefined || current[key] === null) {
                current[key] = {};
            }
            current = current[key];
        }
        current[path[path.length - 1]] = value;
    }

    private getNestedValue(obj: any, path: string[]): unknown {
        let current = obj;
        for (const key of path) {
            if (current === undefined || current === null) { return undefined; }
            current = current[key];
        }
        return current;
    }

    // ── Markdown formatting ──────────────────────────────────────────────────

    private formatSessionAsMarkdown(session: ChatSession): string {
        const cfg = this.getConfig();
        const title = session.customTitle || 'Untitled Chat';
        const createdAt = session.creationDate
            ? new Date(session.creationDate).toISOString().replace('T', ' ').slice(0, 19)
            : 'Unknown';
        const lastMsg = session.lastMessageDate
            ? new Date(session.lastMessageDate).toISOString().replace('T', ' ').slice(0, 19)
            : createdAt;

        // Determine model from session-level or first request
        let model = 'Unknown';
        if (session.inputState?.selectedModel?.metadata?.name) {
            model = session.inputState.selectedModel.metadata.name;
        } else if (session.inputState?.selectedModel?.identifier) {
            model = session.inputState.selectedModel.identifier;
        } else if (session.requests?.[0]?.modelId) {
            model = session.requests[0].modelId;
        }

        const mode = session.inputState?.mode?.id || session.initialLocation || 'chat';

        let md = `# ${title}\n\n`;
        md += `| | |\n|---|---|\n`;
        md += `| **Created** | ${createdAt} |\n`;
        md += `| **Last Message** | ${lastMsg} |\n`;
        md += `| **Model** | ${model} |\n`;
        md += `| **Mode** | ${mode} |\n`;
        md += `| **User** | ${session.requesterUsername || 'Unknown'} |\n`;
        md += `| **Session ID** | \`${session.sessionId || 'Unknown'}\` |\n\n`;
        md += `---\n\n`;

        if (!session.requests?.length) {
            md += '*No messages in this session.*\n';
            return md;
        }

        for (let i = 0; i < session.requests.length; i++) {
            const req = session.requests[i];
            if (!req) { continue; }

            // Request model (may differ per turn)
            const turnModel = req.modelId || model;
            const timestamp = req.timestamp
                ? new Date(req.timestamp).toISOString().replace('T', ' ').slice(0, 19)
                : '';

            // ── User message ──
            const userText = this.extractUserMessage(req);
            md += `## User\n\n`;
            if (timestamp) {
                md += `*${timestamp}*\n\n`;
            }
            md += `${userText}\n\n`;

            // ── Assistant response ──
            md += `## Assistant`;
            if (turnModel !== model) {
                md += ` (${turnModel})`;
            }
            md += `\n\n`;

            if (req.isCanceled) {
                md += `*[Request was canceled]*\n\n`;
            }

            const response = req.response;
            if (!Array.isArray(response) || response.length === 0) {
                md += `*No response recorded.*\n\n`;
                md += `---\n\n`;
                continue;
            }

            // Group response items into logical sections
            const sections = this.groupResponseItems(response, cfg);
            for (const section of sections) {
                md += section;
            }

            md += `---\n\n`;
        }

        return md;
    }

    private extractUserMessage(req: ChatRequest): string {
        const msg = req.message;
        if (!msg) { return '*[empty message]*'; }
        if (typeof msg === 'string') { return msg; }
        if (typeof msg === 'object' && 'text' in msg) {
            return msg.text || '*[empty message]*';
        }
        return JSON.stringify(msg);
    }

    private groupResponseItems(
        items: ResponseItem[],
        cfg: { includeThinking: boolean; includeToolCalls: boolean }
    ): string[] {
        const sections: string[] = [];
        let currentText = '';

        for (const item of items) {
            const kind = item.kind;

            if (kind === 'thinking') {
                // Claude thinking/reasoning block
                if (!cfg.includeThinking) { continue; }
                // Flush any pending text
                if (currentText.trim()) {
                    sections.push(currentText.trim() + '\n\n');
                    currentText = '';
                }
                const thinkingText = this.extractValue(item);
                if (thinkingText.trim()) {
                    sections.push(
                        `<details>\n<summary>💭 Thinking${item.generatedTitle ? ` — ${item.generatedTitle}` : ''}</summary>\n\n${thinkingText.trim()}\n\n</details>\n\n`
                    );
                }
            } else if (kind === 'toolInvocationSerialized') {
                // Tool call (file read, search, edit, etc.)
                if (!cfg.includeToolCalls) { continue; }
                if (currentText.trim()) {
                    sections.push(currentText.trim() + '\n\n');
                    currentText = '';
                }
                const toolMsg = item.invocationMessage?.value || 'Tool call';
                const confirmed = item.isComplete ? '✓' : '…';
                if (item.presentation !== 'hidden') {
                    sections.push(`> **🔧 ${confirmed} ${toolMsg}**\n\n`);
                }
            } else if (kind === 'prepareToolInvocation') {
                // Tool preparation — usually followed by toolInvocationSerialized
                // Skip (the serialized version has all the info)
            } else if (kind === 'mcpServersStarting') {
                // Skip MCP server start notifications
            } else if (kind === 'textEditGroup') {
                // Code edit — mention it briefly
                if (cfg.includeToolCalls) {
                    if (currentText.trim()) {
                        sections.push(currentText.trim() + '\n\n');
                        currentText = '';
                    }
                    sections.push(`> *[Code edit applied]*\n\n`);
                }
            } else if (kind === 'codeblockUri') {
                // Skip (UI-only reference)
            } else if (kind === 'undoStop') {
                // Skip
            } else if (kind === 'inlineReference') {
                // Inline file reference — extract and inline it
                const ref = (item as any).inlineReference;
                if (ref) {
                    const fsPath: string = ref.fsPath || ref.path || '';
                    const basename = path.basename(fsPath);
                    currentText += `\`${basename}\``;
                }
            } else if (kind === 'progressMessage') {
                // Skip progress messages
            } else if (kind === 'progressTaskSerialized') {
                // Skip
            } else if (kind === 'command') {
                // Button commands — skip
            } else if (kind === 'confirmation' || kind === 'elicitation' || kind === 'elicitationSerialized') {
                // Interactive UI elements — skip
            } else if (kind === 'warning') {
                const warningText = this.extractValue(item);
                if (warningText.trim()) {
                    sections.push(`> ⚠️ ${warningText.trim()}\n\n`);
                }
            } else if (!kind) {
                // Text content (no kind field) — this is the actual assistant response text
                const text = this.extractValue(item);
                currentText += text;
            } else {
                // Unknown kind — include raw if it has a value
                const text = this.extractValue(item);
                if (text.trim()) {
                    currentText += text;
                }
            }
        }

        // Flush remaining text
        if (currentText.trim()) {
            sections.push(currentText.trim() + '\n\n');
        }

        return sections;
    }

    private extractValue(item: ResponseItem): string {
        if (typeof item.value === 'string') {
            return item.value;
        }
        if (typeof item.value === 'object' && item.value && 'value' in item.value) {
            return item.value.value || '';
        }
        if (item.content && typeof item.content === 'object' && 'value' in item.content) {
            return item.content.value || '';
        }
        return '';
    }

    // ── File naming ──────────────────────────────────────────────────────────

    private makeFilename(session: ChatSession, sessionId: string): string {
        const date = session.creationDate
            ? new Date(session.creationDate).toISOString().slice(0, 10)
            : 'undated';
        const title = (session.customTitle || 'untitled')
            .replace(/[^a-zA-Z0-9 _-]/g, '')
            .replace(/\s+/g, '-')
            .toLowerCase()
            .slice(0, 60);
        const idPrefix = sessionId.slice(0, 8);
        return `${date}_${title}_${idPrefix}.md`;
    }

    // ── Finding the chat sessions directory ──────────────────────────────────

    private findChatSessionsDir(): string | null {
        // Strategy: Use context.storageUri to find our workspace storage dir,
        // then go up to the workspace hash dir, and look for chatSessions/
        const storageUri = this.context.storageUri;
        if (storageUri) {
            const wsHashDir = path.dirname(storageUri.fsPath);
            const chatDir = path.join(wsHashDir, 'chatSessions');
            if (fs.existsSync(chatDir)) {
                return chatDir;
            }
        }

        // Fallback: scan all workspace storage directories
        return this.findChatSessionsDirByScanning();
    }

    private findChatSessionsDirByScanning(): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return null; }

        const projectPath = workspaceFolder.uri.fsPath;
        const platform = os.platform();
        let wsStorageBase: string;

        if (platform === 'darwin') {
            wsStorageBase = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
        } else if (platform === 'linux') {
            wsStorageBase = path.join(os.homedir(), '.config', 'Code', 'User', 'workspaceStorage');
        } else {
            // Windows
            wsStorageBase = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage');
        }

        if (!fs.existsSync(wsStorageBase)) { return null; }

        try {
            for (const dir of fs.readdirSync(wsStorageBase)) {
                const wsDir = path.join(wsStorageBase, dir);
                const wsJson = path.join(wsDir, 'workspace.json');
                if (!fs.existsSync(wsJson)) { continue; }

                try {
                    const data = JSON.parse(fs.readFileSync(wsJson, 'utf-8'));
                    const folder: string = data.folder || '';
                    const decoded = decodeURIComponent(folder.replace('file://', ''));
                    if (decoded === projectPath) {
                        const chatDir = path.join(wsDir, 'chatSessions');
                        if (fs.existsSync(chatDir)) {
                            return chatDir;
                        }
                    }
                } catch {
                    continue;
                }
            }
        } catch {
            return null;
        }

        return null;
    }

    // ── Claude Code: find sessions directory ───────────────────────────────

    private findClaudeCodeSessionsDir(): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return null; }

        // Claude Code stores projects at ~/.claude/projects/<path-with-dashes>/
        // e.g. /Users/foo/my-project → -Users-foo-my-project
        const projectPath = workspaceFolder.uri.fsPath;
        const encodedPath = projectPath.replace(/\//g, '-');
        const claudeDir = path.join(os.homedir(), '.claude', 'projects', encodedPath);

        if (fs.existsSync(claudeDir)) {
            return claudeDir;
        }
        return null;
    }

    // ── Claude Code: parse session ──────────────────────────────────────────

    private parseClaudeCodeSession(filePath: string): ClaudeCodeSession | null {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const lines = raw.split('\n').filter(l => l.trim());
            if (lines.length === 0) { return null; }

            const messages: ClaudeCodeMessage[] = [];
            for (const line of lines) {
                try {
                    messages.push(JSON.parse(line));
                } catch {
                    // skip malformed lines
                }
            }

            if (messages.length === 0) { return null; }

            // Extract session metadata from the first real message
            const firstMsg = messages.find(m => m.type === 'user' || m.type === 'assistant');
            const sessionId = firstMsg?.sessionId || path.basename(filePath, '.jsonl');
            const version = (firstMsg as any)?.version || '';
            const cwd = (firstMsg as any)?.cwd || '';
            const gitBranch = (firstMsg as any)?.gitBranch || '';

            // Build turns by grouping user messages → assistant responses
            const turns: ClaudeCodeTurn[] = [];
            let currentTurn: ClaudeCodeTurn | null = null;

            // Collect tool results from user messages (keyed by tool_use_id)
            const toolResults = new Map<string, { content: string; isError: boolean }>();

            for (const msg of messages) {
                if (msg.type === 'queue-operation' || msg.type === 'file-history-snapshot') {
                    continue;
                }

                // Collect tool results from user messages
                if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
                    for (const block of msg.message.content) {
                        if (block.type === 'tool_result' && block.tool_use_id) {
                            toolResults.set(block.tool_use_id, {
                                content: typeof block.content === 'string' ? block.content : '',
                                isError: block.is_error || false,
                            });
                        }
                    }
                }

                if (msg.type === 'user' && !msg.isMeta && !msg.toolUseResult) {
                    const content = msg.message?.content;
                    let text = '';
                    if (typeof content === 'string') {
                        // Skip system/command messages
                        if (content.includes('<local-command-') || content.includes('<command-name>')) {
                            continue;
                        }
                        text = content;
                    } else if (Array.isArray(content)) {
                        const textParts = content
                            .filter(b => b.type === 'text' && b.text)
                            .map(b => b.text!);
                        if (textParts.length === 0) { continue; }
                        text = textParts.join('\n\n');
                    }

                    if (!text.trim()) { continue; }

                    // Start a new turn
                    if (currentTurn) {
                        currentTurn.toolResults = new Map(toolResults);
                        turns.push(currentTurn);
                    }
                    currentTurn = {
                        userText: text.trim(),
                        timestamp: msg.timestamp || '',
                        assistantParts: [],
                        model: '',
                        toolResults: new Map(),
                    };
                } else if (msg.type === 'assistant' && currentTurn) {
                    const msgContent = msg.message;
                    if (!msgContent?.content) { continue; }

                    if (!currentTurn.model && msgContent.model) {
                        currentTurn.model = msgContent.model;
                    }

                    const content = msgContent.content;
                    if (Array.isArray(content)) {
                        for (const block of content) {
                            currentTurn.assistantParts.push(block);
                        }
                    }
                }
            }

            if (currentTurn) {
                currentTurn.toolResults = new Map(toolResults);
                turns.push(currentTurn);
            }

            if (turns.length === 0) { return null; }

            const model = turns[0]?.model || 'Claude';
            const timestamp = messages.find(m => m.timestamp)?.timestamp || '';

            return { sessionId, timestamp, model, version, cwd, gitBranch, turns };
        } catch {
            return null;
        }
    }

    // ── Claude Code: format as Markdown ─────────────────────────────────────

    private formatClaudeCodeSessionAsMarkdown(session: ClaudeCodeSession): string {
        const cfg = this.getConfig();

        // Derive title from first user message
        const firstMsg = session.turns[0]?.userText || 'Untitled';
        const title = firstMsg.length > 80 ? firstMsg.slice(0, 80) + '…' : firstMsg;

        const createdAt = session.timestamp
            ? new Date(session.timestamp).toISOString().replace('T', ' ').slice(0, 19)
            : 'Unknown';

        const lastTurn = session.turns[session.turns.length - 1];
        const lastMsg = lastTurn?.timestamp
            ? new Date(lastTurn.timestamp).toISOString().replace('T', ' ').slice(0, 19)
            : createdAt;

        let md = `# ${title}\n\n`;
        md += `| | |\n|---|---|\n`;
        md += `| **Source** | Claude Code |\n`;
        md += `| **Created** | ${createdAt} |\n`;
        md += `| **Last Message** | ${lastMsg} |\n`;
        md += `| **Model** | ${session.model} |\n`;
        if (session.version) { md += `| **Version** | ${session.version} |\n`; }
        if (session.gitBranch) { md += `| **Branch** | ${session.gitBranch} |\n`; }
        md += `| **Session ID** | \`${session.sessionId}\` |\n\n`;
        md += `---\n\n`;

        for (const turn of session.turns) {
            // ── User message ──
            md += `## User\n\n`;
            if (turn.timestamp) {
                const ts = new Date(turn.timestamp).toISOString().replace('T', ' ').slice(0, 19);
                md += `*${ts}*\n\n`;
            }
            md += `${turn.userText}\n\n`;

            // ── Assistant response ──
            md += `## Assistant`;
            if (turn.model && turn.model !== session.model) {
                md += ` (${turn.model})`;
            }
            md += `\n\n`;

            let currentText = '';
            for (const block of turn.assistantParts) {
                if (block.type === 'thinking') {
                    if (!cfg.includeThinking) { continue; }
                    if (currentText.trim()) {
                        md += currentText.trim() + '\n\n';
                        currentText = '';
                    }
                    const thinkingText = block.thinking || '';
                    if (thinkingText.trim()) {
                        md += `<details>\n<summary>💭 Thinking</summary>\n\n${thinkingText.trim()}\n\n</details>\n\n`;
                    }
                } else if (block.type === 'tool_use') {
                    if (!cfg.includeToolCalls) { continue; }
                    if (currentText.trim()) {
                        md += currentText.trim() + '\n\n';
                        currentText = '';
                    }
                    const toolName = block.name || 'Tool';
                    const input = block.input || {};
                    let summary = `**🔧 ${toolName}**`;

                    // Add concise input summary
                    if (toolName === 'Read' && input.file_path) {
                        summary += `: \`${path.basename(input.file_path as string)}\``;
                    } else if (toolName === 'Write' && input.file_path) {
                        summary += `: \`${path.basename(input.file_path as string)}\``;
                    } else if (toolName === 'Edit' && input.file_path) {
                        summary += `: \`${path.basename(input.file_path as string)}\``;
                    } else if (toolName === 'Bash' && input.command) {
                        const cmd = String(input.command);
                        summary += `: \`${cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd}\``;
                    } else if (toolName === 'Grep' && input.pattern) {
                        summary += `: \`${input.pattern}\``;
                    } else if (toolName === 'Glob' && input.pattern) {
                        summary += `: \`${input.pattern}\``;
                    } else if (toolName === 'Agent') {
                        summary += `: ${(input.description as string) || 'subagent'}`;
                    }

                    md += `> ${summary}\n\n`;
                } else if (block.type === 'text') {
                    currentText += block.text || '';
                }
            }

            if (currentText.trim()) {
                md += currentText.trim() + '\n\n';
            }

            md += `---\n\n`;
        }

        return md;
    }

    // ── Claude Code: save sessions ──────────────────────────────────────────

    private saveClaudeCodeChats(outDir: string): { saved: number; errors: number } {
        const claudeDir = this.findClaudeCodeSessionsDir();
        if (!claudeDir) { return { saved: 0, errors: 0 }; }

        let files: string[];
        try {
            files = fs.readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'));
        } catch {
            return { saved: 0, errors: 0 };
        }

        let saved = 0;
        let errors = 0;

        for (const file of files) {
            try {
                const filePath = path.join(claudeDir, file);
                const session = this.parseClaudeCodeSession(filePath);
                if (!session || session.turns.length === 0) { continue; }

                const md = this.formatClaudeCodeSessionAsMarkdown(session);
                const hash = crypto.createHash('md5').update(md).digest('hex').slice(0, 12);
                const key = `claude-code-${session.sessionId}`;

                if (this.knownHashes.get(key) === hash) { continue; }

                fs.mkdirSync(outDir, { recursive: true });

                // Build filename
                const date = session.timestamp
                    ? new Date(session.timestamp).toISOString().slice(0, 10)
                    : 'undated';
                const titleSlug = (session.turns[0]?.userText || 'untitled')
                    .replace(/[^a-zA-Z0-9 _-]/g, '')
                    .replace(/\s+/g, '-')
                    .toLowerCase()
                    .slice(0, 60);
                const idPrefix = session.sessionId.slice(0, 8);
                const outName = `${date}_claude-code_${titleSlug}_${idPrefix}.md`;
                const outPath = path.join(outDir, outName);

                fs.writeFileSync(outPath, md, 'utf-8');
                this.knownHashes.set(key, hash);
                saved++;
                this.info(`Saved Claude Code: ${outName}`);
            } catch (err) {
                errors++;
                this.info(`Error processing Claude Code ${file}: ${err}`);
            }
        }

        return { saved, errors };
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private getOutputDir(): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return null; }
        const cfg = this.getConfig();
        return path.join(workspaceFolder.uri.fsPath, cfg.outputDirectory);
    }

    private getConfig() {
        const cfg = vscode.workspace.getConfiguration('copilotChatSaver');
        return {
            autoSave: cfg.get<boolean>('autoSave', true),
            outputDirectory: cfg.get<string>('outputDirectory', '.chat-history'),
            pollIntervalSeconds: cfg.get<number>('pollIntervalSeconds', 30),
            includeThinking: cfg.get<boolean>('includeThinking', true),
            includeToolCalls: cfg.get<boolean>('includeToolCalls', true),
        };
    }

    private info(msg: string) {
        const ts = new Date().toISOString().slice(11, 19);
        this.log.appendLine(`[${ts}] ${msg}`);
    }
}
