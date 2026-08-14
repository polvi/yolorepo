import maplibregl from 'maplibre-gl';
import { cogProtocol } from '@geomatico/maplibre-cog-protocol';

maplibregl.addProtocol('cog', cogProtocol);

// WGS84 extent of the orthophoto (from gdalinfo on the published COG).
export const ORTHO_BOUNDS: [number, number, number, number] = [
  -121.3098335, 44.1737092, -121.3024521, 44.1793725,
];

// Base style shared by the main map and the leaderboard mini-map: OSM
// underneath, the COG orthophoto on top, regions source ready for layers.
export function farmStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: `${location.origin}/font/{fontstack}/{range}.pbf`,
    sources: {
      regions: {
        type: 'geojson',
        data: `${location.origin}/regions.geojson`,
      },
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
      ortho: {
        type: 'raster',
        url: `cog://${location.origin}/cog/swalley-road-2026-08-13.tif`,
        tileSize: 256,
      },
    },
    layers: [
      { id: 'osm', type: 'raster', source: 'osm' },
      { id: 'ortho', type: 'raster', source: 'ortho' },
    ],
  };
}

// Live pins from the veggie-tagging game (see VEGGIE-GAME.md). Invisible
// until someone plays; polls so the map fills in while the kids run around.
// Tapping a pin pops up who found what.
export function addVeggiePins(m: maplibregl.Map, pollMs = 20000, namesMinzoom = 16.5): void {
  const url = `${location.origin}/api/veggie/points.geojson`;
  m.addSource('veggies', { type: 'geojson', data: url });
  m.addLayer({
    id: 'veggie-dots',
    type: 'circle',
    source: 'veggies',
    paint: {
      'circle-radius': ['+', 5, ['min', ['get', 'confirmations'], 4]],
      'circle-color': '#ffd166',
      'circle-stroke-color': '#1b3022',
      'circle-stroke-width': 2,
    },
  });
  m.addLayer({
    id: 'veggie-names',
    type: 'symbol',
    source: 'veggies',
    minzoom: namesMinzoom,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': '#ffd166',
      'text-halo-color': 'rgba(0, 0, 0, 0.7)',
      'text-halo-width': 1.4,
    },
  });

  m.on('click', 'veggie-dots', (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const p = f.properties as { name: string; finder: string; confirmations: number };
    new maplibregl.Popup({ closeButton: false })
      .setLngLat(e.lngLat)
      .setText(`${p.name} — found by ${p.finder} (${p.confirmations} confirms)`)
      .addTo(m);
  });
  m.on('mouseenter', 'veggie-dots', () => (m.getCanvas().style.cursor = 'pointer'));
  m.on('mouseleave', 'veggie-dots', () => (m.getCanvas().style.cursor = ''));

  setInterval(() => {
    void fetch(url)
      .then((r) => r.json())
      .then((d) => (m.getSource('veggies') as maplibregl.GeoJSONSource).setData(d as GeoJSON.GeoJSON));
  }, pollMs);
}
