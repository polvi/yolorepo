import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppContext } from './env';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Passwords are three words joined without separators so the whole credential
 * is typeable on an e-ink keyboard without switching layers: lowercase letters
 * only, no digits or symbols. Every word is exactly four letters so the UI can
 * re-group a stored password for display by chunking. The Basic-auth username
 * is ignored entirely; the password alone identifies the account.
 */
const WORDS = `
bear boar bird buck bull calf carp clam colt crab crow deer dodo dove duck fawn
foal frog goat gull hare hawk herd hind ibex ibis joey kiwi lamb lark lion loon
lynx mare mink mole moth mule newt orca oxen pike pony puma rhea seal slug sole
stag swan teal tern toad tuna vole wasp wolf worm wren
bean beet brie cake chai chia cola corn curd date dill herb kale kelp leek lime
loaf malt milk mint miso naan oats okra pear pita plum rice roll sage salt soda
soup stew taro tart tofu udon whey
bark beam berg cave clay cove crag dale dawn dell dune dusk east echo fern foam
ford gale glen gust hail haze hill iris isle lake land lane leaf lily loam melt
mesa mist moon moor moss nova noon path peak peat pine pond pool rain reed reef
road rock root rose sand seed silt snow soil star stem surf tarn thaw tide twig
vale vine wave west wind wood
aqua blue coal cyan gold iron jade navy onyx opal pink ruby rust zinc
arch barn bath bell boat bolt book boot bowl cape card cart coat coin comb cord
cork deck desk dice dish dock door drum fife flag fork gate gear gong harp helm
horn hose kiln kite knot lace lamp lens lock loft loom lute mast nail oboe oven
page pail pawn pier plow plug post quay raft rail rake ring roof rope sail seat
shed ship shoe silk sink sled soap sock sofa step tent tile tray vase vest wall
well wick wire wool yarn
airy avid bold busy calm chic cool cozy dear deep deft dewy easy even fair fast
fine firm fond free full glad good hale half high hush iced keen kind late lean
long loud lush mild neat nice open posh prim pure rare rich ripe rosy safe slim
slow snug soft spry sure tall tame taut tidy tiny trim true vast warm wide wild
wise zany
bake bike clap dive flip flow fold gaze glow grin hike jump knit leap lift mend
nest play read roam sing skip soar spin stir swim tend toss tuck turn walk wash
weld wink wrap yawn zoom
brow byte camp chin chip city code crew data disk farm font gift hand heel hero
hope hour idea luck maze mind myth palm park poem port saga sign song tale team
tour town trek trip tune week yard year
`.split(/\s+/).filter(Boolean);

export function generateWords(count: number): string {
  const idx = crypto.getRandomValues(new Uint32Array(count));
  return [...idx].map((n) => WORDS[n % WORDS.length]).join('');
}

export function generatePassword(): string {
  return generateWords(3);
}

/** Re-group a stored password for display: every word is four letters. */
export function groupPassword(password: string): string {
  return password.match(/.{4}/g)?.join(' ') ?? password;
}

const NAV_TYPE = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const ACQ_TYPE = 'application/atom+xml;profile=opds-catalog;kind=acquisition';
const FEED_HEADERS = { 'Content-Type': 'application/atom+xml;charset=utf-8' };

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const iso = (ms: number) => new Date(ms).toISOString();

type NotebookData = { title?: string };
type DocData = { title?: string; sha256?: string; format?: 'pdf' | 'epub' };

/** The extension is load-bearing: KOReader sniffs filetype from the href suffix. */
function fileNameFor(title: string, format: 'pdf' | 'epub'): string {
  const base =
    title
      .replace(/[^\p{L}\p{N} ._-]/gu, '')
      .trim()
      .replace(/ +/g, '_')
      .slice(0, 80) || 'book';
  return `${base}.${format}`;
}

/**
 * Password-only Basic auth. Ereader OPDS clients (KOReader et al.) always send
 * Basic credentials; whatever precedes the colon is ignored so users never
 * have to type a username on a device keyboard.
 */
