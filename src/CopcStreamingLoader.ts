/**
 * CopcStreamingLoader
 *
 * Streams point cloud data from a COPC (Cloud Optimized Point Cloud) file
 * using viewport-based octree node selection.
 *
 * Ported and adapted from maplibre-gl-lidar's CopcStreamingLoader.ts.
 * Key differences from the original:
 *   - Framework-agnostic: accepts a generic ViewportBounds instead of MapLibre bounds
 *   - No dependency on deck.gl or MapLibre
 *   - Uses the same `copc` and `proj4` libraries
 */

import { Copc } from 'copc';
import proj4 from 'proj4';
import type { NodeInfo, ViewportBounds, PointBatch, VoxelKey } from './types';

interface CopcHeader {
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  pointDataRecordFormat: number;
  pointDataRecordLength: number;
}

interface CopcInfo {
  cube: { center: [number, number, number]; halfSize: number };
  spacing: number;
  rootHierarchyPage: { pageOffset: number; pageLength: number };
  gpsTimeRange?: [number, number];
}

export interface StreamingStats {
  totalNodes: number;
  loadedNodes: number;
  totalPoints: number;
  loadedPoints: number;
}

export class CopcStreamingLoader {
  private url: string;
  private copcReader: Awaited<ReturnType<typeof Copc.create>> | null = null;
  private nodes = new Map<VoxelKey, NodeInfo>();
  private toWgs84: ((coords: [number, number]) => [number, number]) | null = null;
  private verticalScale = 1.0; // feet-to-meters if needed

  private pointBudget: number;
  private maxConcurrent: number;
  private activeRequests = 0;
  private loadQueue: VoxelKey[] = [];

  /** Accumulated loaded point data (ring-buffer style, limited by pointBudget) */
  private positions: Float64Array;
  private intensities: Float32Array;
  private classifications: Uint8Array;
  private reds: Uint8Array;
  private greens: Uint8Array;
  private blues: Uint8Array;
  private totalLoadedPoints = 0;

  onProgress?: (stats: StreamingStats) => void;
  onUpdate?: (batch: PointBatch & {
    allPositions: Float64Array;
    allIntensities: Float32Array;
    allClassifications: Uint8Array;
    allReds: Uint8Array;
    allGreens: Uint8Array;
    allBlues: Uint8Array;
    totalCount: number;
  }) => void;
  onError?: (err: Error) => void;

  constructor(
    url: string,
    options: { pointBudget?: number; maxConcurrentRequests?: number } = {}
  ) {
    this.url = url;
    this.pointBudget = options.pointBudget ?? 2_000_000;
    this.maxConcurrent = options.maxConcurrentRequests ?? 4;

    this.positions        = new Float64Array(this.pointBudget * 3);
    this.intensities      = new Float32Array(this.pointBudget);
    this.classifications  = new Uint8Array(this.pointBudget);
    this.reds             = new Uint8Array(this.pointBudget);
    this.greens           = new Uint8Array(this.pointBudget);
    this.blues            = new Uint8Array(this.pointBudget);
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    this.copcReader = await Copc.create(this.url);
    this._setupProjection();
    await this._loadHierarchy();
  }

  private _setupProjection(): void {
    if (!this.copcReader) return;
    const wkt: string | undefined = (this.copcReader as any).wkt;

    if (wkt) {
      try {
        proj4.defs('LIDAR_CRS', wkt);
        // Verify it works on a dummy point
        proj4('LIDAR_CRS', 'WGS84', [0, 0]);
        this.toWgs84 = (xy) => proj4('LIDAR_CRS', 'WGS84', xy) as [number, number];
        return;
      } catch {
        // WKT parse failed, fall through to EPSG detection
      }
    }

    // Fallback: try to detect common UTM zones from the data extents
    this.toWgs84 = this._buildFallbackProjection();
  }

