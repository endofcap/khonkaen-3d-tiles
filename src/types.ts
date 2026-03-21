/** COPC octree node key: "depth-x-y-z" */
export type VoxelKey = string;

export interface NodeInfo {
  key: VoxelKey;
  depth: number;
  x: number;
  y: number;
  z: number;
  pointCount: number;
  pointDataOffset: number;
  pointDataLength: number;
  /** Bounding box in the COPC file's native CRS */
  bounds: [number, number, number, number, number, number]; // [minX,minY,minZ,maxX,maxY,maxZ]
  /** Bounding box in WGS84 degrees (minLng,minLat,maxLng,maxLat) */
  wgs84Bounds: [number, number, number, number] | null;
  status: 'pending' | 'loading' | 'loaded' | 'error';
}

export interface ViewportBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** Raw arrays of point attributes for a batch of loaded points */
export interface PointBatch {
  /** Interleaved WGS84: [lng0,lat0,alt0, lng1,lat1,alt1, ...] in degrees/meters */
  positions: Float64Array;
  /** Interleaved RGBA bytes: [r0,g0,b0,a0, r1,g1,b1,a1, ...] */
  colors: Uint8Array;
  intensities: Float32Array;
  classifications: Uint8Array;
  count: number;
}

export type ColorScheme = 'elevation' | 'intensity' | 'classification' | 'rgb';

export interface LidarPluginOptions {
  /** URL to the .copc.laz file (must allow CORS) */
  url: string;
  /** Maximum total points to keep in memory (default: 2_000_000) */
  pointBudget?: number;
  /** Max concurrent HTTP range requests (default: 4) */
  maxConcurrentRequests?: number;
  /** How to color points (default: 'elevation') */
  colorScheme?: ColorScheme;
  /** Point pixel size in Cesium (default: 2) */
  pointSize?: number;
  /** Cesium Ion access token (leave blank to skip Ion assets) */
  ionAccessToken?: string;
  /** Called when loading progress changes [loaded, total] */
  onProgress?: (loaded: number, total: number) => void;
  /** Called when an error occurs */
  onError?: (err: Error) => void;
}
