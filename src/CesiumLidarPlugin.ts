/**
 * CesiumLidarPlugin
 *
 * Main plugin class that wires together:
 *   - CopcStreamingLoader  (reads COPC octree, streams point data)
 *   - ViewportManager      (extracts Cesium camera bounds + LOD depth)
 *   - CesiumPointCloudLayer (renders points via PointPrimitiveCollection)
 *
 * Usage:
 *   const plugin = new CesiumLidarPlugin(viewer, {
 *     url: 'https://example.com/data.copc.laz',
 *     colorScheme: 'elevation',
 *     pointSize: 2,
 *   });
 *   await plugin.initialize();
 */

import * as Cesium from 'cesium';
import { CopcStreamingLoader } from './CopcStreamingLoader';
import { CesiumPointCloudLayer } from './CesiumPointCloudLayer';
import { ViewportManager } from './ViewportManager';
import type { ColorScheme, LidarPluginOptions } from './types';

export class CesiumLidarPlugin {
  private viewer: Cesium.Viewer;
  private options: Required<Omit<LidarPluginOptions, 'ionAccessToken' | 'onProgress' | 'onError'>>
    & Pick<LidarPluginOptions, 'ionAccessToken' | 'onProgress' | 'onError'>;

  private loader: CopcStreamingLoader | null = null;
  private layer: CesiumPointCloudLayer | null = null;
  private viewportManager: ViewportManager | null = null;
  private _cleanupViewport: (() => void) | null = null;

  private _rebuildPending = false;
  private _latestData: {
    allPositions: Float64Array;
    allIntensities: Float32Array;
    allClassifications: Uint8Array;
    allReds: Uint8Array;
    allGreens: Uint8Array;
    allBlues: Uint8Array;
    totalCount: number;
  } | null = null;

  constructor(viewer: Cesium.Viewer, options: LidarPluginOptions) {
    this.viewer = viewer;
    this.options = {
      url:                   options.url,
      pointBudget:           options.pointBudget          ?? 2_000_000,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 4,
      colorScheme:           options.colorScheme          ?? 'elevation',
      pointSize:             options.pointSize             ?? 2,
      ionAccessToken:        options.ionAccessToken,
      onProgress:            options.onProgress,
      onError:               options.onError,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    this.loader = new CopcStreamingLoader(this.options.url, {
      pointBudget:           this.options.pointBudget,
      maxConcurrentRequests: this.options.maxConcurrentRequests,
    });

    this.layer = new CesiumPointCloudLayer(this.viewer, {
      pointSize:   this.options.pointSize,
      colorScheme: this.options.colorScheme,
    });

    this.viewportManager = new ViewportManager(this.viewer);

    // Wire up streaming callbacks
    this.loader.onUpdate = (data) => {
      this._latestData = data;
      this._scheduleRebuild();
    };

    this.loader.onProgress = (stats) => {
      this.options.onProgress?.(stats.loadedPoints, stats.totalPoints);
    };

    this.loader.onError = (err) => {
      this.options.onError?.(err);
      console.error('[CesiumLidarPlugin]', err);
    };

    // Load COPC header and full hierarchy
    await this.loader.initialize();

    // Fly to the dataset
    const center = this.loader.getDatasetCenter();
    if (center) {
      await this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          center.lng,
          center.lat,
          center.alt + 2000 // 2 km above data center
        ),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
        duration: 2,
      });
    }

    // Register viewport change handler
    this._cleanupViewport = this.viewportManager.onViewportChange(() => {
      this._handleViewportChange();
    });

    // Trigger initial load
    this._handleViewportChange();
  }

  setColorScheme(scheme: ColorScheme): void {
    if (!this.layer || !this.loader) return;
    this.options.colorScheme = scheme;
    this.layer.setColorScheme(scheme);

    // Rebuild display with new colors (no re-fetch needed)
    if (this._latestData) {
      this.layer.updatePoints({ ...this._latestData, count: this._latestData.totalCount,
        positions: this._latestData.allPositions,
        intensities: this._latestData.allIntensities,
        classifications: this._latestData.allClassifications,
        reds: this._latestData.allReds,
        greens: this._latestData.allGreens,
        blues: this._latestData.allBlues,
      });
    }
  }

  setPointSize(size: number): void {
    this.options.pointSize = size;
    this.layer?.setPointSize(size);
  }

  setVisible(visible: boolean): void {
    this.layer?.setVisible(visible);
  }

  /** Reload all nodes (e.g. after resetting to see full dataset) */
  reload(): void {
    this.loader?.reset();
    this._latestData = null;
    this.layer?.destroy();
    if (this.viewer && this.options.colorScheme) {
      this.layer = new CesiumPointCloudLayer(this.viewer, {
        pointSize:   this.options.pointSize,
        colorScheme: this.options.colorScheme,
      });
    }
    this._handleViewportChange();
  }

  destroy(): void {
    this._cleanupViewport?.();
    this.layer?.destroy();
    this.loader = null;
    this.layer = null;
    this.viewportManager = null;
  }

  get stats() {
    return this.loader?.stats ?? null;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _handleViewportChange(): void {
    if (!this.loader?.isInitialized || !this.viewportManager) return;

    const viewport = this.viewportManager.getViewportBounds();
    if (!viewport) return;

    const depth = this.viewportManager.getTargetDepth();
    this.loader.loadNodesForViewport(viewport, depth);
  }

  private _scheduleRebuild(): void {
    if (this._rebuildPending) return;
    this._rebuildPending = true;

    // Batch updates: rebuild at most once per animation frame
    requestAnimationFrame(() => {
      this._rebuildPending = false;
      if (!this._latestData || !this.layer) return;

      this.layer.updatePoints({
        positions:       this._latestData.allPositions,
        intensities:     this._latestData.allIntensities,
        classifications: this._latestData.allClassifications,
        reds:            this._latestData.allReds,
        greens:          this._latestData.allGreens,
        blues:           this._latestData.allBlues,
        count:           this._latestData.totalCount,
      });
    });
  }
}