  private _buildFallbackProjection(): (xy: [number, number]) => [number, number] {
    if (!this.copcReader) return (xy) => xy;
    const header = (this.copcReader as any).header as CopcHeader;
    const [cx] = (this.copcReader as any).info?.cube?.center ?? [header.offset[0]];

    // Guess UTM zone from X center coordinate
    if (cx > 100_000 && cx < 900_000) {
      // Looks like a UTM easting
      const approxLng = header.offset[0] > 180
        ? undefined // can't guess from offset alone
        : header.offset[0];

      if (approxLng !== undefined && approxLng >= -180 && approxLng <= 180) {
        const zone = Math.floor((approxLng + 180) / 6) + 1;
        const hemi = header.offset[1] >= 0 ? '' : '+south ';
        const utmProj = `+proj=utm +zone=${zone} ${hemi}+datum=WGS84 +units=m +no_defs`;
        try {
          proj4.defs('LIDAR_UTM', utmProj);
          return (xy) => proj4('LIDAR_UTM', 'WGS84', xy) as [number, number];
        } catch {
          // ignore
        }
      }
    }

    // Last resort: assume the data is already in WGS84 degrees
    return (xy) => xy;
  }

  private async _loadHierarchy(): Promise<void> {
    if (!this.copcReader) return;
    const info = (this.copcReader as any).info as CopcInfo;
    await this._loadHierarchyPage(info.rootHierarchyPage);
  }

  private async _loadHierarchyPage(page: { pageOffset: number; pageLength: number }): Promise<void> {
    if (!this.copcReader) return;
    const { nodes, pages } = await Copc.loadHierarchyPage(this.url, page);

    for (const [keyStr, node] of Object.entries(nodes)) {
      if (!node || node.pointCount === 0) continue;
      const [d, x, y, z] = keyStr.split('-').map(Number);
      const bounds = this._nodeBounds(d, x, y, z);
      const wgs84Bounds = this._toWgs84Bounds(bounds);

      this.nodes.set(keyStr, {
        key: keyStr,
        depth: d, x, y, z,
        pointCount: node.pointCount,
        pointDataOffset: node.pointDataOffset,
        pointDataLength: node.pointDataLength,
        bounds,
        wgs84Bounds,
        status: 'pending',
      });
    }

    // Recursively load child hierarchy pages
    await Promise.all(
      Object.values(pages).map((p) => p ? this._loadHierarchyPage(p) : Promise.resolve())
    );
  }

  // ---------------------------------------------------------------------------
  // Bounds computation
  // ---------------------------------------------------------------------------

  private _nodeBounds(
    depth: number, vx: number, vy: number, vz: number
  ): [number, number, number, number, number, number] {
    if (!this.copcReader) return [0, 0, 0, 1, 1, 1];
    const info = (this.copcReader as any).info as CopcInfo;
    const { center, halfSize } = info.cube;

    const nodeSize = (2 * halfSize) / Math.pow(2, depth);
    const minX = (center[0] - halfSize) + vx * nodeSize;
    const minY = (center[1] - halfSize) + vy * nodeSize;
    const minZ = (center[2] - halfSize) + vz * nodeSize;

    return [minX, minY, minZ, minX + nodeSize, minY + nodeSize, minZ + nodeSize];
  }

