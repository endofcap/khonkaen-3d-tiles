import type { ColorScheme } from './types';

/** Standard LAS classification colors [R, G, B] */
const CLASSIFICATION_COLORS: Record<number, [number, number, number]> = {
  0:  [150, 150, 150], // Never classified / Unclassified
  1:  [180, 180, 180], // Unclassified
  2:  [139,  90,  43], // Ground
  3:  [144, 238, 144], // Low Vegetation
  4:  [ 34, 139,  34], // Medium Vegetation
  5:  [  0, 100,   0], // High Vegetation
  6:  [255,  69,   0], // Building
  7:  [255, 182, 193], // Low Point (Noise)
  9:  [ 30, 144, 255], // Water
  10: [255, 255, 255], // Rail
  11: [169, 169, 169], // Road Surface
  13: [255, 215,   0], // Wire – Guard
  14: [255, 165,   0], // Wire – Conductor
  15: [220, 220, 220], // Transmission Tower
  17: [210, 180, 140], // Bridge Deck
  18: [255,   0, 255], // High Noise
};

const DEFAULT_CLASS_COLOR: [number, number, number] = [200, 200, 200];

/** Elevation gradient: blue → cyan → green → yellow → red */
function elevationColor(t: number): [number, number, number] {
  // t is 0..1
  const stops: Array<[number, [number, number, number]]> = [
    [0.0,  [  0,   0, 255]], // blue
    [0.25, [  0, 200, 200]], // cyan
    [0.5,  [  0, 255,   0]], // green
    [0.75, [255, 255,   0]], // yellow
    [1.0,  [255,   0,   0]], // red
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + f * (c1[0] - c0[0])),
        Math.round(c0[1] + f * (c1[1] - c0[1])),
        Math.round(c0[2] + f * (c1[2] - c0[2])),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

export interface ColorizeOptions {
  scheme: ColorScheme;
  elevations: Float64Array;   // Z values in meters (WGS84 alt)
  intensities: Float32Array;
  classifications: Uint8Array;
  reds: Uint8Array;
  greens: Uint8Array;
  blues: Uint8Array;
  count: number;
  elevMin: number;
  elevMax: number;
}

/**
 * Compute RGBA colors for a batch of points.
 * Returns a Uint8Array of length count * 4 (RGBA).
 */
export function colorizePoints(opts: ColorizeOptions): Uint8Array {
  const { scheme, elevations, intensities, classifications,
          reds, greens, blues, count, elevMin, elevMax } = opts;
  const colors = new Uint8Array(count * 4);
  const elevRange = elevMax - elevMin || 1;

  for (let i = 0; i < count; i++) {
    const base = i * 4;
    let r = 150, g = 150, b = 150;

    switch (scheme) {
      case 'elevation': {
        const t = Math.max(0, Math.min(1, (elevations[i] - elevMin) / elevRange));
        [r, g, b] = elevationColor(t);
        break;
      }
      case 'intensity': {
        const v = Math.round(Math.max(0, Math.min(255, intensities[i] / 255)));
        r = g = b = v;
        break;
      }
      case 'classification': {
        const cls = classifications[i] ?? 0;
        [r, g, b] = CLASSIFICATION_COLORS[cls] ?? DEFAULT_CLASS_COLOR;
        break;
      }
      case 'rgb': {
        r = reds[i]   ?? 150;
        g = greens[i] ?? 150;
        b = blues[i]  ?? 150;
        break;
      }
    }

    colors[base    ] = r;
    colors[base + 1] = g;
    colors[base + 2] = b;
    colors[base + 3] = 255; // fully opaque
  }

  return colors;
}

/** Compute 2–98 percentile range of an array for robust colorization */
export function percentileRange(arr: Float64Array | Float32Array, p2 = 2, p98 = 98): [number, number] {
  if (arr.length === 0) return [0, 1];
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * p2 / 100)];
  const hi = sorted[Math.floor(sorted.length * p98 / 100)];
  return [lo, hi === lo ? lo + 1 : hi];
}
