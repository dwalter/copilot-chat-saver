/**
 * Copilot Chat Saver — VS Code Extension
 *
 * Automatically saves all GitHub Copilot chat sessions (including Claude
 * thinking/reasoning blocks) as Markdown files in your workspace.
 *
 * 100% local. No telemetry. No network. No dependencies beyond Node.js stdlib.
 *
 * Storage formats handled:
 *   - .json  (older VS Code chat sessions)
 *   - .jsonl (newer incremental VS Code chat sessions, kind=0/1/2)
 *
 * Chat sessions live in:
 *   ~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/
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
        const chatDir = this.findChatSessionsDir();
        if (!chatDir) {
            if (showMessage) {
                vscode.window.showWarningMessage(
                    'Could not find VS Code chat sessions directory for this workspace.'
                );
            }
            return;
        }

        const outDir = this.getOutputDir();
        if (!outDir) {
            if (showMessage) {
                vscode.window.showWarningMessage('No workspace folder open.');
            }
            return;
        }

        let files: string[];
        try {
            files = fs.readdirSync(chatDir).filter(f => f.endsWith('.json') || f.endsWith('.jsonl'));
        } catch {
            this.info(`Cannot read chat sessions dir: ${chatDir}`);
            return;
        }

        let saved = 0;
        let errors = 0;

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

        // Persist hashes
        await this.context.workspaceState.update(
            'chatSaverHashes',
            Array.from(this.knownHashes.entries())
        );

        if (showMessage) {
            if (saved > 0) {
                vscode.window.showInformationMessage(
                    `Copilot Chat Saver: Saved ${saved} chat(s) to ${this.getConfig().outputDirectory}/`
                );
            } else {
                vscode.window.showInformationMessage('Copilot Chat Saver: All chats already up to date.');
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
