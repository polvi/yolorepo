import * as THREE from 'three';

export interface PinData {
  moleId: string;
  canonical: [number, number, number];
  status: 'confirmed' | 'proposed' | 'dismissed';
  label: string;
}

function circleTexture(draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(size / 2, size / 2);
  draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const solidTexture = () =>
  circleTexture((ctx) => {
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#35b8a5';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#06211d';
    ctx.stroke();
  });

// Proposed pins are hollow; the page pulses their scale each frame.
const hollowTexture = () =>
  circleTexture((ctx) => {
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#e0a13f';
    ctx.stroke();
  });

/**
 * Mole pins as sprites in canonical space (added to the scene root, not a
 * visit group). Selection ring + pulsing proposed pins are driven from the
 * page's frame callback via pulse().
 */
export class Pins {
  group = new THREE.Group();
  private sprites = new Map<string, THREE.Sprite>();
  private solid = solidTexture();
  private hollow = hollowTexture();
  private selectedId: string | null = null;

  set(pins: PinData[]): void {
    for (const sprite of this.sprites.values()) {
      this.group.remove(sprite);
      sprite.material.dispose();
    }
    this.sprites.clear();
    for (const pin of pins) {
      if (pin.status === 'dismissed') continue;
      const material = new THREE.SpriteMaterial({
        map: pin.status === 'proposed' ? this.hollow : this.solid,
        depthTest: false,
        sizeAttenuation: true,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(...pin.canonical);
      sprite.scale.setScalar(0.018);
      sprite.renderOrder = 10;
      sprite.userData = { moleId: pin.moleId, status: pin.status };
      this.group.add(sprite);
      this.sprites.set(pin.moleId, sprite);
    }
    this.setSelected(this.selectedId);
  }

  setSelected(moleId: string | null): void {
    this.selectedId = moleId;
    for (const [id, sprite] of this.sprites) {
      sprite.material.color.set(id === moleId ? 0xffffff : 0xdddddd);
    }
  }

  pulse(time: number): void {
    const s = 0.018 * (1 + 0.25 * Math.sin(time / 250));
    for (const sprite of this.sprites.values()) {
      if (sprite.userData.status === 'proposed') sprite.scale.setScalar(s);
    }
  }

  /** Which pin (if any) the ray hits. */
  pick(raycaster: THREE.Raycaster): string | null {
    const hits = raycaster.intersectObjects([...this.sprites.values()], false);
    return (hits[0]?.object.userData.moleId as string | undefined) ?? null;
  }
}

/**
 * Pick a surface point for pin placement. Works against whatever the visit
 * group holds — Spark SplatMesh implements raycast(); the sparse point cloud
 * is the fallback (screen-space nearest point within a threshold). The hit
 * is returned in world space, which IS canonical space because the visit
 * group's matrix applies the alignment.
 */
export function pickPoint(
  raycaster: THREE.Raycaster,
  targets: THREE.Object3D[]
): [number, number, number] | null {
  raycaster.params.Points = { threshold: 0.008 };
  const hits = raycaster.intersectObjects(targets, true);
  const hit = hits[0];
  if (!hit) return null;
  return [hit.point.x, hit.point.y, hit.point.z];
}
