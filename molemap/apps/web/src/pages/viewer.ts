import * as THREE from 'three';
import { api, artifactUrl, type Artifact, type Mole, type Visit } from '../lib/api';
import { esc, fmtDate, showError } from '../lib/ui';
import { createScene, type Scene3D } from '../viewer/scene';
import { Pins, pickPoint, type PinData } from '../viewer/pins';
import { loadPointCloud } from '../viewer/pointcloud';
import { createTimeline } from '../viewer/timeline';
import { ensureSpark, loadSplatMesh, visitGroup } from '../viewer/splats';

interface VisitEntry {
  visit: Visit;
  artifacts: Artifact[];
  group: THREE.Group;
  loaded?: Promise<void>;
}

export async function renderViewer(app: HTMLElement): Promise<() => void> {
  document.title = 'molemap — viewer';
  const { visits } = await api.visits();
  const ready = visits.filter((v) => v.status === 'ready');

  app.innerHTML = `
    <div class="viewer">
      <div class="viewer-canvas" id="v-canvas"></div>
      <div class="viewer-top">
        <a class="btn secondary small" href="#/">‹ molemap</a>
        <span class="grow"></span>
        <button class="btn secondary small" id="v-points">Point cloud</button>
        <button class="btn small" id="v-pin">＋ Pin</button>
      </div>
      <aside class="viewer-side" id="v-side"></aside>
    </div>`;

  const container = document.getElementById('v-canvas')!;
  const side = document.getElementById('v-side')!;

  if (ready.length === 0) {
    container.innerHTML = `<div class="viewer-msg"><div>
      <h2>No visits yet</h2>
      <p>Run the molemap CLI to capture and upload your first visit,<br/>
      then it appears here as a 3D map.</p></div></div>`;
    side.remove();
    return () => {};
  }

  const scene3d = createScene(container);
  if (!scene3d) {
    container.innerHTML = `<div class="viewer-msg"><div>
      <h2>3D not available</h2>
      <p>This browser has no WebGL2 support, which the splat renderer needs.<br/>
      Try a current Chrome, Firefox, Safari, or Edge.</p></div></div>`;
    side.remove();
    return () => {};
  }

  // ---------------------------------------------------------- scene setup

  const entries: VisitEntry[] = [];
  for (const visit of ready) {
    const { artifacts } = await api.visit(visit.id);
    const group = visitGroup(JSON.parse(visit.alignment) as number[]);
    group.visible = false;
    scene3d.scene.add(group);
    entries.push({ visit, artifacts, group });
  }

  let showPoints = false;

  // Lazy per-visit load: splat via Spark, sparse point cloud alongside as
  // the raycast target and fallback. Failures degrade rather than break.
  function ensureLoaded(entry: VisitEntry): Promise<void> {
    entry.loaded ??= (async () => {
      const splat = entry.artifacts.find((a) => a.kind === 'splat');
      const cloud = entry.artifacts.find((a) => a.kind === 'pointcloud');
      let haveSplat = false;
      if (splat) {
        try {
          ensureSpark(scene3d!.scene, scene3d!.renderer);
          const mesh = await loadSplatMesh(artifactUrl(splat.sha256), splat.label || undefined);
          mesh.userData.role = 'splat';
          entry.group.add(mesh);
          haveSplat = true;
        } catch (err) {
          console.warn('splat load failed, falling back to point cloud', err);
        }
      }
      if (cloud) {
        try {
          const points = await loadPointCloud(artifactUrl(cloud.sha256));
          points.userData.role = 'points';
          // Visible when toggled on, or as the fallback when no splat loaded.
          points.visible = showPoints || !haveSplat;
          points.userData.fallback = !haveSplat;
          entry.group.add(points);
        } catch (err) {
          console.warn('point cloud load failed', err);
        }
      }
    })();
    return entry.loaded;
  }

  let current = entries.length - 1;
  function showVisit(index: number): void {
    current = index;
    entries.forEach((entry, i) => {
      entry.group.visible = i === index;
    });
    ensureLoaded(entries[index]!).catch(showError);
    // Preload the neighbor the slider will most likely hit next.
    if (index > 0) ensureLoaded(entries[index - 1]!).catch(() => {});
  }

  const timeline = createTimeline(
    entries.map((e) => ({ visitId: e.visit.id, capturedAt: e.visit.captured_at })),
    showVisit
  );
  document.querySelector('.viewer')!.appendChild(timeline.el);
  showVisit(current);

  // ---------------------------------------------------------- pins

  const pins = new Pins();
  scene3d.scene.add(pins.group);
  scene3d.onFrame((time) => pins.pulse(time));

  let moles: Mole[] = [];
  let selectedId: string | null = null;
  let pinMode = false;

  function toPinData(m: Mole): PinData {
    return {
      moleId: m.id,
      canonical: [m.canonical_x, m.canonical_y, m.canonical_z],
      status: m.status,
      label: m.label,
    };
  }

  async function refreshMoles(): Promise<void> {
    moles = (await api.moles()).moles.filter((m) => m.retired_at === null);
    pins.set(moles.map(toPinData));
    renderSide();
  }

  // ---------------------------------------------------------- sidebar

  function renderSide(): void {
    const proposed = moles.filter((m) => m.status === 'proposed');
    const confirmed = moles.filter((m) => m.status === 'confirmed');
    const selected = moles.find((m) => m.id === selectedId) ?? null;

    const pinItem = (m: Mole) => `
      <div class="pin-item ${m.id === selectedId ? 'selected' : ''}" data-pin="${m.id}">
        <span class="chip ${m.status}">${m.status === 'proposed' ? '?' : '●'}</span>
        <span class="grow">${esc(m.label || `mole-${m.id.slice(0, 4)}`)}</span>
        <span class="muted">${m.observation_count}×</span>
      </div>`;

    const detail = selected
      ? `
      <div class="card" style="margin-top:10px;">
        ${
          selected.latest?.crop_sha256
            ? `<img class="crop" src="${artifactUrl(selected.latest.crop_sha256)}" alt="Latest crop of ${esc(selected.label || 'mole')}" />`
            : ''
        }
        <label class="field" style="margin-top:10px;">
          <span>Label</span>
          <input type="text" id="pin-label" maxlength="80" value="${esc(selected.label)}" />
        </label>
        ${
          selected.status === 'proposed'
            ? `<div class="row" style="margin-bottom:10px;">
                <button class="btn small grow" id="pin-confirm">Confirm</button>
                <button class="btn danger small grow" id="pin-dismiss">Dismiss</button>
              </div>`
            : ''
        }
        <label class="field">
          <span>Note (this visit, ${fmtDate(entries[current]!.visit.captured_at)})</span>
          <input type="text" id="pin-note" maxlength="2000" />
        </label>
        <label class="field">
          <span>Diameter (mm)</span>
          <input type="number" id="pin-diameter" min="0.1" step="0.1"
            value="${selected.latest?.diameter_mm ?? ''}" />
        </label>
        <div class="row">
          <button class="btn small grow" id="pin-save">Save observation</button>
          <a class="btn secondary small" href="#/moles/${selected.id}">Passport</a>
        </div>
      </div>`
      : `<p class="muted">Select a pin, or use ＋ Pin to place one on the body.</p>`;

    side.innerHTML = `
      <div id="error-box" class="error hidden"></div>
      ${proposed.length ? `<h2>Proposed</h2>${proposed.map(pinItem).join('')}` : ''}
      <h2 style="margin-top:${proposed.length ? '10px' : '0'};">Moles</h2>
      ${confirmed.map(pinItem).join('') || '<p class="muted">None yet.</p>'}
      ${detail}`;

    for (const el of side.querySelectorAll<HTMLElement>('[data-pin]')) {
      el.addEventListener('click', () => {
        selectedId = el.dataset.pin!;
        pins.setSelected(selectedId);
        renderSide();
      });
    }
    if (!selected) return;

    document.getElementById('pin-confirm')?.addEventListener('click', async () => {
      try {
        await api.patchMole(selected.id, { status: 'confirmed' });
        await refreshMoles();
      } catch (err) {
        showError(err);
      }
    });
    document.getElementById('pin-dismiss')?.addEventListener('click', async () => {
      try {
        await api.patchMole(selected.id, { status: 'dismissed' });
        selectedId = null;
        await refreshMoles();
      } catch (err) {
        showError(err);
      }
    });
    document.getElementById('pin-save')?.addEventListener('click', async () => {
      const label = (document.getElementById('pin-label') as HTMLInputElement).value.trim();
      const note = (document.getElementById('pin-note') as HTMLInputElement).value.trim();
      const diameter = Number((document.getElementById('pin-diameter') as HTMLInputElement).value);
      try {
        if (label !== selected.label) await api.patchMole(selected.id, { label });
        await api.putObservation(selected.id, entries[current]!.visit.id, {
          ...(note ? { note } : {}),
          ...(diameter > 0 ? { diameter_mm: diameter } : {}),
        });
        await refreshMoles();
      } catch (err) {
        showError(err);
      }
    });
  }

  // ---------------------------------------------------------- input

  const raycaster = new THREE.Raycaster();
  const canvas = scene3d.renderer.domElement;
  let downAt: { x: number; y: number } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', async (e) => {
    // A click, not an orbit drag.
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    downAt = null;

    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, scene3d!.camera);

    if (pinMode) {
      // World hit = canonical position (the group applies the alignment).
      const point = pickPoint(raycaster, [entries[current]!.group]);
      if (!point) return;
      try {
        const { mole } = await api.createMole(point);
        selectedId = mole.id;
        setPinMode(false);
        await refreshMoles();
        pins.setSelected(selectedId);
      } catch (err) {
        showError(err);
      }
      return;
    }

    const picked = pins.pick(raycaster);
    if (picked) {
      selectedId = picked;
      pins.setSelected(picked);
      renderSide();
    }
  });

  const pinBtn = document.getElementById('v-pin') as HTMLButtonElement;
  function setPinMode(on: boolean): void {
    pinMode = on;
    pinBtn.textContent = on ? 'Tap the body…' : '＋ Pin';
    pinBtn.classList.toggle('ghost', on);
    canvas.style.cursor = on ? 'crosshair' : '';
  }
  pinBtn.addEventListener('click', () => setPinMode(!pinMode));

  const pointsBtn = document.getElementById('v-points') as HTMLButtonElement;
  pointsBtn.addEventListener('click', () => {
    showPoints = !showPoints;
    pointsBtn.classList.toggle('ghost', showPoints);
    for (const entry of entries) {
      entry.group.traverse((obj) => {
        if (obj.userData.role === 'points') obj.visible = showPoints || obj.userData.fallback;
        if (obj.userData.role === 'splat') obj.visible = !showPoints;
      });
    }
  });

  await refreshMoles();
  return () => scene3d.dispose();
}
