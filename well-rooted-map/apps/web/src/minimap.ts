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
map.on('load', () => {
  addVeggiePins(map, 10000, 0);
  // Widen the view to include every pin, so test tags placed away from the
  // farm (someone trying the game from home) are still visible.
  void fetch(`${location.origin}/api/veggie/points.geojson`)
    .then((r) => r.json() as Promise<GeoJSON.FeatureCollection>)
    .then((fc) => {
      if (!fc.features.length) return;
      const bounds = new maplibregl.LngLatBounds(
        [ORTHO_BOUNDS[0], ORTHO_BOUNDS[1]],
        [ORTHO_BOUNDS[2], ORTHO_BOUNDS[3]]
      );
      for (const f of fc.features) {
        const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
        if (typeof lon === 'number' && typeof lat === 'number') bounds.extend([lon, lat]);
      }
      map.fitBounds(bounds, { padding: 40, animate: false });
    });
});
