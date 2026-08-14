import type maplibregl from 'maplibre-gl';

// Region kinds and their display colors. Data stays semantic (regions.geojson
// stores `kind`); the palette lives here so restyling never touches the data.
// Everything on the farm is u-pick except the farmstand, so there is no
// separate u-pick kind.
export const KINDS: Record<string, { label: string; color: string }> = {
  maze: { label: 'Maze', color: '#9b59b6' },
  corn: { label: 'Corn', color: '#e0b64f' },
  flowers: { label: 'Flowers', color: '#e26fa8' },
  veggies: { label: 'Veggies', color: '#4caf6d' },
  orchard: { label: 'Orchard', color: '#2e9e8f' },
  farmstand: { label: 'Farmstand', color: '#8d99ae' },
  water: { label: 'Water', color: '#4a90d9' },
  other: { label: 'Other', color: '#cccccc' },
};

const kindColor = [
  'match',
  ['get', 'kind'],
  ...Object.entries(KINDS).flatMap(([kind, { color }]) => [kind, color]),
  '#cccccc',
] as unknown as maplibregl.ExpressionSpecification;

// Zoomed out: colored patchwork + names. Zoomed in: everything fades so the
// imagery stands alone.
export function addRegionLayers(map: maplibregl.Map): void {
  map.addLayer({
    id: 'region-fills',
    type: 'fill',
    source: 'regions',
    paint: {
      'fill-color': kindColor,
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 16.5, 0.28, 17.8, 0],
    },
  });
  map.addLayer({
    id: 'region-outlines',
    type: 'line',
    source: 'regions',
    paint: {
      'line-color': kindColor,
      'line-width': 1.5,
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 17, 0.9, 18.2, 0],
    },
  });
  map.addLayer({
    id: 'region-labels',
    type: 'symbol',
    source: 'regions',
    minzoom: 13.5,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 12, 17, 16],
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(0, 0, 0, 0.6)',
      'text-halo-width': 1.4,
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 17.5, 1, 18.2, 0],
    },
  });
}
