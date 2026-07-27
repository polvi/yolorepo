// /account — passkey sign-in (own UI over the raw AuthGravity WebAuthn API),
// mint/revoke API keys, toggle hub publishing. All state is keyed by the
// AuthGravity user UUID; the plaintext API key exists only in the response
// that mints it.

import { authgravityOrigin, generateApiKey, sha256Hex, whoami } from "./auth";
import { escapeHtml, page } from "./page";

// Two-button passkey UI per the AuthGravity integration guide: no usernames,
// no email, no forms. Uses the browser's native WebAuthn JSON helpers
// (parseCreationOptionsFromJSON / toJSON), so there is no client dependency.
const authScript = (authgravity: string) => `<script>
const AG = ${JSON.stringify(authgravity)};
const api = (path, init = {}) => fetch(AG + path, { ...init, credentials: "include" });
const fail = (err) => {
  const el = document.getElementById("autherr");
  if (el) el.textContent = String(err && err.message || err);
};
async function verify(path, cred) {
  const res = await api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cred.toJSON()),
  });
  const out = await res.json();
  if (!out.verified) throw new Error("not verified");
  location.reload();
}
document.getElementById("btn-register")?.addEventListener("click", async () => {
  try {
    const opts = await (await api("/v1/register/options")).json();
    const cred = await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts),
    });
    await verify("/v1/register/verify", cred);
  } catch (err) { fail(err); }
});
document.getElementById("btn-login")?.addEventListener("click", async () => {
  try {
    const opts = await (await api("/v1/login/options")).json();
    const cred = await navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts),
    });
    await verify("/v1/login/verify", cred);
  } catch (err) { fail(err); }
});
document.getElementById("btn-logout")?.addEventListener("click", async () => {
  await api("/v1/logout", { method: "POST" });
  location.reload();
});
</script>`;

interface KeyRow {
  key_hash: string;
  created_at: string;
  last_used_at: string | null;
}

async function loadUser(db: D1Database, userId: string): Promise<{ publish: boolean; keys: KeyRow[] }> {
  await db
    .prepare("INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING")
    .bind(userId)
    .run();
  const row = await db
    .prepare("SELECT publish FROM users WHERE id = ?")
    .bind(userId)
    .first<{ publish: number }>();
  const { results: keys } = await db
    .prepare("SELECT key_hash, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at")
    .bind(userId)
    .all<KeyRow>();
  return { publish: (row?.publish ?? 1) === 1, keys };
}

function accountPage(
  url: URL,
  authgravity: string,
  userId: string,
  publish: boolean,
  keys: KeyRow[],
  freshKey?: string,
): Response {
  const keyRows = keys
    .map(
      (k) => `<tr>
<td><code>${k.key_hash.slice(0, 12)}…</code></td>
<td class="dim">${escapeHtml(k.created_at)} UTC</td>
<td class="dim">${k.last_used_at ? `${escapeHtml(k.last_used_at)} UTC` : "never used"}</td>
<td><form method="post" action="/account/keys/revoke">
<input type="hidden" name="key_hash" value="${k.key_hash}">
<button class="plain">Revoke</button></form></td>
</tr>`,
    )
    .join("\n");

  const fresh = freshKey
    ? `<div class="card">
<p><b>Your new API key</b> — copy it now; it is stored only as a hash and
cannot be shown again.</p>
<div class="copywrap">
<pre><code id="copy-key">${escapeHtml(freshKey)}</code></pre>
<button class="copybtn" data-copy="copy-key" aria-label="Copy API key"></button>
</div>
<p>If you already added <code>tlc</code> without a key, remove it first:</p>
<div class="copywrap">
<pre><code id="copy-rm">claude mcp remove --scope user tlc</code></pre>
<button class="copybtn" data-copy="copy-rm" aria-label="Copy remove command"></button>
</div>
<p>Then point Claude Code at the checker with your key:</p>
<div class="copywrap">
<pre><code id="copy-add">claude mcp add --scope user --transport http tlc ${url.origin}/mcp \\
  --header "Authorization: Bearer ${escapeHtml(freshKey)}"</code></pre>
<button class="copybtn" data-copy="copy-add" aria-label="Copy add command"></button>
</div>
</div>`
    : "";

  return page(
    url.host,
    `Account — ${url.host}`,
    `<h1>Account</h1>
<p class="tag">Signed in as <code>${escapeHtml(userId)}</code> ·
<button id="btn-logout" class="plain">Sign out</button></p>
${fresh}
<h2>Publishing</h2>
<p>When a <code>tlc_check</code> you run with an API key passes, the spec and
config are published to <a href="/hub">the hub</a> as the next generation of
that module. Turn this off to stop publishing and hide everything you have
already published (turning it back on restores it). A single call can also opt
out with <code>publish: false</code>.</p>
<form method="post" action="/account/publish">
<input type="hidden" name="publish" value="${publish ? "0" : "1"}">
<button>${publish ? "Turn publishing off" : "Turn publishing on"}</button>
<span class="dim"> currently ${publish ? "on" : "off"}</span>
</form>
<h2>API keys</h2>
${
      keys.length === 0
        ? `<p class="dim">No keys yet.</p>`
        : `<table>
<tr><th>key (hash)</th><th>created</th><th>last used</th><th></th></tr>
${keyRows}
</table>`
    }
<form method="post" action="/account/keys"><button>Create API key</button></form>
${authScript(authgravity)}`,
  );
}

