import { addSpent, getModel, tpxFetch } from './tpx';
import { deleteFile, listFiles, readFile, writeFile } from './repo';

// The editing loop: one user message in, a run of tool-calling rounds against
// the working tree, one assistant reply out. Non-streaming — tool-call
// streaming buys little for small sites and costs a lot of parsing.

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_ROUNDS = 16;
const MAX_HISTORY = 12;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List every file in the site.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the site.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'e.g. index.html' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the full new content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the site.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
];

async function systemPrompt(): Promise<string> {
  const files = await listFiles();
  return [
    'You edit a small static website for its owner, who is talking to you from',
    'an editor panel on the site itself. The site is plain HTML, CSS, and',
    'JavaScript files with no build step: what you write is exactly what is',
    'served. Rules:',
    '- Use only relative URLs between the site files (href="about.html",',
    '  src="style.css") — never absolute paths or external CDNs.',
    '- Keep the site self-contained and small. Inline is fine.',
    '- Make the change the user asks for; do not redesign unasked.',
    '- Read a file before rewriting it unless you are replacing it wholesale.',
    '- write_file takes the complete new file content, not a diff.',
    '- Never create or modify files under /__forkable__ (reserved).',
    '',
    `Current files: ${files.join(', ')}`,
  ].join('\n');
}

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

async function execTool(call: ToolCall): Promise<string> {
  let args: { path?: string; content?: string };
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return 'error: arguments were not valid JSON';
  }
  const path = (args.path ?? '').replace(/^\/+/, '');
  if (path.includes('..') || path.startsWith('__forkable__')) return 'error: path not allowed';
  try {
    switch (call.function.name) {
      case 'list_files':
        return (await listFiles()).join('\n') || '(empty site)';
      case 'read_file':
        return await readFile(path);
      case 'write_file':
        await writeFile(path, args.content ?? '');
        return `wrote ${path}`;
      case 'delete_file':
        await deleteFile(path);
        return `deleted ${path}`;
      default:
        return `error: unknown tool ${call.function.name}`;
    }
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export interface TurnResult {
  reply: string;
  touched: string[];
}

/**
 * Run one user turn. Throws on transport/grant errors; provider-level errors
 * (budget, model) surface as thrown Errors with a `code` where available.
 */
export async function runTurn(
  history: ChatMessage[],
  userMessage: string,
  onProgress: (note: string) => void
): Promise<TurnResult> {
  const messages: unknown[] = [
    { role: 'system', content: await systemPrompt() },
    ...history.slice(-MAX_HISTORY),
    { role: 'user', content: userMessage },
  ];
  const touched: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await tpxFetch('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getModel(),
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 8192,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
      usage?: { cost?: number };
      choices?: Array<{ message: { content?: string; tool_calls?: ToolCall[] } }>;
    };
    if (!res.ok) {
      const e = new Error(body.error?.message ?? body.error?.code ?? `request failed (${res.status})`) as Error & {
        code?: string;
        status?: number;
      };
      e.code = body.error?.code;
      e.status = res.status;
      throw e;
    }
    if (typeof body.usage?.cost === 'number') addSpent(body.usage.cost);

    const message = body.choices?.[0]?.message;
    if (!message) throw new Error('empty response from the model');
    messages.push(message);

    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        const args = (() => {
          try {
            return JSON.parse(call.function.arguments || '{}') as { path?: string };
          } catch {
            return {};
          }
        })();
        if (call.function.name === 'write_file' && args.path) {
          onProgress(`✎ ${args.path}`);
          touched.push(args.path);
        } else if (call.function.name === 'delete_file' && args.path) {
          onProgress(`✕ ${args.path}`);
          touched.push(args.path);
        } else if (args.path) {
          onProgress(`👁 ${args.path}`);
        }
        const result = await execTool(call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      continue;
    }
    return { reply: message.content ?? '(no reply)', touched };
  }
  return { reply: '(stopped: too many editing rounds in one message)', touched };
}
