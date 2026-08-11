import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const sparkAttached = new WeakSet<THREE.Scene>();

/** Spark wants exactly one SparkRenderer in the scene graph. */
export function ensureSpark(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
  if (sparkAttached.has(scene)) return;
  scene.add(new SparkRenderer({ renderer }));
  sparkAttached.add(scene);
}

/**
 * Load a Gaussian splat through Spark. We fetch the bytes ourselves —
 * /api/artifacts URLs are same-origin so the session cookie attaches, and
 * they carry no file extension, so Spark's URL-based type detection would
 * fail. fileName (the artifact label, e.g. body.sog) guides format
 * detection alongside magic-byte sniffing.
 */
export async function loadSplatMesh(url: string, fileName?: string): Promise<SplatMesh> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`splat fetch failed: ${res.status}`);
  const fileBytes = new Uint8Array(await res.arrayBuffer());
  const mesh = new SplatMesh({ fileBytes, fileName });
  await mesh.initialized;
  return mesh;
}

/**
 * Per-visit container. Its matrix IS the visit's alignment (visit-local ->
 * canonical), so children raycast/render in canonical space and a world hit
 * point is already a canonical position.
 */
export function visitGroup(alignment: number[]): THREE.Group {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.matrix.fromArray(alignment);
  group.matrixWorldNeedsUpdate = true;
  return group;
}
