/**
 * CesiumPointCloudLayer
 *
 * Renders point cloud data in a Cesium Viewer using PointPrimitiveCollection.
 * Replaces the deck.gl PointCloudLayer used in maplibre-gl-lidar.
 *
 * Key differences from deck.gl PointCloudLayer:
 *   - Uses Cesium.PointPrimitiveCollection (GPU-batched, single draw call per collection)
 *   - Positions are Cesium.Cartesian3 (ECEF) rather than LNGLAT_OFFSETS
 *   - Points are chunked to CHUNK_SIZE to avoid WebGL buffer limits
 */

import * as Cesium from 'cesium';
import { colorizePoints, percentileRange } from './colorSchemes';
import type { ColorScheme } from './types';

/** Max points per PointPrimitiveCollection to stay within WebGL limits */
const CHUNK_SIZE = 500_000;

export class CesiumPointCloudLayer {
  private viewer: Cesium.Viewer;
  private collections: Cesium.PointPrimitiveCollection[] = [];
  private pointSize: number;
  private colorScheme: ColorScheme;

  constructor(viewer: Cesium.Viewer, options: { pointSize?: number; colorScheme?: ColorScheme } = {}) {
    this.viewer = viewer;
    this.pointSize = options.pointSize ?? 2;
    this.colorScheme = options.colorScheme ?? 'elevation';
  }

  /**
   * Replace all displayed points with new data.
   * Called after loading new nodes (full rebuild for simplicity).
   */
  updatePoints(data: {
    positions: Float64Array;       // [lng0,lat0,alt0, lng1,lat1,alt1, ...]
    intensities: Float32Array;
    classifications: Uint8Array;
    reds: Uint8Array;
    greens: Uint8Array;
    blues: Uint8Array;
    count: number;
  }): void {
    const { positions, intensities, classifications, reds, greens, blues, count } = data;
    if (count === 0) return;

    // Extract Z values for elevation colorization
    const elevations = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      elevations[i] = positions[i * 3 + 2];
    }
    const [elevMin, elevMax] = percentileRange(elevations, 2, 98);

    // Compute colors
    const colors = colorizePoints({
      scheme: this.colorScheme,
      elevations,
      intensities,
      classifications,
      reds,
      greens,
      blues,
      count,
      elevMin,
      elevMax,
    });

    // Remove old collections
    this._clearCollections();

    // Build new collections in chunks
    let offset = 0;
    while (offset < count) {
      const chunkCount = Math.min(CHUNK_SIZE, count - offset);
      const collection = new Cesium.PointPrimitiveCollection();

      for (let i = 0; i < chunkCount; i++) {
        const pi = offset + i;
        const lng = positions[pi * 3    ];
        const lat = positions[pi * 3 + 1];
        const alt = positions[pi * 3 + 2];
        const ci = pi * 4;

        collection.add({
          position: Cesium.Cartesian3.fromDegrees(lng, lat, alt),
          color: new Cesium.Color(
            colors[ci    ] / 255,
            colors[ci + 1] / 255,
            colors[ci + 2] / 255,
            colors[ci + 3] / 255,
          ),
          pixelSize: this.pointSize,
        });
      }

      this.viewer.scene.primitives.add(collection);
      this.collections.push(collection);
      offset += chunkCount;
    }
  }

  setColorScheme(scheme: ColorScheme): void {
    this.colorScheme = scheme;
  }

  setPointSize(size: number): void {
    this.pointSize = size;
    for (const coll of this.collections) {
      for (let i = 0; i < coll.length; i++) {
        coll.get(i).pixelSize = size;
      }
    }
  }

  setVisible(visible: boolean): void {
    for (const coll of this.collections) {
      coll.show = visible;
    }
  }

  get pointCount(): number {
    return this.collections.reduce((sum, c) => sum + c.length, 0);
  }

  destroy(): void {
    this._clearCollections();
  }

  private _clearCollections(): void {
    for (const coll of this.collections) {
      if (!coll.isDestroyed()) {
        this.viewer.scene.primitives.remove(coll);
        coll.destroy();
      }
    }
    this.collections = [];
  }
}
