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

// 現在地表示用の状態
let myLocationMarker = null;   // 現在地マーカー
let myLocationCircle = null;   // 精度円
let myLocationWatchId = null;  // watchPosition ID
let myLocationFirstFix = false; // 初回測位でパンするためのフラグ

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
    script.defer = true; // async defer を両方指定
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

  // 現在地コントロールを追加
  addMyLocationControl(map);

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
    case "available_s": return "#3498db";     // 青
    case "available_sc": return "#2980b9";   // 濃い青
    case "available_l": return "#1abc5dff";   // 黄緑
    case "available_lc" : return "#1c8548ff";   // 濃い緑
    case "recently_completed": return "#e74c3c";   // 赤
    case "in_use": return "#f39c12";    // オレンジ
    default: return "#95a5a6";           // グレー
  }
}

// ポリゴンフィーチャーを収集する関数
function collectPolygonFeatures(map) {
  polygonFeatures = [];
  // console.log("Status data map size:", statusDataMap.size);
  // console.log("Status data keys:", Array.from(statusDataMap.keys()));
  
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
  const addInfo = statusRow?.add_info ?? "";
      
      // console.log(`Polygon: ${name}, Status: ${status}, StatusRow:`, statusRow);
      
      polygonFeatures.push({
        feature: feature,
        name: name,
        center: center,
        bounds: bounds,
        status: status,
        addInfo: addInfo
      });
    }
  });
  // console.log(`Collected ${polygonFeatures.length} polygon features`);
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
  
  // 新しいラベルを作成または更新
  let createdCount = 0;
  let updatedCount = 0;
  for (const poly of visiblePolygons.slice(0, maxLabels)) {
    const existingMarker = polygonLabels.get(poly.name);
    if (!existingMarker) {
      createPolygonLabel(map, poly);
      createdCount++;
    } else {
      // 既存のマーカーがある場合、ステータス色を確認して必要に応じて更新
      const currentColor = statusColor(poly.status);
      const currentIcon = existingMarker.getIcon();
      
      if (!currentIcon || currentIcon.fillColor !== currentColor) {
        // 色が違う場合は既存マーカーを削除して新しく作成
        existingMarker.setMap(null);
        polygonLabels.delete(poly.name);
        createPolygonLabel(map, poly);
        updatedCount++;
      }
    }
  }
  
  // console.log(`Labels: ${polygonLabels.size} displayed, ${createdCount} created, ${updatedCount} updated, zoom: ${zoom}`);
}

// 個別のポリゴンラベルを作成
function createPolygonLabel(map, polygonData) {
  const { name, center, status, addInfo } = polygonData;
  const labelText = name || "?";

  // ステータスに応じた色を取得
  const labelColor = statusColor(status);
  
  // console.log(`Creating label for ${name}: status=${status}, color=${labelColor}`);

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
    title: addInfo ? `${name} (${status} - ${addInfo})` : `${name} (${status})`, // ステータス + 追加情報
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
  // console.log("Legacy addPolygonLabels called - using new optimized version");
  updatePolygonLabels(map);
}

// ポリゴンクリックイベントを追加する関数
function addPolygonClickEvents(map, infoWindow) {
  map.data.addListener('click', (event) => {
    const feature = event.feature;
    const geometryType = feature.getGeometry().getType();
    
    if (geometryType === 'Polygon') {
      const name = String(feature.getProperty("name"));
      // ステータスを取得（なければ unknown）
      const row = statusDataMap.get(name);
      const status = row?.status ?? "unknown";
      const add_info = row?.add_info ?? "";
      const isDate = !isNaN(Date.parse(status)); //statusが日付かどうかチェック
      const dateNote = isDate ? "Last used: " : "";
      const content = `
        <div style="font-weight: bold; font-size: 14px;">
          ${name}（${status}）
        </div>
        ${dateNote}${add_info ? `<div style="margin-top:4px; font-size: 12px; color:#333;">${add_info}</div>` : ''}
      `;
      
      infoWindow.setContent(content);
      infoWindow.setPosition(event.latLng);
      infoWindow.open(map);
    }
  });
}

// 現在地コントロールを追加
function addMyLocationControl(map) {
  const controlDiv = document.createElement('div');
  const controlBtn = document.createElement('button');
  controlBtn.type = 'button';
  controlBtn.textContent = 'Location';
  controlBtn.title = 'Toggle current location display';
  Object.assign(controlBtn.style, {
    background: '#fff',
    border: '2px solid #fff',
    borderRadius: '4px',
    boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
    cursor: 'pointer',
    margin: '10px',
    padding: '8px 12px',
    fontSize: '14px'
  });
  
  function setActive(active) {
    if (active) {
      controlBtn.style.background = '#1a73e8';
      controlBtn.style.color = '#fff';
      controlBtn.style.borderColor = '#1a73e8';
    } else {
      controlBtn.style.background = '#fff';
      controlBtn.style.color = '#000';
      controlBtn.style.borderColor = '#fff';
    }
  }

  controlBtn.addEventListener('click', () => {
    if (myLocationWatchId == null) {
      startMyLocation(map).then(() => setActive(true)).catch(() => setActive(false));
    } else {
      stopMyLocation();
      setActive(false);
    }
  });

  controlDiv.appendChild(controlBtn);
  map.controls[google.maps.ControlPosition.TOP_RIGHT].push(controlDiv);
}

// 現在地のウォッチ開始
function startMyLocation(map) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      console.warn('Geolocation is not supported in this browser');
      reject(new Error('Geolocation unsupported'));
      return;
    }
    if (myLocationWatchId != null) {
      resolve();
      return;
    }

    const onSuccess = (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = Math.min(pos.coords.accuracy || 0, 800); // 半径の上限
      const latLng = new google.maps.LatLng(lat, lng);

      // マーカー作成 or 更新
      if (!myLocationMarker) {
        myLocationMarker = new google.maps.Marker({
          position: latLng,
          map,
          zIndex: 2000,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: '#1a73e8',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2
          },
          title: 'Location'
        });
      } else {
        myLocationMarker.setPosition(latLng);
      }

      // 精度円作成 or 更新
      if (!myLocationCircle) {
        myLocationCircle = new google.maps.Circle({
          map,
          center: latLng,
          radius: acc,
          strokeColor: '#1a73e8',
          strokeOpacity: 0.8,
          strokeWeight: 1,
          fillColor: '#1a73e8',
          fillOpacity: 0.16,
          zIndex: 1500
        });
      } else {
        myLocationCircle.setCenter(latLng);
        myLocationCircle.setRadius(acc);
      }

      if (!myLocationFirstFix) {
        map.panTo(latLng);
        myLocationFirstFix = true;
      }

      resolve();
    };

    const onError = (err) => {
      console.warn('Geolocation error:', err);
      reject(err);
    };

    myLocationWatchId = navigator.geolocation.watchPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      maximumAge: 10000,
      timeout: 15000
    });
  });
}

// 現在地ウォッチ停止
function stopMyLocation() {
  if (myLocationWatchId != null) {
    navigator.geolocation.clearWatch(myLocationWatchId);
    myLocationWatchId = null;
  }
  if (myLocationMarker) {
    myLocationMarker.setMap(null);
    myLocationMarker = null;
  }
  if (myLocationCircle) {
    myLocationCircle.setMap(null);
    myLocationCircle = null;
  }
  myLocationFirstFix = false;
}