// 設定：Apps Scriptのエンドポイント
const CONFIG = {
  // doGet() が返すキーAPI（JSON: { key: "..." }）
  keyEndpoint: "https://script.google.com/macros/s/1x6Hh6WZ0ykBokLmem8EnRy9WuGxjYQxntWOj-cSlTDkiiKBtvp_UNnOq/exec?type=key",
  // doGet() が返すステータスAPI（JSON配列: [{id, status, ...}]）
  statusEndpoint: "https://script.google.com/macros/s/AKfycbwCgVpr2kFplLSTBVh8S00msAlg3X6E0AoZX4TRHpJTvFK2-QosLWh2UkaTks5k8IXWWg/exec",
  // GeoJSONファイルのパス（GitHub Pagesに配置）
  geojsonUrl: "https://raw.githubusercontent.com/TKalimpong/kpg-map/refs/heads/main/map.geojson",
  // 初期中心・ズーム
  center: { lat: 35.68, lng: 139.76 },
  zoom: 10,
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
  });

  // GeoJSON読み込み
  await loadGeoJson(map, CONFIG.geojsonUrl);

  // ステータス取得 → 色適用
  const statusData = await fetchStatus(CONFIG.statusEndpoint);
  applyStatusColors(map, statusData);

  // 必要なら定期更新（例：60秒ごと）
  // setInterval(async () => {
  //   const latest = await fetchStatus(CONFIG.statusEndpoint);
  //   applyStatusColors(map, latest);
  // }, 60000);
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
    const id = String(feature.getProperty("id") ?? "");
    const row = statusMap.get(id);
    const status = row?.status ?? "unknown";

    // ステータス→色ルール
    const color = statusColor(status);

    return {
      fillColor: color,
      fillOpacity: 0.6,
      strokeColor: "#333",
      strokeOpacity: 0.9,
      strokeWeight: 1,
    };
  });
}

function statusColor(status) {
  switch (String(status).toLowerCase()) {
    case "active": return "#2ecc71";     // 緑
    case "inactive": return "#e74c3c";   // 赤
    case "pending": return "#f39c12";    // オレンジ
    case "complete": return "#3498db";   // 青
    default: return "#95a5a6";           // グレー
  }
}