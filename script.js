// 設定：Apps Scriptのエンドポイント
const CONFIG = {
  // doGet() が返すキーAPI（JSON: { key: "..." }）
  keyEndpoint: "https://script.google.com/macros/s/AKfycbwCgVpr2kFplLSTBVh8S00msAlg3X6E0AoZX4TRHpJTvFK2-QosLWh2UkaTks5k8IXWWg/exec?type=key",
  // doGet() が返すステータスAPI（JSON配列: [{id, status, ...}]）
  statusEndpoint: "https://script.google.com/macros/s/AKfycbwCgVpr2kFplLSTBVh8S00msAlg3X6E0AoZX4TRHpJTvFK2-QosLWh2UkaTks5k8IXWWg/exec?type=status",
  // GeoJSONファイルのパス（GitHub Pagesに配置）
  geojsonUrl: "https://tkalimpong.github.io/kpg-map/map.geojson",
  // 初期中心・ズーム
  center: { lat: 27.059542543488494, lng: 88.46901912492227 },
  zoom: 15,
  
  // ラベル表示の設定
  labelSettings: {
    minZoomForLabels: 13,    // ラベル表示の最小ズームレベル
    maxLabelsLowZoom: 20,    // 低ズーム時の最大ラベル数
    maxLabelsHighZoom: 100,  // 高ズーム時の最大ラベル数
    updateThrottleMs: 250    // 更新頻度制御（ミリ秒）
  }
};

// グローバル変数：ラベル管理
let polygonLabels = new Map(); // name -> marker のマッピング
let polygonFeatures = [];      // すべてのポリゴンフィーチャー
let lastUpdateTime = 0;        // 最後の更新時刻
let statusDataMap = new Map(); // ステータスデータの保存

// ページ読み込み時に開始
window.addEventListener("DOMContentLoaded", bootstrap);

async function bootstrap() {
  try {
    const apiKey = await fetchApiKey(CONFIG.keyEndpoint);
    await loadGoogleMaps(apiKey);
    await initMapWithData();
  } catch (err) {
    console.error("[bootstrap] failed:", err);
  }
}

