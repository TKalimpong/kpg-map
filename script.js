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
};

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
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=__initMap`;
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
    // 初期描画を軽くするため、重いUIはオフ（必要に応じて戻せます）
    fullscreenControl: true,
    streetViewControl: false,
    mapTypeControl: true,
  });

  // InfoWindowを作成（クリック時に使用）
  const infoWindow = new google.maps.InfoWindow();

  // GeoJSON読み込み
  await loadGeoJson(map, CONFIG.geojsonUrl);

  // ステータス取得 → 色適用
  const statusData = await fetchStatus(CONFIG.statusEndpoint);
  applyStatusColors(map, statusData);
  
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
        fillOpacity: 0.45, // 少し軽め
        strokeColor: "#666",
        strokeOpacity: 0.7, // 線の透明度
        strokeWeight: 0.9, // 線の太さ
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

// ポリゴンクリックイベントを追加する関数
function addPolygonClickEvents(map, infoWindow) {
  map.data.addListener('click', (event) => {
    const feature = event.feature;
    const geometryType = feature.getGeometry().getType();
    
    if (geometryType === 'Polygon') {
      const name = feature.getProperty("name");
      const content = `<div style="font-weight: bold; font-size: 16px;">エリア ${name}</div>`;
      
      infoWindow.setContent(content);
      infoWindow.setPosition(event.latLng);
      infoWindow.open(map);
    }
  });
}