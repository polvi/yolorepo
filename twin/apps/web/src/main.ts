import { createScene, frameObject, loadSplatMesh } from './viewer';

interface SceneEntry {
  slug: string;
  title: string;
  created: string;
  size: number;
}

interface SceneMeta extends SceneEntry {
  file: string;
  sha256: string;
  rotXDeg?: number;
}

const app = document.getElementById('app')!;

function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

async function home(): Promise<void> {
  const res = await fetch('/api/scenes');
  const { scenes } = (await res.json()) as { scenes: SceneEntry[] };

  const list =
    scenes.length === 0
      ? `<div class="empty">No scenes published yet. From the repo:
           <code>bun twin/bin/publish.ts &lt;slug&gt; &lt;scene.sog&gt; --title "…"</code></div>`
      : `<ul class="scene-list">${scenes
          .map(
            (s) => `<li><a class="scene-card" href="/s/${s.slug}">
                <span>${s.title}</span>
                <span class="meta">${s.created.slice(0, 10)} · ${fmtSize(s.size)}</span>
              </a></li>`
          )
          .join('')}</ul>`;

  app.replaceChildren(
    el(`<div class="home">
      <h1>twin</h1>
      <p class="tagline">High-res digital twins of real places: drone photogrammetry,
        rendered as Gaussian splats, right in your browser.</p>
      ${list}
      <footer>an <a href="https://infinitelogic.org">Infinite Logic</a> experiment ·
        <a href="/llms.txt">llms.txt</a></footer>
    </div>`)
  );
}

async function viewer(slug: string): Promise<void> {
  const root = el(`<div class="viewer">
    <div class="overlay">
      <div>loading scene…</div>
      <div class="bar"><div></div></div>
      <div class="status"></div>
    </div>
    <div class="hud" hidden>
      <span class="title"></span>
      <button class="share">share</button>
    </div>
    <div class="hint" hidden>drag to orbit · scroll or pinch to zoom · two fingers to pan</div>
  </div>`);
  app.replaceChildren(root);

  const overlay = root.querySelector<HTMLElement>('.overlay')!;
  const bar = root.querySelector<HTMLElement>('.bar > div')!;
  const status = root.querySelector<HTMLElement>('.status')!;
  const fail = (msg: string) => {
    bar.parentElement!.hidden = true;
    status.textContent = msg;
  };

  const res = await fetch(`/api/scenes/${slug}`);
  if (!res.ok) return fail(res.status === 404 ? 'scene not found' : `error ${res.status}`);
  const meta = (await res.json()) as SceneMeta;
  document.title = `${meta.title} — twin`;

  const view = createScene(root);
  if (!view) return fail('this browser lacks WebGL2, which the splat renderer needs');

  let mesh;
  try {
    mesh = await loadSplatMesh(`/api/scenes/${slug}/artifact`, meta.file, (loaded, total) => {
      const pct = total ? Math.round((loaded / total) * 100) : 0;
      bar.style.width = `${pct}%`;
      status.textContent = total ? `${fmtSize(loaded)} of ${fmtSize(total)}` : fmtSize(loaded);
    });
  } catch {
    view.dispose();
    return fail('failed to load the scene data');
  }

  // OpenSplat output lives in COLMAP coordinates (y down); rotate into
  // three's y-up world. Publishers can override per scene.
  mesh.rotation.x = ((meta.rotXDeg ?? 180) * Math.PI) / 180;
  view.scene.add(mesh);
  frameObject(view, mesh);

  overlay.remove();
  const hud = root.querySelector<HTMLElement>('.hud')!;
  const hint = root.querySelector<HTMLElement>('.hint')!;
  hud.hidden = false;
  hint.hidden = false;
  setTimeout(() => hint.remove(), 6000);

  hud.querySelector('.title')!.textContent = meta.title;
  hud.querySelector<HTMLButtonElement>('.share')!.onclick = async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    await navigator.clipboard.writeText(location.href);
    btn.textContent = 'link copied ✓';
    setTimeout(() => (btn.textContent = 'share'), 1500);
  };
}

const m = location.pathname.match(/^\/s\/([a-z0-9][a-z0-9-]{0,63})$/);
if (m) void viewer(m[1]!);
else void home();
