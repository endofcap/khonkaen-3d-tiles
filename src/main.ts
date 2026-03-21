import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { CesiumLidarPlugin } from './CesiumLidarPlugin';
import type { ColorScheme } from './types';

// -----------------------------------------------------------------------
// Cesium Ion token
// Leave blank to use OpenStreetMap imagery (no token required).
// Get a free token at https://ion.cesium.com
// -----------------------------------------------------------------------
Cesium.Ion.defaultAccessToken = (window as any).CESIUM_ION_TOKEN ?? '';

// -----------------------------------------------------------------------
// Viewer setup
// -----------------------------------------------------------------------
const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayer: new Cesium.ImageryLayer(
    new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
  ),
  baseLayerPicker:      false,
  geocoder:             false,
  homeButton:           true,
  sceneModePicker:      false,
  navigationHelpButton: true,
  animation:            false,
  timeline:             false,
  fullscreenButton:     true,
});

viewer.scene.globe.enableLighting = false;
viewer.scene.fog.enabled = false;

// -----------------------------------------------------------------------
// COPC data source
// Default: Autzen Stadium classified point cloud (public, CORS-enabled)
// Replace with your own .copc.laz URL to visualize different data.
// -----------------------------------------------------------------------
const COPC_URL =
  (window as any).COPC_URL ??
  'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

// -----------------------------------------------------------------------
// UI elements
// -----------------------------------------------------------------------
const ui = {
  status:      document.getElementById('status')!,
  progress:    document.getElementById('progress')!,
  progressBar: document.getElementById('progress-bar')! as HTMLProgressElement,
  colorScheme: document.getElementById('color-scheme')! as HTMLSelectElement,
  pointSize:   document.getElementById('point-size')! as HTMLInputElement,
  pointSizeVal:document.getElementById('point-size-val')!,
  reloadBtn:   document.getElementById('reload-btn')!,
  urlInput:    document.getElementById('url-input')! as HTMLInputElement,
  loadBtn:     document.getElementById('load-btn')!,
  statsEl:     document.getElementById('stats')!,
};

ui.urlInput.value = COPC_URL;

// -----------------------------------------------------------------------
// Plugin lifecycle
// -----------------------------------------------------------------------
let plugin: CesiumLidarPlugin | null = null;

async function loadCopc(url: string): Promise<void> {
  plugin?.destroy();
  plugin = null;

  ui.status.textContent = '⏳ Initializing COPC reader…';
  ui.progress.style.display = 'block';
  ui.progressBar.value = 0;
  ui.statsEl.textContent = '';

  try {
    plugin = new CesiumLidarPlugin(viewer, {
      url,
      pointBudget:           2_000_000,
      maxConcurrentRequests: 4,
      colorScheme:           ui.colorScheme.value as ColorScheme,
      pointSize:             Number(ui.pointSize.value),
      onProgress: (loaded, total) => {
        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
        ui.progressBar.value = pct;
        ui.statsEl.textContent = `${loaded.toLocaleString()} / ${total.toLocaleString()} points`;
      },
      onError: (err) => {
        ui.status.textContent = `❌ Error: ${err.message}`;
        console.error(err);
      },
    });

    await plugin.initialize();

    ui.status.textContent = '✅ Streaming from COPC file';
    ui.progress.style.display = 'none';

    const stats = plugin.stats;
    if (stats) {
      ui.statsEl.textContent = `${stats.totalNodes} nodes in hierarchy`;
    }

  } catch (err: any) {
    ui.status.textContent = `❌ Failed to load: ${err?.message ?? err}`;
    console.error(err);
  }
}

// -----------------------------------------------------------------------
// UI event wiring
// -----------------------------------------------------------------------
ui.colorScheme.addEventListener('change', () => {
  plugin?.setColorScheme(ui.colorScheme.value as ColorScheme);
});

ui.pointSize.addEventListener('input', () => {
  const val = Number(ui.pointSize.value);
  ui.pointSizeVal.textContent = String(val);
  plugin?.setPointSize(val);
});

ui.reloadBtn.addEventListener('click', () => {
  plugin?.reload();
});

ui.loadBtn.addEventListener('click', () => {
  const url = ui.urlInput.value.trim();
  if (url) loadCopc(url);
});

// -----------------------------------------------------------------------
// Initial load
// -----------------------------------------------------------------------
loadCopc(COPC_URL);