function signInPage(url: URL, authgravity: string): Response {
  return page(
    url.host,
    `Sign in — ${url.host}`,
    `<h1>Sign in</h1>
<p class="tag">Checking requires an account: it gets you an API key for the
MCP and REST endpoints, and (by default) publishes your passing specs to
<a href="/hub">the hub</a>. Sign-in is a passkey — no email, no password, no
username; the service learns nothing about you but a UUID.</p>
<p>
<button id="btn-register">Create Account</button>
&nbsp;<button id="btn-login" class="plain">Login</button>
</p>
<p id="autherr" class="dim"></p>
<p class="dim">Powered by <a href="https://authgravity.org">AuthGravity</a>.</p>
${authScript(authgravity)}`,
  );
}

/** Routes GET /account and POST /account/{keys,keys/revoke,publish}. */
export async function handleAccount(
  request: Request,
  env: { DB: D1Database; AUTH_ENDPOINT?: string },
): Promise<Response> {
  const db = env.DB;
  const authgravity = authgravityOrigin(env);
  const url = new URL(request.url);
  const userId = await whoami(request, authgravity);
  if (!userId) {
    if (request.method === "POST") return new Response("sign in first\n", { status: 401 });
    return signInPage(url, authgravity);
  }

  if (request.method === "GET" && url.pathname === "/account") {
    const { publish, keys } = await loadUser(db, userId);
    return accountPage(url, authgravity, userId, publish, keys);
  }

  if (request.method !== "POST") return new Response("method not allowed\n", { status: 405 });
  // Same-origin check: these are cookie-authenticated form posts.
  const origin = request.headers.get("origin");
  if (origin !== url.origin) return new Response("cross-origin post rejected\n", { status: 403 });

  switch (url.pathname) {
    case "/account/keys": {
      const { publish } = await loadUser(db, userId);
      const key = generateApiKey();
      await db
        .prepare("INSERT INTO api_keys (key_hash, user_id) VALUES (?, ?)")
        .bind(await sha256Hex(key), userId)
        .run();
      const { keys } = await loadUser(db, userId);
      return accountPage(url, authgravity, userId, publish, keys, key);
    }
    case "/account/keys/revoke": {
      const form = await request.formData();
      const keyHash = String(form.get("key_hash") ?? "");
      await db
        .prepare("DELETE FROM api_keys WHERE key_hash = ? AND user_id = ?")
        .bind(keyHash, userId)
        .run();
      return Response.redirect(`${url.origin}/account`, 303);
    }
    case "/account/publish": {
      const form = await request.formData();
      const publish = String(form.get("publish")) === "1" ? 1 : 0;
      await db
        .prepare("UPDATE users SET publish = ? WHERE id = ?")
        .bind(publish, userId)
        .run();
      return Response.redirect(`${url.origin}/account`, 303);
    }
    default:
      return new Response("not found\n", { status: 404 });
  }
}