  private _toWgs84Bounds(
    bounds: [number, number, number, number, number, number]
  ): [number, number, number, number] | null {
    if (!this.toWgs84) return null;
    try {
      const [minLng, minLat] = this.toWgs84([bounds[0], bounds[1]]);
      const [maxLng, maxLat] = this.toWgs84([bounds[3], bounds[4]]);
      if (!isFinite(minLng) || !isFinite(minLat) || !isFinite(maxLng) || !isFinite(maxLat)) {
        return null;
      }
      return [
        Math.min(minLng, maxLng),
        Math.min(minLat, maxLat),
        Math.max(minLng, maxLng),
        Math.max(minLat, maxLat),
      ];
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Viewport-based node selection
  // ---------------------------------------------------------------------------

  /**
   * Determine which nodes to load based on the current viewport and target depth.
   * Target depth is derived from camera altitude.
   */
  selectNodesForViewport(viewport: ViewportBounds, targetDepth: number): VoxelKey[] {
    const candidates: Array<{ key: VoxelKey; priority: number }> = [];
    const centerLng = (viewport.minLng + viewport.maxLng) / 2;
    const centerLat = (viewport.minLat + viewport.maxLat) / 2;

    for (const [key, node] of this.nodes) {
      if (node.status === 'loaded' || node.status === 'loading') continue;
      if (node.depth > targetDepth + 1) continue;
      if (!node.wgs84Bounds) continue;

      if (!this._intersectsViewport(node.wgs84Bounds, viewport)) continue;

      // Priority: prefer nodes closer to center and at higher depth
      const nodeCenterLng = (node.wgs84Bounds[0] + node.wgs84Bounds[2]) / 2;
      const nodeCenterLat = (node.wgs84Bounds[1] + node.wgs84Bounds[3]) / 2;
      const dist = Math.hypot(nodeCenterLng - centerLng, nodeCenterLat - centerLat);
      const priority = node.depth * 10 - dist;

      candidates.push({ key, priority });
    }

    // Sort by priority (higher = load first)
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates.map((c) => c.key);
  }

  private _intersectsViewport(
    bounds: [number, number, number, number],
    vp: ViewportBounds
  ): boolean {
    return !(
      bounds[2] < vp.minLng ||
      bounds[0] > vp.maxLng ||
      bounds[3] < vp.minLat ||
      bounds[1] > vp.maxLat
    );
  }

  // ---------------------------------------------------------------------------
  // Node loading
  // ---------------------------------------------------------------------------

  async loadNodesForViewport(viewport: ViewportBounds, targetDepth: number): Promise<void> {
    const keys = this.selectNodesForViewport(viewport, targetDepth);
    this.loadQueue = keys;
    this._processQueue();
  }

  private _processQueue(): void {
    while (this.activeRequests < this.maxConcurrent && this.loadQueue.length > 0) {
      const key = this.loadQueue.shift()!;
      const node = this.nodes.get(key);
      if (!node || node.status !== 'pending') continue;
      node.status = 'loading';
      this.activeRequests++;
      this._loadNode(node).finally(() => {
        this.activeRequests--;
        this._processQueue();
      });
    }
  }

  private async _loadNode(node: NodeInfo): Promise<void> {
    if (!this.copcReader) return;
    try {
      // Copc.loadPointDataView(url, copcReader, node) → { pointCount, dimensions, getter }
      // dimensions is a Record<string, type> (object keyed by dimension name)
      const view = await Copc.loadPointDataView(this.url, this.copcReader, node) as unknown as {
        pointCount: number;
        dimensions: Record<string, string>;
        getter: (name: string) => (index: number) => number;
      };

      const count = view.pointCount;
      if (this.totalLoadedPoints + count > this.pointBudget) {
        // Budget exceeded: skip this node
        node.status = 'pending';
        return;
      }

      const offset = this.totalLoadedPoints;
      this.totalLoadedPoints += count;

      // Build per-dimension getters once (avoids repeated lookup)
      const getX = view.getter('X');
      const getY = view.getter('Y');
      const getZ = view.getter('Z');
      const dims = view.dimensions;
      const getIntensity = 'Intensity'      in dims ? view.getter('Intensity')      : null;
      const getClass     = 'Classification' in dims ? view.getter('Classification') : null;
      const getRed       = 'Red'            in dims ? view.getter('Red')            : null;
      const getGreen     = 'Green'          in dims ? view.getter('Green')          : null;
      const getBlue      = 'Blue'           in dims ? view.getter('Blue')           : null;

      // Extract and transform point data
      for (let i = 0; i < count; i++) {
        const xi = getX(i);
        const yi = getY(i);
        const zi = getZ(i);

        let lng: number, lat: number;
        if (this.toWgs84) {
          try {
            [lng, lat] = this.toWgs84([xi, yi]);
          } catch {
            lng = xi;
            lat = yi;
          }
        } else {
          lng = xi;
          lat = yi;
        }

        // Clamp to valid WGS84 ranges
        lng = Math.max(-180, Math.min(180, lng));
        lat = Math.max(-90, Math.min(90, lat));
        const alt = zi * this.verticalScale;

        const idx = offset + i;
        this.positions[idx * 3    ] = lng;
        this.positions[idx * 3 + 1] = lat;
        this.positions[idx * 3 + 2] = alt;

        this.intensities[idx]    = getIntensity ? getIntensity(i) / 65535 * 255 : 128;
        this.classifications[idx] = getClass ? getClass(i) : 0;
        // LAS stores 16-bit RGB; shift down to 8-bit
        this.reds[idx]   = getRed   ? (getRed(i)   >> 8) & 0xff : 150;
        this.greens[idx] = getGreen ? (getGreen(i) >> 8) & 0xff : 150;
        this.blues[idx]  = getBlue  ? (getBlue(i)  >> 8) & 0xff : 150;
      }

      node.status = 'loaded';

      // Notify
      const newBatch: PointBatch = {
        positions: this.positions.subarray(offset * 3, (offset + count) * 3) as Float64Array,
        colors: new Uint8Array(count * 4), // colors computed by CesiumPointCloudLayer
        intensities: this.intensities.subarray(offset, offset + count) as Float32Array,
        classifications: this.classifications.subarray(offset, offset + count),
        count,
      };

      this.onUpdate?.({
        ...newBatch,
        allPositions: this.positions.subarray(0, this.totalLoadedPoints * 3) as Float64Array,
        allIntensities: this.intensities.subarray(0, this.totalLoadedPoints) as Float32Array,
        allClassifications: this.classifications.subarray(0, this.totalLoadedPoints),
        allReds: this.reds.subarray(0, this.totalLoadedPoints),
        allGreens: this.greens.subarray(0, this.totalLoadedPoints),
        allBlues: this.blues.subarray(0, this.totalLoadedPoints),
        totalCount: this.totalLoadedPoints,
      });

      this.onProgress?.(this._getStats());

    } catch (err) {
      node.status = 'error';
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private _getStats(): StreamingStats {
    let loadedNodes = 0, loadedPoints = 0;
    for (const node of this.nodes.values()) {
      if (node.status === 'loaded') {
        loadedNodes++;
        loadedPoints += node.pointCount;
      }
    }
    return {
      totalNodes: this.nodes.size,
      loadedNodes,
      totalPoints: Array.from(this.nodes.values()).reduce((s, n) => s + n.pointCount, 0),
      loadedPoints,
    };
  }

  /** Reset all loaded nodes (e.g. when switching color schemes) */
  reset(): void {
    this.loadQueue = [];
    this.totalLoadedPoints = 0;
    for (const node of this.nodes.values()) {
      if (node.status !== 'error') node.status = 'pending';
    }
  }

  get isInitialized(): boolean {
    return this.copcReader !== null;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get stats(): StreamingStats {
    return this._getStats();
  }

  /** Get the overall bounding box in WGS84 from the COPC header */
  getDatasetBounds(): [number, number, number, number] | null {
    if (!this.copcReader || !this.toWgs84) return null;
    try {
      const header = (this.copcReader as any).header as CopcHeader;
      const [minLng, minLat] = this.toWgs84([header.min[0], header.min[1]]);
      const [maxLng, maxLat] = this.toWgs84([header.max[0], header.max[1]]);
      return [minLng, minLat, maxLng, maxLat];
    } catch {
      return null;
    }
  }

  /** Get the center altitude (Z mid-point) for initial camera positioning */
  getDatasetCenter(): { lng: number; lat: number; alt: number } | null {
    const bounds = this.getDatasetBounds();
    if (!bounds || !this.copcReader) return null;
    const header = (this.copcReader as any).header as CopcHeader;
    return {
      lng: (bounds[0] + bounds[2]) / 2,
      lat: (bounds[1] + bounds[3]) / 2,
      alt: (header.min[2] + header.max[2]) / 2,
    };
  }
}
