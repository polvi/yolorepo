// The seed site: the canonical demo and the template every new site forks
// from. Relative paths only — sites are served from a subdomain root, but
// forks previewed locally must not depend on absolute URLs.

const indexHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A forkable site</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<main>
  <h1>This site is forkable</h1>
  <p>Everything you see here is a small pile of plain files. Open the edit
  panel in the corner and tell it what you want this site to become — a
  portfolio, a zine, a shrine to your cat. Your changes become your own copy,
  instantly.</p>
  <p>No accounts of record, no builders, no templates to fight. Just describe
  the site you want and watch it take shape.</p>
  <p><a href="about.html">How does this work?</a></p>
</main>
</body>
</html>
`;

const aboutHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>About · A forkable site</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<main>
  <h1>How this works</h1>
  <p>Every forkable site is a set of plain HTML, CSS, and JavaScript files.
  When you edit, you get your own copy — your changes live alongside the
  original without touching it. Come back any time, from any device, and your
  version is waiting.</p>
  <p><a href="index.html">Back home</a></p>
</main>
</body>
</html>
`;

const styleCss = `:root {
  --ink: #1c1b1a;
  --paper: #faf8f5;
  --accent: #c04e2a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Georgia, 'Times New Roman', serif;
  color: var(--ink);
  background: var(--paper);
  line-height: 1.6;
}
main {
  max-width: 38rem;
  margin: 0 auto;
  padding: 4rem 1.25rem;
}
h1 {
  font-size: 2rem;
  line-height: 1.2;
  margin: 0 0 1.5rem;
}
a { color: var(--accent); }
`;

export const SEED_FILES: Record<string, string> = {
  'index.html': indexHtml,
  'about.html': aboutHtml,
  'style.css': styleCss,
};
