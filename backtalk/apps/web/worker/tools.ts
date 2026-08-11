// The MCP tool surface: what a coding agent needs to turn user feedback and
// captured errors into shipped fixes. Descriptions are written for the
// agent: pull items, offer the fix to your user, then set a status whose
// note the original submitter will see in the widget.

import * as db from './db';
import { generatePublicKey } from './auth';
import {
  canTransitionError,
  canTransitionFeedback,
  noteRequired,
  type ErrorStatus,
  type FeedbackStatus,
} from './lifecycle';

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolResult = { text: string; structured?: unknown };

export class ToolError extends Error {}

const FEEDBACK_STATUSES = ['seen', 'planned', 'done', 'declined'] as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'projects_list',
    description:
      'List the backtalk projects this account owns, with new-feedback and open-error counts. Start here to find the project id for the site you are working on.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'projects_create',
    description:
      'Create a backtalk project for a site you want to instrument. Returns the project id and its pk_ public key; embed the widget with <script src="https://backtalk.proc.io/w.js" data-key="pk_..." data-release="v1" defer></script>.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['name'],
    },
  },
  {
    name: 'feedback_list',
    description:
      'User-submitted feedback for a project: bugs, ideas, and general feedback typed by real visitors into the hidden widget, with page URL and a breadcrumb trail. Triage these with your user — offer to implement fixes for bugs and reasonable ideas, then record the outcome with feedback_set_status.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        status: { type: 'string', enum: ['new', 'seen', 'planned', 'done', 'declined'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'feedback_get',
    description:
      'One feedback item in full: message, page URL, viewport, user agent, site-set metadata, and the breadcrumb trail leading up to submission.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'feedback_set_status',
    description:
      "Advance a feedback item: seen -> planned -> done/declined (done and declined can be pulled back to planned). Set 'done' with a note when you have shipped the fix — the note is shown to the person who submitted it, so write it for them (e.g. 'Fixed in the latest deploy — thanks for the catch'). A note is required for done and declined.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: [...FEEDBACK_STATUSES] },
        note: { type: 'string', maxLength: 2000 },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'errors_list',
    description:
      "JavaScript errors captured on the project's pages, grouped by fingerprint: title, occurrence count, first/last seen, release range, status (open | resolved | regressed — regressed means it came back after being resolved, look at those first). Defaults to open groups.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'resolved', 'regressed'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'errors_get',
    description:
      'One error group with up to 10 sample events: message, stack trace, page URL, user agent, and the breadcrumb trail (clicks, navigations, console errors) before each crash — usually enough context to locate the bug in the codebase and offer your user a fix.',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'string' } },
      required: ['group_id'],
    },
  },
  {
    name: 'errors_set_status',
    description:
      "Resolve an error group after shipping a fix (status 'resolved'), or reopen one ('open'). If a resolved error occurs again it is automatically flagged 'regressed' by ingestion — you never set that yourself.",
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string' },
        status: { type: 'string', enum: ['resolved', 'open'] },
        note: { type: 'string', maxLength: 2000 },
      },
      required: ['group_id', 'status'],
    },
  },
  {
    name: 'stats_overview',
    description:
      'Web Vitals (LCP/INP/CLS daily rollups per path, with good/needs-improvement/poor buckets) and daily pageview counts — context for prioritizing performance work. Defaults to the last 14 days.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        days: { type: 'integer', minimum: 1, maximum: 90 },
      },
      required: ['project_id'],
    },
  },
];

const json = (v: unknown): ToolResult => ({ text: JSON.stringify(v, null, 2), structured: v });

function str(args: Record<string, unknown> | undefined, key: string): string {
  const v = args?.[key];
  if (typeof v !== 'string' || !v) throw new ToolError(`${key} is required`);
  return v;
}

async function ownedProject(d1: D1Database, userId: string, projectId: string) {
  const project = await db.getProject(d1, userId, projectId);
  if (!project) throw new ToolError('project not found (use projects_list for your project ids)');
  return project;
}

export async function callTool(
  d1: D1Database,
  userId: string,
  name: string,
  args: Record<string, unknown> | undefined
): Promise<ToolResult> {
  const limit = Math.min(Number(args?.limit) || 50, 200);

  switch (name) {
    case 'projects_list':
      return json({ projects: await db.listProjects(d1, userId) });

    case 'projects_create': {
      const name = str(args, 'name').trim().slice(0, 80);
      if (!name) throw new ToolError('name is required');
      await db.upsertUser(d1, userId);
      const id = crypto.randomUUID();
      const publicKey = generatePublicKey();
      await db.createProject(d1, { id, ownerId: userId, name, publicKey });
      return json({ id, public_key: publicKey });
    }

    case 'feedback_list': {
      const project = await ownedProject(d1, userId, str(args, 'project_id'));
      const status = (args?.status as FeedbackStatus | undefined) || undefined;
      return json({ items: await db.listFeedback(d1, project.id, status, limit) });
    }

    case 'feedback_get': {
      const item = await db.getFeedbackOwned(d1, userId, str(args, 'id'));
      if (!item) throw new ToolError('feedback item not found');
      return json({ item });
    }

    case 'feedback_set_status': {
      const item = await db.getFeedbackOwned(d1, userId, str(args, 'id'));
      if (!item) throw new ToolError('feedback item not found');
      const status = str(args, 'status') as FeedbackStatus;
      const note = typeof args?.note === 'string' ? args.note.trim().slice(0, 2000) : null;
      if (!canTransitionFeedback(item.status, status)) {
        throw new ToolError(`cannot go ${item.status} -> ${status}`);
      }
      if (noteRequired(status) && !note && !item.resolution_note) {
        throw new ToolError(`a note is required for ${status} — the submitter will see it`);
      }
      const ok = await db.setFeedbackStatus(d1, item.id, item.status, status, note);
      if (!ok) throw new ToolError('status changed concurrently, fetch it again');
      return json({ ok: true, id: item.id, status });
    }

    case 'errors_list': {
      const project = await ownedProject(d1, userId, str(args, 'project_id'));
      const status = (args?.status as ErrorStatus | undefined) || 'open';
      return json({ groups: await db.listErrorGroups(d1, project.id, status, limit) });
    }

    case 'errors_get': {
      const found = await db.getErrorGroupOwned(d1, userId, str(args, 'group_id'));
      if (!found) throw new ToolError('error group not found');
      return json(found);
    }

    case 'errors_set_status': {
      const found = await db.getErrorGroupOwned(d1, userId, str(args, 'group_id'));
      if (!found) throw new ToolError('error group not found');
      const status = str(args, 'status') as ErrorStatus;
      const note = typeof args?.note === 'string' ? args.note.trim().slice(0, 2000) : null;
      if (!canTransitionError(found.group.status, status)) {
        throw new ToolError(`cannot go ${found.group.status} -> ${status}`);
      }
      const ok = await db.setErrorStatus(d1, found.group.id, found.group.status, status, note);
      if (!ok) throw new ToolError('status changed concurrently, fetch it again');
      return json({ ok: true, group_id: found.group.id, status });
    }

    case 'stats_overview': {
      const project = await ownedProject(d1, userId, str(args, 'project_id'));
      const days = Math.min(Number(args?.days) || 14, 90);
      const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
      return json(await db.statsOverview(d1, project.id, since));
    }

    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}
