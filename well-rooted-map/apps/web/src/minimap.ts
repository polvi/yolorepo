import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ORTHO_BOUNDS, addVeggiePins, farmStyle } from './farmmap';

// Leaderboard mini-map: the farm with live veggie pins, so a glance
// confirms tags are landing where the kids actually are. Names shown at
// every zoom (the whole point is confirmation), 10s poll to match the
// leaderboard refresh.
const map = new maplibregl.Map({
  container: 'minimap',
  style: farmStyle(),
  bounds: ORTHO_BOUNDS,
  fitBoundsOptions: { padding: 12 },
  maxZoom: 22,
  attributionControl: false,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.on('load', () => addVeggiePins(map, 10000, 0));
