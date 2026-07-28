import type { SiteRow } from './sites';

// Server-rendered apex page: landing when signed out, site manager when
// signed in. Kept dependency-free; the interesting UI lives on the sites.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const SHELL_CSS = `
:root { --ink:#1c1b1a; --paper:#faf8f5; --accent:#c04e2a; --muted:#8a857e; }
* { box-sizing:border-box; }
body { margin:0; font-family:Georgia,'Times New Roman',serif; color:var(--ink);
  background:var(--paper); line-height:1.6; }
main { max-width:38rem; margin:0 auto; padding:4rem 1.25rem; }
h1 { font-size:2.4rem; line-height:1.1; margin:0 0 1rem; }
h1 .fork { color:var(--accent); }
p.lede { font-size:1.1rem; }
a { color:var(--accent); }
.btn { display:inline-block; font:inherit; padding:.5rem 1.1rem; border-radius:999px;
  border:1px solid var(--ink); background:var(--ink); color:var(--paper);
  text-decoration:none; cursor:pointer; }
.btn.ghost { background:transparent; color:var(--ink); }
ul.sites { list-style:none; padding:0; }
ul.sites li { display:flex; align-items:baseline; gap:.75rem; padding:.5rem 0;
  border-bottom:1px solid #0001; }
ul.sites .del { margin-left:auto; font-size:.85rem; color:var(--muted);
  background:none; border:none; cursor:pointer; font-family:inherit; }
form.create { display:flex; gap:.5rem; margin:1.5rem 0; }
form.create input { flex:1; font:inherit; padding:.5rem .8rem; border:1px solid #0003;
  border-radius:.5rem; background:#fff; }
.err { color:var(--accent); min-height:1.5rem; }
footer { margin-top:4rem; color:var(--muted); font-size:.85rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${SHELL_CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export function landingPage(loginUrl: string, seedUrl: string): string {
  return page(
    'forkable',
    `<h1>fork<span class="fork">able</span></h1>
<p class="lede">Websites you make by talking, built on copies you can't break.
Every site here can be edited by anyone — your edits become your own fork,
live instantly, saved to your account.</p>
<p><a class="btn" href="${esc(loginUrl)}">Sign in with a passkey</a>
&nbsp; <a class="btn ghost" href="${esc(seedUrl)}">See a forkable site</a></p>
<footer>Plain files under the hood. Auth by passkeys, inference by TPX.</footer>`
  );
}

export function dashboardPage(sites: SiteRow[], logoutNote: string): string {
  const list = sites.length
    ? `<ul class="sites">${sites
        .map(
          (s) =>
            `<li><a class="site-link" data-name="${esc(s.name)}" href="#">${esc(s.name)}</a>
<button class="del" data-name="${esc(s.name)}">delete</button></li>`
        )
        .join('')}</ul>`
    : `<p>No sites yet. Name one and start talking to it.</p>`;

  return page(
    'forkable · your sites',
    `<h1>Your sites</h1>
${list}
<form class="create" id="create">
  <input name="name" placeholder="site-name" autocomplete="off" spellcheck="false"
    pattern="[a-z0-9][a-z0-9-]*" maxlength="40" required>
  <button class="btn" type="submit">Create</button>
</form>
<p class="err" id="err"></p>
<footer>${esc(logoutNote)}</footer>
<script>
const siteHost = (name) => name + '.' + location.host;
for (const a of document.querySelectorAll('.site-link'))
  a.href = location.protocol + '//' + siteHost(a.dataset.name) + '/';
document.getElementById('create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = new FormData(e.target).get('name');
  const res = await fetch('/api/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    credentials: 'include',
  });
  if (res.ok) location.href = location.protocol + '//' + siteHost(name) + '/';
  else document.getElementById('err').textContent = (await res.json()).error ?? 'Something went wrong.';
});
for (const b of document.querySelectorAll('.del'))
  b.addEventListener('click', async () => {
    if (!confirm('Delete ' + b.dataset.name + '? The site and all forks of it go away.')) return;
    await fetch('/api/sites/' + b.dataset.name, { method: 'DELETE', credentials: 'include' });
    location.reload();
  });
</script>`
  );
}
