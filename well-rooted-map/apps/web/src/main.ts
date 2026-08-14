import maplibregl from 'maplibre-gl';
import { cogProtocol } from '@geomatico/maplibre-cog-protocol';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ORTHO_BOUNDS, addVeggiePins, farmStyle } from './farmmap';
import { addRegionLayers } from './regions';

const editMode = new URLSearchParams(location.search).has('edit');

const map = new maplibregl.Map({
  container: 'map',
  style: farmStyle(),
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

map.on('error', (e) => console.error('[map]', e.error?.message ?? e));

// Handy for console debugging; harmless in production.
Object.assign(window, { map, cogProtocol });
