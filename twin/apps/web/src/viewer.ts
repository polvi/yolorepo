import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

export interface Scene3D {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  dispose(): void;
}

/**
 * Fullscreen three.js scene tuned for outdoor property scale (meters).
 * Returns null when WebGL2 is unavailable (Spark needs it) so the page can
 * show a friendly message instead.
 */
export function createScene(container: HTMLElement): Scene3D | null {
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2')) return null;

  // Spark docs: antialias off — MSAA doesn't help splats and costs a lot.
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c1116);
  scene.add(new SparkRenderer({ renderer }));

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
  camera.position.set(10, 6, 10);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.minDistance = 0.5;
  controls.maxDistance = 400;

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    scene,
    camera,
    renderer,
    controls,
    dispose: () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/**
 * Fetch the splat bytes with download progress, then hand them to Spark.
 * /api/.../artifact carries no file extension, so Spark's URL-based type
 * detection would fail; fileName (from scene meta, e.g. scene.sog) guides
 * format detection alongside magic-byte sniffing.
 */
export async function loadSplatMesh(
  url: string,
  fileName: string | undefined,
  onProgress: (loaded: number, total: number) => void
): Promise<SplatMesh> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`splat fetch failed: ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const fileBytes = new Uint8Array(loaded);
  let off = 0;
  for (const chunk of chunks) {
    fileBytes.set(chunk, off);
    off += chunk.byteLength;
  }

  const mesh = new SplatMesh({ fileBytes, fileName });
  await mesh.initialized;
  return mesh;
}

/**
 * Frame the camera on the splat's bounding sphere so any scene scale (COLMAP
 * units are arbitrary) starts fully in view.
 */
export function frameObject(view: Scene3D, object: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = sphere.radius * 1.8;
  view.controls.target.copy(sphere.center);
  view.camera.position
    .copy(sphere.center)
    .add(new THREE.Vector3(dist * 0.7, dist * 0.5, dist * 0.7));
  view.controls.minDistance = sphere.radius / 100;
  view.controls.maxDistance = sphere.radius * 10;
  view.camera.near = sphere.radius / 1000;
  view.camera.far = sphere.radius * 100;
  view.camera.updateProjectionMatrix();
  view.controls.update();
}
