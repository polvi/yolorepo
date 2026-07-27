import { Hono } from 'hono';
import { requireUser } from './auth';
import { sync } from './sync';
import { blobs } from './blobs';
import { opds, opdsSettings } from './opds';
import { kosync, kosyncSettings } from './kosync';
import type { AppContext, Env } from './env';

// strict:false tolerates trailing slashes — catalog URLs get hand-typed on
// e-reader keyboards, and /api/opds/ must reach the worker, not the SPA shell.
const app = new Hono<AppContext>({ strict: false });

app.get('/api/health', (c) => c.json({ ok: true }));

// OPDS speaks its own Basic auth, so it must be mounted before requireUser:
// requireUser forwards the Authorization header to AuthGravity, which would
// reject an ereader's Basic credentials before the catalog ever saw them.
app.route('/api/opds', opds);
// Catalog URLs get hand-typed on device keyboards and opds/odps is a common
// transposition; serve the catalog under both spellings.
app.route('/api/odps', opds);

// kosync speaks its own x-auth-user/x-auth-key headers; mounted before
// requireUser for the same reason as OPDS.
app.route('/api/kosync', kosync);

app.use('/api/*', requireUser);
app.get('/api/me', (c) => c.json({ user_id: c.get('userId') }));
app.route('/api/sync', sync);
app.route('/api/blobs', blobs);
app.route('/api/opds-settings', opdsSettings);
app.route('/api/kosync-settings', kosyncSettings);

// Anything that is not /api/* is a static asset (or the SPA fallback).
// In production the assets layer answers those before the worker runs;
// this covers wrangler dev and any run_worker_first overlap.
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
export type { Env };