const opdsAuth = createMiddleware<AppContext>(async (c, next) => {
  const db = c.env.DB;
  if (!db) return c.text('opds not configured', 503);
  const unauthorized = () =>
    c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="happybook"' });

  const header = c.req.header('authorization');
  if (!header || !/^basic\s/i.test(header)) return unauthorized();
  let decoded: string;
  try {
    decoded = atob(header.split(/\s+/)[1] ?? '');
  } catch {
    return unauthorized();
  }
  // No colon means the client sent a bare token; treat the whole thing as the password.
  // Normalize what the user typed: e-ink keyboards auto-capitalize, and the UI
  // shows the password grouped with spaces. Generated passwords are strictly
  // lowercase letters, so lowercasing and dropping non-letters is lossless.
  const password = decoded
    .slice(decoded.indexOf(':') + 1)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!password) return unauthorized();

  const row = await db
    .prepare('SELECT user_id FROM opds_credentials WHERE password = ?1')
    .bind(password)
    .first<{ user_id: string }>();
  if (!row) return unauthorized();

  c.set('userId', row.user_id);
  await next();
});

export const opds = new Hono<AppContext>();
opds.use('*', opdsAuth);

/**
 * Feed hrefs are always fully qualified: relative URL resolution is the
 * flakiest part of OPDS clients, absolute links work everywhere.
 */
const originOf = (c: { req: { url: string } }) => new URL(c.req.url).origin;

