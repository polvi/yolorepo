import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Scene3D {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  onFrame(cb: (time: number) => void): void;
  dispose(): void;
}

/**
 * Basic three.js scene wrapper: renderer, orbit controls, resize handling,
 * render loop. Returns null when WebGL2 is unavailable (Spark needs it) so
 * the page can show a friendly message instead.
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

  // Canonical body frame: height = 1, centered on the y axis.
  const camera = new THREE.PerspectiveCamera(50, 1, 0.005, 50);
  camera.position.set(0, 0.55, 1.7);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.5, 0);
  controls.enableDamping = true;
  controls.minDistance = 0.05;
  controls.maxDistance = 6;

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

  const frameCbs: ((time: number) => void)[] = [];
  renderer.setAnimationLoop((time) => {
    controls.update();
    for (const cb of frameCbs) cb(time);
    renderer.render(scene, camera);
  });

  return {
    scene,
    camera,
    renderer,
    controls,
    onFrame: (cb) => frameCbs.push(cb),
    dispose: () => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