async function fetchApiKey(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Key fetch failed: ${res.status}`);
  const data = await res.json();
  if (!data.key) throw new Error("Missing 'key' in response");
  return data.key;
}

// Google Maps JS APIを動的ロード
function loadGoogleMaps(apiKey) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-gmaps]");
    if (existing) return resolve();

    const script = document.createElement("script");
    script.dataset.gmaps = "1";
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=geometry&callback=__initMap`;
    window.__initMap = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function initMapWithData() {
  // 地図を初期化
  const map = new google.maps.Map(document.getElementById("map"), {
    center: CONFIG.center,
    zoom: CONFIG.zoom,
    mapId: undefined, // 必要ならスタイル用のMapID
  });

  // InfoWindowを作成（クリック時に使用）
  const infoWindow = new google.maps.InfoWindow();

  // GeoJSON読み込み
  await loadGeoJson(map, CONFIG.geojsonUrl);

  // ステータス取得 → 色適用
  const statusData = await fetchStatus(CONFIG.statusEndpoint);
  statusDataMap = statusData; // グローバルに保存
  applyStatusColors(map, statusData);
  
  // ポリゴンデータを収集
  collectPolygonFeatures(map);
  
  // 初期ラベル表示
  updatePolygonLabels(map);
  
  // マップ移動・ズームイベントでラベル更新
  map.addListener('bounds_changed', () => {
    throttledUpdateLabels(map);
  });
  
  // ポリゴンクリックイベントを追加
  addPolygonClickEvents(map, infoWindow);

}

function loadGeoJson(map, url) {
  return new Promise((resolve, reject) => {
    map.data.loadGeoJson(url, null, () => resolve());
    // map.data.loadGeoJsonにはエラーコールバックがないため、失敗検知は難しい
    // 必要ならfetch→addGeoJsonの手動実装に切り替える
  });
}

async function fetchStatus(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
  const json = await res.json();
  // [{id, status, ...}] 形式を想定
  // マッピング高速化のためMapに整形
  const map = new Map();
  for (const row of json) {
    if (row && row.id != null) map.set(String(row.id), row);
  }
  return map;
}

function applyStatusColors(map, statusMap) {
  map.data.setStyle((feature) => {
    const geometryType = feature.getGeometry().getType();
    const id = String(feature.getProperty("name") ?? "");
    const row = statusMap.get(id);
    const status = row?.status ?? "unknown";

    // ステータス→色ルール
    const color = statusColor(status);

    if (geometryType === 'Polygon') {
      // ポリゴンのスタイル
      return {
        fillColor: color, // 塗りつぶしの色
        fillOpacity: 0.6, // 塗りつぶしの透明度
        strokeColor: "#444444",
        strokeOpacity: 0.7, // 線の透明度
        strokeWeight: 1, // 線の太さ
      };
    }
  });
}

function statusColor(status) {
  switch (String(status).toLowerCase()) {
    case "4to24months": return "#3498db";     // 青
    case "recentlydone": return "#e74c3c";   // 赤
    case "doing": return "#f39c12";    // オレンジ
    case "campaign": return "#2ecc71";   // 緑
    default: return "#95a5a6";           // グレー
  }
}

// ポリゴンフィーチャーを収集する関数
function collectPolygonFeatures(map) {
  polygonFeatures = [];
  map.data.forEach((feature) => {
    const geometryType = feature.getGeometry().getType();
    if (geometryType === 'Polygon') {
      const name = String(feature.getProperty("name"));
      const bounds = new google.maps.LatLngBounds();
      const geometry = feature.getGeometry();
      
      // ポリゴンの頂点を取得してboundsに追加
      geometry.getArray().forEach((path) => {
        path.getArray().forEach((latLng) => {
          bounds.extend(latLng);
        });
      });
      
      const center = bounds.getCenter();
            
      // ステータス情報を取得
      const statusRow = statusDataMap.get(name);
      const status = statusRow?.status ?? "unknown";
      
      polygonFeatures.push({
        feature: feature,
        name: name,
        center: center,
        bounds: bounds,
        status: status
      });
    }
  });
  console.log(`Collected ${polygonFeatures.length} polygon features`);
}

// スロットル制御付きのラベル更新
function throttledUpdateLabels(map) {
  const now = Date.now();
  if (now - lastUpdateTime < CONFIG.labelSettings.updateThrottleMs) {
    return;
  }
  lastUpdateTime = now;
  
  // 少し遅延させて更新（連続呼び出しを防ぐ）
  setTimeout(() => updatePolygonLabels(map), 50);
}

// 軽量化されたポリゴンラベル更新関数
function updatePolygonLabels(map) {
  const zoom = map.getZoom();
  const bounds = map.getBounds();
  
  // ズームレベルが低すぎる場合はラベルを表示しない
  if (zoom < CONFIG.labelSettings.minZoomForLabels) {
    clearAllLabels();
    return;
  }
  
  // 可視域内のポリゴンを特定
  const visiblePolygons = polygonFeatures.filter(poly => {
    return bounds && bounds.contains(poly.center);
  });
  
  // ズームレベルに応じた最大表示数を決定
  const maxLabels = zoom >= 16 
    ? CONFIG.labelSettings.maxLabelsHighZoom 
    : CONFIG.labelSettings.maxLabelsLowZoom;
  
  // 距離でソート（中心に近いものから表示）
  const mapCenter = map.getCenter();
  visiblePolygons.sort((a, b) => {
    const distA = google.maps.geometry.spherical.computeDistanceBetween(mapCenter, a.center);
    const distB = google.maps.geometry.spherical.computeDistanceBetween(mapCenter, b.center);
    return distA - distB;
  });
  
  // 表示する必要があるポリゴンを決定
  const toShow = new Set(visiblePolygons.slice(0, maxLabels).map(p => p.name));
  
  // 不要なラベルを削除
  for (const [name, marker] of polygonLabels) {
    if (!toShow.has(name)) {
      marker.setMap(null);
      polygonLabels.delete(name);
    }
  }
  
  // 新しいラベルを作成
  let createdCount = 0;
  for (const poly of visiblePolygons.slice(0, maxLabels)) {
    if (!polygonLabels.has(poly.name)) {
      createPolygonLabel(map, poly);
      createdCount++;
    }
  }
  
  console.log(`Labels: ${polygonLabels.size} displayed, ${createdCount} created, zoom: ${zoom}`);
}

// 個別のポリゴンラベルを作成
function createPolygonLabel(map, polygonData) {
  const { name, center, status } = polygonData;
  const labelText = name || "?";

  // ステータスに応じた色を取得
  const labelColor = statusColor(status);

  const marker = new google.maps.Marker({
    position: center,
    map: map,
    label: {
      text: labelText,
      color: '#FFFFFF',
      fontWeight: 'bold',
      fontSize: '16px'
    },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 18,
      fillColor: labelColor, // ステータス色を適用
      fillOpacity: 0.9,
      strokeColor: '#FFFFFF',
      strokeWeight: 2
    },
    title: `エリア ${name} (${status})`, // ステータスも表示
    zIndex: 1000
  });
  
  polygonLabels.set(name, marker);
}

// すべてのラベルをクリア
function clearAllLabels() {
  for (const [name, marker] of polygonLabels) {
    marker.setMap(null);
  }
  polygonLabels.clear();
}

// レガシー関数（互換性のため残す）
function addPolygonLabels(map) {
  console.log("Legacy addPolygonLabels called - using new optimized version");
  updatePolygonLabels(map);
}

// ポリゴンクリックイベントを追加する関数
function addPolygonClickEvents(map, infoWindow) {
  map.data.addListener('click', (event) => {
    const feature = event.feature;
    const geometryType = feature.getGeometry().getType();
    
    if (geometryType === 'Polygon') {
      const name = feature.getProperty("name");
      const content = `<div style="font-weight: bold; font-size: 14px;">エリア ${name}</div>`;
      
      infoWindow.setContent(content);
      infoWindow.setPosition(event.latLng);
      infoWindow.open(map);
    }
  });
}