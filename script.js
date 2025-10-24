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

  // まずは軽量な暫定スタイル（ステータス未反映）
  map.data.setStyle({
    fillColor: "#95a5a6",
    fillOpacity: 0.25,
    strokeColor: "#777",
    strokeOpacity: 0.6,
    strokeWeight: 0.8,
  });

  // ポリゴンクリックイベントを追加
  addPolygonClickEvents(map, infoWindow);

  // ポイント数が多いと重くなるため、ズーム・ビューポートに応じて動的に数字ラベルを描画
  initPointLabelManager(map);

  // 初回アイドル後（地図が落ち着いてから）にステータス取得→色反映（初期体感を軽く）
  const onceIdle = google.maps.event.addListenerOnce(map, "idle", async () => {
    try {
      const statusData = await fetchStatus(CONFIG.statusEndpoint);
      applyStatusColors(map, statusData);
      // スタイル変更後に必要ならラベルを再同期
      schedulePointLabelUpdate(map);
    } catch (e) {
      console.error("[status] failed:", e);
    }
  });

  // 定期更新（1日ごと）しかしリロードのたびに更新されるため不要かも
//   setInterval(async () => {
//     const latest = await fetchStatus(CONFIG.statusEndpoint);
//     applyStatusColors(map, latest);
//   }, 86400000);
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

    // ポイントとポリゴンで異なるスタイルを適用
    if (geometryType === 'Point') {
      // Dataレイヤー側のポイント描画はオフにし、軽量な独自ラベル（Marker）に委ねる
      return { visible: false };
    } else {
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

// ========================= 軽量表示のためのラベル管理 =========================
const __labelStore = { markers: new Map(), scheduled: false };

function initPointLabelManager(map) {
  // 初回・移動・ズーム時に、必要なポイントだけラベルを表示
  const update = () => schedulePointLabelUpdate(map);
  google.maps.event.addListener(map, 'idle', update);
  google.maps.event.addListener(map, 'zoom_changed', update);
  // 初期呼び出し
  schedulePointLabelUpdate(map);
}

function schedulePointLabelUpdate(map) {
  if (__labelStore.scheduled) return;
  __labelStore.scheduled = true;
  const cb = () => {
    __labelStore.scheduled = false;
    try { updatePointLabels(map); } catch (e) { console.error(e); }
  };
  if (window.requestIdleCallback) {
    requestIdleCallback(cb, { timeout: 200 });
  } else {
    setTimeout(cb, 50);
  }
}

function updatePointLabels(map) {
  const bounds = map.getBounds();
  if (!bounds) return; // まだ初期化途中
  const zoom = map.getZoom() || 0;

  // ズームが低いときは全ラベルを撤去（負荷軽減）
  if (zoom < 20) {
    clearAllPointLabels();
    return;
  }

  // 可視領域にあるポイントのみラベル作成
  const alive = new Set();
  map.data.forEach((feature) => {
    if (feature.getGeometry().getType() !== 'Point') return;
    const name = feature.getProperty('name');
    if (!name) return;
    const pos = feature.getGeometry().get();
    const latLng = new google.maps.LatLng(pos.lat(), pos.lng());
    if (!bounds.contains(latLng)) return;

    const key = String(name);
    alive.add(key);
    if (__labelStore.markers.has(key)) return; // 既存

    // 数字を抽出（例: "Point 1" → "1", "ポイント 77" → "77"）
    const numberMatch = key.match(/(\d+)/);
    const labelText = numberMatch ? numberMatch[1] : key;

    const marker = new google.maps.Marker({
      position: latLng,
      map,
      optimized: true, // キャンバス最適化
      label: {
        text: labelText,
        color: '#FFFFFF',
        fontWeight: 'bold',
        fontSize: '12px'
      },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 11,
        fillColor: '#9c27b0',
        fillOpacity: 0.85,
        strokeColor: '#FFFFFF',
        strokeWeight: 2
      },
      title: key
    });
    __labelStore.markers.set(key, marker);
  });

  // 画面外に出たものは破棄
  for (const [key, marker] of __labelStore.markers) {
    if (!alive.has(key)) {
      marker.setMap(null);
      __labelStore.markers.delete(key);
    }
  }
}

function clearAllPointLabels() {
  for (const [, marker] of __labelStore.markers) {
    marker.setMap(null);
  }
  __labelStore.markers.clear();
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