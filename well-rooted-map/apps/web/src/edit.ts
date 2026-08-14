import type maplibregl from 'maplibre-gl';
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import { KINDS } from './regions';

type Meta = { name: string; kind: string };

// Work in progress survives refreshes via localStorage; "Reset" discards it
// and reloads the published regions.geojson.
const STORAGE_KEY = 'wrm-edit-regions';

// Region editor, reached via /?edit. Draw polygons over the orthophoto, name
// them, export regions.geojson, commit it to the repo. Nothing is persisted
// server-side; the exported file is the source of truth.
export function setupEditor(map: maplibregl.Map): void {
  const draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: [
      new TerraDrawPolygonMode(),
      new TerraDrawSelectMode({
        flags: {
          polygon: {
            feature: {
              draggable: true,
              coordinates: { midpoints: true, draggable: true, deletable: true },
            },
          },
        },
      }),
    ],
  });
  draw.start();
  draw.setMode('select');

  const meta = new Map<string, Meta>();

  const panel = document.createElement('div');
  panel.id = 'edit-panel';
  panel.innerHTML = `
    <h2>Region editor</h2>
    <div class="row">
      <input id="ed-name" type="text" placeholder="Region name" />
      <select id="ed-kind">${Object.entries(KINDS)
        .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
        .join('')}</select>
    </div>
    <div class="row">
      <button id="ed-draw">Draw region</button>
      <button id="ed-select">Select / adjust</button>
    </div>
    <p class="hint">Draw: click to add corners, click the last corner again (or press Enter) to finish. Select: drag corners to adjust.</p>
    <ul id="ed-list"></ul>
    <div class="row">
      <button id="ed-export">Download regions.geojson</button>
      <button id="ed-copy">Copy</button>
    </div>
    <p class="hint">Edits auto-save in this browser. <button id="ed-reset">Reset to published</button></p>
  `;
  document.body.appendChild(panel);

  const nameInput = panel.querySelector('#ed-name') as HTMLInputElement;
  const kindSelect = panel.querySelector('#ed-kind') as unknown as HTMLSelectElement;
  const list = panel.querySelector('#ed-list') as HTMLUListElement;

  const refreshList = () => {
    list.innerHTML = '';
    for (const f of draw.getSnapshot()) {
      const id = String(f.id);
      const m = meta.get(id) ?? { name: 'Untitled', kind: 'other' };
      const li = document.createElement('li');
      const swatch = `<span class="swatch" style="background:${KINDS[m.kind]?.color ?? '#ccc'}"></span>`;
      li.innerHTML = `${swatch}<input value="${m.name.replace(/"/g, '&quot;')}" /><select>${Object.entries(
        KINDS
      )
        .map(([k, v]) => `<option value="${k}" ${k === m.kind ? 'selected' : ''}>${v.label}</option>`)
        .join('')}</select><button title="Delete">✕</button>`;
      li.querySelector('input')!.addEventListener('change', (e) => {
        meta.set(id, { ...m, name: (e.target as HTMLInputElement).value });
        saveLocal();
      });
      li.querySelector('select')!.addEventListener('change', (e) => {
        meta.set(id, { ...meta.get(id)!, kind: (e.target as HTMLSelectElement).value });
        refreshList();
        saveLocal();
      });
      li.querySelector('button')!.addEventListener('click', () => {
        draw.removeFeatures([f.id as string]);
        meta.delete(id);
        refreshList();
        saveLocal();
      });
      list.appendChild(li);
    }
  };

  draw.on('finish', (id, context) => {
    if (context.action === 'draw') {
      meta.set(String(id), {
        name: nameInput.value.trim() || 'Untitled',
        kind: kindSelect.value,
      });
      nameInput.value = '';
      refreshList();
    }
    // Fires for geometry adjustments in select mode too; save either way.
    saveLocal();
  });

  panel.querySelector('#ed-draw')!.addEventListener('click', () => draw.setMode('polygon'));
  panel.querySelector('#ed-select')!.addEventListener('click', () => draw.setMode('select'));

  const saveLocal = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(exportGeoJSON()));
    } catch {}
  };

  const exportGeoJSON = () => ({
    type: 'FeatureCollection' as const,
    features: draw.getSnapshot().map((f) => {
      const m = meta.get(String(f.id)) ?? { name: 'Untitled', kind: 'other' };
      return {
        type: 'Feature' as const,
        properties: { id: String(f.id), name: m.name, kind: m.kind },
        geometry: f.geometry,
      };
    }),
  });

  panel.querySelector('#ed-export')!.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(exportGeoJSON(), null, 2)], {
      type: 'application/geo+json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'regions.geojson';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  panel.querySelector('#ed-copy')!.addEventListener('click', () => {
    void navigator.clipboard.writeText(JSON.stringify(exportGeoJSON(), null, 2));
  });

  const loadFC = (fc: GeoJSON.FeatureCollection) => {
    const features = fc.features
      .filter((f) => f.geometry.type === 'Polygon')
      .map((f) => {
        const id = crypto.randomUUID();
        meta.set(id, {
          name: String(f.properties?.name ?? 'Untitled'),
          kind: String(f.properties?.kind ?? 'other'),
        });
        return {
          id,
          type: 'Feature' as const,
          properties: { mode: 'polygon' },
          geometry: f.geometry as GeoJSON.Polygon,
        };
      });
    if (features.length) draw.addFeatures(features);
    refreshList();
  };

  const loadPublished = () =>
    fetch('/regions.geojson')
      .then((r) => r.json() as Promise<GeoJSON.FeatureCollection>)
      .then(loadFC);

  panel.querySelector('#ed-reset')!.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    draw.removeFeatures(draw.getSnapshot().map((f) => f.id as string));
    meta.clear();
    void loadPublished();
  });

  // Seed from local work-in-progress if present, else the published file.
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      loadFC(JSON.parse(saved) as GeoJSON.FeatureCollection);
    } catch {
      void loadPublished();
    }
  } else {
    void loadPublished();
  }

  // Console access for debugging.
  Object.assign(window, { draw, __exportRegions: exportGeoJSON });
}
