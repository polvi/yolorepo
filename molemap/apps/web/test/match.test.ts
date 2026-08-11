import { describe, expect, it } from 'vitest';
import {
  applyAlignment,
  cosineDistance,
  matchDetections,
  type Detection,
  type MoleCandidate,
} from '../worker/match';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function det(id: string, position: [number, number, number]): Detection {
  return { id, position, confidence: 0.9 };
}

function mole(id: string, canonical: [number, number, number], status: MoleCandidate['status'] = 'confirmed'): MoleCandidate {
  return { id, canonical, status };
}

describe('matchDetections', () => {
  it('attaches a detection within the radius to the existing mole', () => {
    const out = matchDetections([det('d1', [0.1, 0.5, 0.01])], [mole('m1', [0.1, 0.51, 0.01])], IDENTITY, 0.02);
    expect(out.attach).toHaveLength(1);
    expect(out.attach[0]!.moleId).toBe('m1');
    expect(out.create).toHaveLength(0);
  });

  it('creates a proposed mole outside the radius', () => {
    const out = matchDetections([det('d1', [0.5, 0.5, 0])], [mole('m1', [0.1, 0.1, 0])], IDENTITY, 0.02);
    expect(out.attach).toHaveLength(0);
    expect(out.create).toHaveLength(1);
    expect(out.create[0]!.canonical).toEqual([0.5, 0.5, 0]);
  });

  it('never matches dismissed moles', () => {
    const out = matchDetections(
      [det('d1', [0.1, 0.5, 0])],
      [mole('m1', [0.1, 0.5, 0], 'dismissed')],
      IDENTITY,
      0.02
    );
    expect(out.attach).toHaveLength(0);
    expect(out.create).toHaveLength(1);
  });

  it('applies the alignment transform before matching', () => {
    // Pure translation by +0.2 in x (column-major 4x4).
    const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.2, 0, 0, 1];
    expect(applyAlignment(translate, [0.1, 0.5, 0])).toEqual([
      0.30000000000000004, 0.5, 0,
    ]);
    const out = matchDetections(
      [det('d1', [0.1, 0.5, 0])],
      [mole('m1', [0.3, 0.5, 0])],
      translate,
      0.02
    );
    expect(out.attach).toHaveLength(1);
    expect(out.attach[0]!.moleId).toBe('m1');
  });

  it('is idempotent: the same detection id twice acts once', () => {
    const out = matchDetections(
      [det('d1', [0.5, 0.5, 0]), det('d1', [0.5, 0.5, 0])],
      [],
      IDENTITY,
      0.02
    );
    expect(out.create).toHaveLength(1);
    expect(out.create[0]!.detections).toHaveLength(1);
  });

  it('merges nearby detections in one batch into a single new mole', () => {
    const out = matchDetections(
      [det('d1', [0.5, 0.5, 0]), det('d2', [0.505, 0.5, 0])],
      [],
      IDENTITY,
      0.02
    );
    expect(out.create).toHaveLength(1);
    expect(out.create[0]!.detections).toHaveLength(2);
  });
});

describe('cosineDistance', () => {
  it('is 0 for identical directions and 2 for opposite', () => {
    expect(cosineDistance([1, 0], [2, 0])).toBeCloseTo(0);
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2);
  });

  it('rejects unusable vectors', () => {
    expect(cosineDistance([], [])).toBeNull();
    expect(cosineDistance([1, 2], [1])).toBeNull();
    expect(cosineDistance([0, 0], [1, 1])).toBeNull();
  });
});
