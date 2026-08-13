import maplibregl from 'maplibre-gl';
import { cogProtocol } from '@geomatico/maplibre-cog-protocol';
import 'maplibre-gl/dist/maplibre-gl.css';

maplibregl.addProtocol('cog', cogProtocol);

// WGS84 extent of the orthophoto (from gdalinfo on the published COG).
const ORTHO_BOUNDS: [number, number, number, number] = [
  -121.3098335, 44.1737092, -121.3024521, 44.1793725,
];

const COG_URL = `cog://${location.origin}/cog/swalley-road-2026-08-13.tif`;

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
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

map.on('error', (e) => console.error('[map]', e.error?.message ?? e));

// Handy for console debugging; harmless in production.
Object.assign(window, { map, cogProtocol });
