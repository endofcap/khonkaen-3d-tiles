/**
 * ViewportManager
 *
 * Extracts viewport bounds and target LOD depth from a Cesium camera.
 * Replaces the MapLibre-based ViewportManager from maplibre-gl-lidar.
 */

import * as Cesium from 'cesium';
import type { ViewportBounds } from './types';

export class ViewportManager {
  private viewer: Cesium.Viewer;
  private _handler: (() => void) | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _debounceMs: number;

  constructor(viewer: Cesium.Viewer, debounceMs = 150) {
    this.viewer = viewer;
    this._debounceMs = debounceMs;
  }

  /**
   * Register a callback that fires (debounced) when the camera moves.
   * Returns a cleanup function.
   */
  onViewportChange(callback: () => void): () => void {
    const debounced = () => {
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(callback, this._debounceMs);
    };

    const removeEnd   = this.viewer.camera.moveEnd.addEventListener(debounced);
    const removeStart = this.viewer.camera.changed.addEventListener(debounced);

    return () => {
      removeEnd();
      removeStart();
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
    };
  }

  /**
   * Compute the current viewport bounding box in WGS84 degrees.
   * Returns null if the camera is pointed away from the globe.
   */
  getViewportBounds(): ViewportBounds | null {
    const rect = this.viewer.camera.computeViewRectangle(
      this.viewer.scene.globe.ellipsoid
    );

    if (!rect) return null;

    const minLng = Cesium.Math.toDegrees(rect.west);
    const minLat = Cesium.Math.toDegrees(rect.south);
    const maxLng = Cesium.Math.toDegrees(rect.east);
    const maxLat = Cesium.Math.toDegrees(rect.north);

    // Sanity check
    if (!isFinite(minLng) || !isFinite(minLat) || !isFinite(maxLng) || !isFinite(maxLat)) {
      return null;
    }

    return { minLng, minLat, maxLng, maxLat };
  }

  /**
   * Compute a target LOD depth based on camera altitude.
   *
   * Depth heuristic (approximate, tunable):
   *   altitude > 100 km  → depth 0–1 (coarse overview)
   *   altitude   1–10 km → depth 4–6
   *   altitude < 100 m   → depth 8–10 (full detail)
   */
  getTargetDepth(): number {
    const altMeters = this.viewer.camera.positionCartographic.height;

    if (altMeters > 100_000) return 1;
    if (altMeters > 50_000)  return 2;
    if (altMeters > 20_000)  return 3;
    if (altMeters > 10_000)  return 4;
    if (altMeters > 5_000)   return 5;
    if (altMeters > 2_000)   return 6;
    if (altMeters > 1_000)   return 7;
    if (altMeters > 500)     return 8;
    if (altMeters > 200)     return 9;
    return 10;
  }
}
