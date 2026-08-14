import maplibregl from 'maplibre-gl';
import { cogProtocol } from '@geomatico/maplibre-cog-protocol';
import 'maplibre-gl/dist/maplibre-gl.css';
import { addRegionLayers } from './regions';

maplibregl.addProtocol('cog', cogProtocol);

// WGS84 extent of the orthophoto (from gdalinfo on the published COG).
const ORTHO_BOUNDS: [number, number, number, number] = [
  -121.3098335, 44.1737092, -121.3024521, 44.1793725,
];

const COG_URL = `cog://${location.origin}/cog/swalley-road-2026-08-13.tif`;

const editMode = new URLSearchParams(location.search).has('edit');

const map = new maplibregl.Map({
  container: 'map',
  style: {
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
        url: COG_URL,
        tileSize: 256,
      },
    },
    layers: [
      { id: 'osm', type: 'raster', source: 'osm' },
      { id: 'ortho', type: 'raster', source: 'ortho' },
    ],
  },
  bounds: ORTHO_BOUNDS,
  fitBoundsOptions: { padding: 24 },
  maxZoom: 22,
  attributionControl: { compact: true },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
  }),
  'top-right'
);
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

map.on('load', () => {
  if (editMode) {
    // Terra Draw renders its own editable copies of the regions; the static
    // display layers would just double up underneath them.
    void import('./edit').then((m) => m.setupEditor(map));
  } else {
    addRegionLayers(map);
    addVeggiePins(map);
  }
});

// Live pins from the veggie-tagging game (see VEGGIE-GAME.md). Invisible
// until someone plays; polls so the map fills in while the kids run around.
function addVeggiePins(m: maplibregl.Map): void {
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
    minzoom: 16.5,
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
  setInterval(() => {
    void fetch(url)
      .then((r) => r.json())
      .then((d) => (m.getSource('veggies') as maplibregl.GeoJSONSource).setData(d as GeoJSON.GeoJSON));
  }, 20000);
}

map.on('error', (e) => console.error('[map]', e.error?.message ?? e));

// Handy for console debugging; harmless in production.
Object.assign(window, { map, cogProtocol });