function feedXml(opts: {
  id: string;
  title: string;
  self: string;
  start: string;
  kind: string;
  entries: string[];
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${esc(opts.id)}</id>
  <title>${esc(opts.title)}</title>
  <updated>${iso(Date.now())}</updated>
  <link rel="self" href="${esc(opts.self)}" type="${opts.kind}"/>
  <link rel="start" href="${esc(opts.start)}" type="${NAV_TYPE}"/>
${opts.entries.join('\n')}
</feed>
`;
}

function navEntry(title: string, id: string, updated: string, href: string): string {
  return `  <entry>
    <title>${esc(title)}</title>
    <id>${esc(id)}</id>
    <updated>${updated}</updated>
    <link rel="subsection" href="${esc(href)}" type="${ACQ_TYPE}"/>
  </entry>`;
}

opds.get('/', async (c) => {
  const db = c.env.DB!;
  const userId = c.get('userId');
  const base = `${originOf(c)}/api/opds`;

  const rows = await db
    .prepare(
      `SELECT id, data, updated_at FROM records
       WHERE user_id = ?1 AND type = 'notebook' AND deleted = 0
       ORDER BY updated_at DESC`,
    )
    .bind(userId)
    .all<{ id: string; data: string; updated_at: number }>();

  const entries = [
    navEntry('All books', `urn:happybook:${userId}:all`, iso(Date.now()), `${base}/all`),
    ...rows.results.map((r) => {
      const nb = JSON.parse(r.data) as NotebookData;
      return navEntry(nb.title ?? 'Untitled', `urn:happybook:nb:${r.id}`, iso(r.updated_at), `${base}/nb/${r.id}`);
    }),
  ];

  return c.text(
    feedXml({
      id: `urn:happybook:${userId}`,
      title: 'happybook',
      self: base,
      start: base,
      kind: NAV_TYPE,
      entries,
    }),
    200,
    FEED_HEADERS,
  );
});

async function acquisitionFeed(
  c: Parameters<Parameters<typeof opds.get>[1]>[0],
  title: string,
  feedPath: string,
  notebookId?: string,
) {
  const db = c.env.DB!;
  const userId = c.get('userId');
  const base = `${originOf(c)}/api/opds`;

  const query = notebookId
    ? `SELECT id, data, updated_at FROM records
       WHERE user_id = ?1 AND type = 'document' AND deleted = 0 AND notebook_id = ?2
       ORDER BY updated_at DESC`
    : `SELECT id, data, updated_at FROM records
       WHERE user_id = ?1 AND type = 'document' AND deleted = 0
       ORDER BY updated_at DESC`;
  const stmt = notebookId
    ? db.prepare(query).bind(userId, notebookId)
    : db.prepare(query).bind(userId);
  const rows = await stmt.all<{ id: string; data: string; updated_at: number }>();

  const entries = rows.results.flatMap((r) => {
    const doc = JSON.parse(r.data) as DocData;
    if (!doc.sha256) return [];
    // Records that predate EPUB support have no format field and are PDFs.
    const format = doc.format ?? 'pdf';
    const mime = format === 'epub' ? 'application/epub+zip' : 'application/pdf';
    const docTitle = doc.title ?? 'Untitled';
    const href = `${base}/dl/${doc.sha256}/${encodeURIComponent(fileNameFor(docTitle, format))}`;
    return [
      `  <entry>
    <title>${esc(docTitle)}</title>
    <id>urn:happybook:doc:${esc(r.id)}</id>
    <updated>${iso(r.updated_at)}</updated>
    <link rel="http://opds-spec.org/acquisition" href="${esc(href)}" type="${mime}"/>
  </entry>`,
    ];
  });

  return c.text(
    feedXml({
      id: `urn:happybook:${userId}:${feedPath}`,
      title,
      self: `${base}/${feedPath}`,
      start: base,
      kind: ACQ_TYPE,
      entries,
    }),
    200,
    FEED_HEADERS,
  );
}

opds.get('/all', (c) => acquisitionFeed(c, 'All books', 'all'));

opds.get('/nb/:id', async (c) => {
  const db = c.env.DB!;
  const id = c.req.param('id');
  const row = await db
    .prepare(
      `SELECT data FROM records WHERE user_id = ?1 AND id = ?2 AND type = 'notebook' AND deleted = 0`,
    )
    .bind(c.get('userId'), id)
    .first<{ data: string }>();
  if (!row) return c.text('not found', 404);
  const nb = JSON.parse(row.data) as NotebookData;
  return acquisitionFeed(c, nb.title ?? 'Untitled', `nb/${id}`, id);
});

opds.get('/dl/:sha256/:filename', async (c) => {
  const bucket = c.env.BLOBS;
  if (!bucket) return c.text('opds not configured', 503);
  const sha = c.req.param('sha256');
  if (!SHA256_HEX.test(sha)) return c.text('invalid sha256', 400);

  const object = await bucket.get(`${c.get('userId')}/${sha}`);
  if (!object) return c.text('not found', 404);

  const safeName =
    c.req.param('filename').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 100) || 'book';
  return c.body(object.body, 200, {
    // Objects written before EPUB support carry the old hardcoded PDF type.
    'Content-Type': object.httpMetadata?.contentType ?? 'application/pdf',
    'Content-Length': String(object.size),
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

/** Cookie-authed management endpoints; mounted behind requireUser. */
export const opdsSettings = new Hono<AppContext>();

type SettingsContext = Parameters<Parameters<typeof opdsSettings.get>[1]>[0];

function credentials(c: SettingsContext, password: string | null) {
  if (!password) return c.json({ enabled: false as const });
  return c.json({
    enabled: true as const,
    password,
    passwordGrouped: groupPassword(password),
    url: `${originOf(c)}/api/opds`,
  });
}

opdsSettings.get('/', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'opds not configured' }, 503);
  const row = await db
    .prepare('SELECT password FROM opds_credentials WHERE user_id = ?1')
    .bind(c.get('userId'))
    .first<{ password: string }>();
  return credentials(c, row?.password ?? null);
});

opdsSettings.post('/', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'opds not configured' }, 503);
  const userId = c.get('userId');

  // The UNIQUE(password) constraint can collide with another user's token;
  // with a random ~26-bit password the retry is virtually never taken.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const password = generatePassword();
    try {
      await db
        .prepare(
          `INSERT INTO opds_credentials (user_id, password, created_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (user_id) DO UPDATE SET password = excluded.password, created_at = excluded.created_at`,
        )
        .bind(userId, password, Date.now())
        .run();
      return credentials(c, password);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
});

opdsSettings.delete('/', async (c) => {
  const db = c.env.DB;
  if (!db) return c.json({ error: 'opds not configured' }, 503);
  await db
    .prepare('DELETE FROM opds_credentials WHERE user_id = ?1')
    .bind(c.get('userId'))
    .run();
  return credentials(c, null);
});
