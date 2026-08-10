// The homepage IS the product explainer: friends as glowing nodes, a growing
// tangle of trip expenses between them, which periodically collapses into the
// few Monero-orange transfers tabby actually asks anyone to make. Loaded via
// dynamic import so app screens never pay for three.js.
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  QuadraticBezierCurve3,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';

const FRIENDS = 5;
const RADIUS = 2.2;
const EXPENSE_COLORS = ['#6fbf73', '#5fa8d3', '#f2c14e']; // USD / CAD / TAB
const SETTLE_COLOR = '#f26822';
const CYCLE_SECONDS = 9;

interface Edge {
  line: Line<BufferGeometry, LineBasicMaterial>;
  bornAt: number; // cycle-relative seconds
}

export function startHomeScene(canvas: HTMLCanvasElement): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = new Scene();
  scene.background = new Color('#171210');
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 1.4, 6.4);
  camera.lookAt(0, 0, 0);

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const nodePositions: Vector3[] = [];
  for (let i = 0; i < FRIENDS; i++) {
    const a = (i / FRIENDS) * Math.PI * 2;
    nodePositions.push(new Vector3(Math.cos(a) * RADIUS, Math.sin(a) * RADIUS * 0.55, 0));
  }

  const world = new Group();
  scene.add(world);

  const nodeGeo = new SphereGeometry(0.13, 24, 24);
  const haloGeo = new SphereGeometry(0.24, 24, 24);
  for (const p of nodePositions) {
    const node = new Mesh(nodeGeo, new MeshBasicMaterial({ color: '#f3ece5' }));
    node.position.copy(p);
    const halo = new Mesh(
      haloGeo,
      new MeshBasicMaterial({
        color: SETTLE_COLOR,
        transparent: true,
        opacity: 0.18,
        blending: AdditiveBlending,
      })
    );
    halo.position.copy(p);
    world.add(node, halo);
  }

  function arcBetween(a: Vector3, b: Vector3, lift: number, color: string, opacity: number) {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.z += lift;
    const curve = new QuadraticBezierCurve3(a, mid, b);
    const geo = new BufferGeometry().setFromPoints(curve.getPoints(40));
    const mat = new LineBasicMaterial({ color, transparent: true, opacity });
    return new Line(geo, mat);
  }

  // A deterministic tangle: every pair gets an expense arc, colored by
  // currency, appearing one by one through the first half of each cycle.
  const tangleSpecs: { from: number; to: number; color: string; lift: number }[] = [];
  let k = 0;
  for (let i = 0; i < FRIENDS; i++) {
    for (let j = i + 1; j < FRIENDS; j++) {
      tangleSpecs.push({
        from: i,
        to: j,
        color: EXPENSE_COLORS[k % EXPENSE_COLORS.length]!,
        lift: 0.4 + (k % 4) * 0.35,
      });
      k++;
    }
  }

  // The settlement: a spanning set of ≤ n−1 orange transfers.
  const settleSpecs = [
    { from: 3, to: 0 },
    { from: 4, to: 0 },
    { from: 2, to: 1 },
    { from: 0, to: 1 },
  ];

  const tangle = new Group();
  const settlement = new Group();
  world.add(tangle, settlement);

  const tangleEdges: Edge[] = tangleSpecs.map((s, i) => {
    const line = arcBetween(
      nodePositions[s.from]!,
      nodePositions[s.to]!,
      s.lift,
      s.color,
      0
    );
    tangle.add(line);
    return { line, bornAt: 0.4 + (i / tangleSpecs.length) * (CYCLE_SECONDS * 0.45) };
  });

  const settleEdges = settleSpecs.map((s) => {
    const line = arcBetween(nodePositions[s.from]!, nodePositions[s.to]!, 0.9, SETTLE_COLOR, 0);
    line.material.linewidth = 2;
    settlement.add(line);
    return line;
  });

  function resize() {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  addEventListener('resize', resize);
  visualViewport?.addEventListener('resize', resize);

  const start = performance.now();
  let raf = 0;

  function frame(now: number) {
    const elapsed = (now - start) / 1000;
    const t = elapsed % CYCLE_SECONDS;

    // First half: expenses pile up. Second half: the tangle dissolves and the
    // minimal transfer set takes over, then everything pulses settled.
    const collapseAt = CYCLE_SECONDS * 0.55;
    for (const e of tangleEdges) {
      const grown = t > e.bornAt ? Math.min(1, (t - e.bornAt) * 3) : 0;
      const dissolve = t > collapseAt ? Math.max(0, 1 - (t - collapseAt) * 1.6) : 1;
      e.line.material.opacity = 0.45 * grown * dissolve;
    }
    settleEdges.forEach((line, i) => {
      const appearAt = collapseAt + 0.5 + i * 0.35;
      const grown = t > appearAt ? Math.min(1, (t - appearAt) * 2.5) : 0;
      const pulse = 0.75 + 0.25 * Math.sin(elapsed * 5 + i);
      line.material.opacity = grown * pulse;
    });

    world.rotation.y = Math.sin(elapsed * 0.12) * 0.35;
    world.rotation.x = Math.sin(elapsed * 0.09) * 0.1;

    renderer.render(scene, camera);
    if (!reduced) raf = requestAnimationFrame(frame);
  }

  if (reduced) {
    // Static frame mid-settlement: tangle gone, orange transfers visible.
    for (const e of tangleEdges) e.line.material.opacity = 0.12;
    for (const line of settleEdges) line.material.opacity = 1;
    renderer.render(scene, camera);
    return;
  }

  raf = requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else raf = requestAnimationFrame(frame);
  });
}
