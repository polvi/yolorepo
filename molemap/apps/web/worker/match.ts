// Pure detection -> mole matching, kept behind a clean function boundary so a
// Rust/wasm implementation can replace it later without touching the routes.

export type Vec3 = [number, number, number];

export interface Detection {
  id: string;
  position: Vec3; // visit-local coordinates
  confidence?: number;
  embedding?: number[];
  cropSha?: string;
}

export interface MoleCandidate {
  id: string;
  canonical: Vec3;
  status: 'confirmed' | 'proposed' | 'dismissed';
}

export interface MatchOutcome {
  attach: { moleId: string; detection: Detection; canonical: Vec3 }[];
  create: { canonical: Vec3; detections: Detection[] }[];
}

// Canonical units, body height = 1: 0.02 is ~3.5cm on an adult.
export const MATCH_RADIUS = 0.02;

/** Apply a column-major 4x4 (THREE.Matrix4.elements order) to a point. */
export function applyAlignment(m: number[], p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * For each detection (deduped by id, so replayed batches are idempotent):
 * transform to canonical space, attach to the nearest non-dismissed existing
 * mole within `radius`, otherwise group into a to-be-created proposed mole.
 * Detections that land near an earlier creation in the same batch join its
 * group rather than spawning a duplicate.
 */
export function matchDetections(
  detections: Detection[],
  moles: MoleCandidate[],
  alignment: number[],
  radius: number = MATCH_RADIUS
): MatchOutcome {
  const candidates = moles.filter((m) => m.status !== 'dismissed');
  const attach: MatchOutcome['attach'] = [];
  const create: MatchOutcome['create'] = [];
  const seen = new Set<string>();

  for (const detection of detections) {
    if (seen.has(detection.id)) continue;
    seen.add(detection.id);
    const canonical = applyAlignment(alignment, detection.position);

    let best: MoleCandidate | null = null;
    let bestDist = Infinity;
    for (const mole of candidates) {
      const d = dist(mole.canonical, canonical);
      if (d < bestDist) {
        best = mole;
        bestDist = d;
      }
    }
    if (best && bestDist <= radius) {
      attach.push({ moleId: best.id, detection, canonical });
      continue;
    }

    const group = create.find((g) => dist(g.canonical, canonical) <= radius);
    if (group) group.detections.push(detection);
    else create.push({ canonical, detections: [detection] });
  }

  return { attach, create };
}

/** 1 - cosine similarity; null when the vectors are unusable. */
export function cosineDistance(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return null;
  return 1 - dot / Math.sqrt(na * nb);
}
