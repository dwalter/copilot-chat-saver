export interface PromptContext {
    date: string;
    time: string;
    sessionId: string;
    turnCount: string;
    firstMessage: string;
    workspaceName: string;
    model: string;
    ticketId: string;
}

export function renderPrompt(template: string, context: PromptContext): string {
    const withConditionals = template.replace(
        /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}([\s\S]*?)\{\{\s*\/\1\s*\}\}/g,
        (block, key: string, inner: string) => {
            if (!(key in context)) {
                return block;
            }

            const value = context[key as keyof PromptContext];
            return value ? inner : '';
        }
    );

    return withConditionals.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (token, key: string) => {
        if (!(key in context)) {
            return token;
        }

        const value = context[key as keyof PromptContext];
        return value ?? '';
    });
}
