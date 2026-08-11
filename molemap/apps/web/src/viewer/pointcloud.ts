import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

/**
 * Sparse point cloud fallback + raycast target. Same-origin fetch so the
 * session cookie attaches.
 */
export async function loadPointCloud(url: string): Promise<THREE.Points> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`point cloud fetch failed: ${res.status}`);
  const geometry = new PLYLoader().parse(await res.arrayBuffer());
  const material = new THREE.PointsMaterial({
    size: 0.004,
    vertexColors: geometry.hasAttribute('color'),
    color: geometry.hasAttribute('color') ? 0xffffff : 0x8fa1ad,
  });
  return new THREE.Points(geometry, material);
}
