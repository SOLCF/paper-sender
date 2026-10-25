'use strict';
// M5PaperS3 へ画像を送る。540x960・4bit グレーにして PackBits 圧縮、Web Bluetooth で転送。
// 受け側は F:\Claude\m5paper-calendar\src\image_rx.cpp

const VERSION = '1.0.2';
const W = 540, H = 960;
const SVC = '6b2f0000-3c1e-4f7a-9d2a-5e0c4a1b7d10';
const CTRL = '6b2f0001-3c1e-4f7a-9d2a-5e0c4a1b7d10';
const DATA = '6b2f0002-3c1e-4f7a-9d2a-5e0c4a1b7d10';
const ST = { IDLE: 0, RECEIVING: 1, SAVED: 2, ERROR: 3, DONE: 4 };

const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

let img = null;          // ImageBitmap
let rot = 0;             // 0..3（90度単位）
let scale = 1;
let panX = 0, panY = 0;  // 画面中心からのずれ（出力ピクセル）
let packed = null;       // 送る 4bit データ

$('ver').textContent = 'v' + VERSION;

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = cls;
}

// ---- 画像の配置 ----
function rotatedSize() {
  return rot % 2 ? [img.height, img.width] : [img.width, img.height];
}

function fit(kind) {
  const [rw, rh] = rotatedSize();
  scale = kind === 'cover' ? Math.max(W / rw, H / rh) : Math.min(W / rw, H / rh);
  panX = panY = 0;
  render();
}

function tone() {
  return document.querySelector('input[name=tone]:checked').value;
}

function render() {
  if (!img) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(W / 2 + panX, H / 2 + panY);
  ctx.rotate(rot * Math.PI / 2);
  ctx.scale(scale, scale);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // 端末と同じ見た目に量子化して、そのままプレビューに戻す
  const id = ctx.getImageData(0, 0, W, H);
  const px = id.data;
  const bw = tone() === 'bw';
  packed = new Uint8Array(W * H / 2);
  for (let i = 0, p = 0; p < W * H; ++p, i += 4) {
    const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const v = bw ? (l < 128 ? 0 : 15) : Math.round(l / 17);
    const g = v * 17;
    px[i] = px[i + 1] = px[i + 2] = g;
    if (p & 1) packed[p >> 1] |= v;
    else packed[p >> 1] = v << 4;
  }
  ctx.putImageData(id, 0, 0);
}

async function loadBlob(blob) {
  try {
    img = await createImageBitmap(blob);
  } catch (e) {
    setStatus('画像を読み込めませんでした', 'err');
    return;
  }
  rot = 0;
  $('empty').hidden = true;
  for (const id of ['rot', 'fitCover', 'fitContain', 'send']) $(id).disabled = false;
  fit('cover');
  setStatus('位置を合わせて「M5Paper に送る」を押してください。M5PaperS3 の電源ボタンを先に押しておきます。');
}

$('file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadBlob(f);
  e.target.value = '';
});
$('rot').addEventListener('click', () => { rot = (rot + 1) % 4; fit('cover'); });
$('fitCover').addEventListener('click', () => fit('cover'));
$('fitContain').addEventListener('click', () => fit('contain'));
for (const r of document.querySelectorAll('input[name=tone]')) r.addEventListener('change', render);

// ---- 指でずらす・2本指で拡大 ----
const pointers = new Map();
let gesture = null;

function gestureState() {
  const pts = [...pointers.values()];
  const k = W / canvas.clientWidth;  // CSS px → 出力 px
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length * k;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length * k;
  const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
  return { cx, cy, d, scale, panX, panY };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!img) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  gesture = gestureState();
});
canvas.addEventListener('pointermove', (e) => {
  if (!gesture || !pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  const g = gestureState();
  let f = 1;
  if (pointers.size > 1 && gesture.d > 0) f = g.d / gesture.d;
  scale = gesture.scale * f;
  // 2本指の中心を基準に拡大し、中心の移動分だけずらす
  const ox = gesture.cx - W / 2, oy = gesture.cy - H / 2;
  panX = ox + (gesture.panX - ox) * f + (g.cx - gesture.cx);
  panY = oy + (gesture.panY - oy) * f + (g.cy - gesture.cy);
  render();
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  gesture = pointers.size ? gestureState() : null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// ---- 圧縮（PackBits）----
function packBits(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    // 同じ値の連続
    let run = 1;
    while (i + run < n && run < 129 && src[i + run] === src[i]) ++run;
    if (run >= 2) {
      out.push(run + 126, src[i]);
      i += run;
      continue;
    }
    // 連続しない部分をまとめてそのまま
    let start = i;
    let len = 0;
    while (i < n && len < 128) {
      if (i + 1 < n && src[i + 1] === src[i]) break;
      ++i; ++len;
    }
    out.push(len - 1);
    for (let j = start; j < start + len; ++j) out.push(src[j]);
  }
  return new Uint8Array(out);
}

// ---- 送信 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readCtrl(ch) {
  const v = await ch.readValue();
  return { mtu: v.getUint16(0, true), state: v.getUint8(2), received: v.getUint32(4, true) };
}

async function send() {
  if (!navigator.bluetooth) {
    setStatus('この画面では Bluetooth が使えません。Android の Chrome で開いてください。', 'err');
    return;
  }
  const data = packBits(packed);
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }] });
  } catch (e) {
    setStatus('M5Paper が見つかりませんでした。電源ボタンを押してから、もう一度送ってください。', 'err');
    return;
  }
  $('send').disabled = true;
  $('prog').hidden = false;
  $('prog').value = 0;
  try {
    setStatus('接続しています…');
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    const ctrl = await svc.getCharacteristic(CTRL);
    const dataCh = await svc.getCharacteristic(DATA);

    // MTU が広がるのを少し待つ
    let info = await readCtrl(ctrl);
    for (let t = 0; t < 10 && info.mtu <= 23; ++t) {
      await sleep(150);
      info = await readCtrl(ctrl);
    }
    // 1回の書き込みは MTU-3 かつ 512 バイトまで（先頭4バイトは offset）
    const chunk = Math.max(16, Math.min(info.mtu - 3, 512) - 4);

    await ctrl.writeValueWithResponse(new Uint8Array([0x53]));  // 'S'
    const t0 = performance.now();
    let n = 0;
    for (let off = 0; off < data.length; off += chunk) {
      const part = data.subarray(off, Math.min(off + chunk, data.length));
      const pkt = new Uint8Array(4 + part.length);
      new DataView(pkt.buffer).setUint32(0, off, true);
      pkt.set(part, 4);
      await dataCh.writeValueWithoutResponse(pkt);
      // ときどき読み出して、取りこぼしがないか確かめる（送りすぎ防止も兼ねる）
      if (++n % 16 === 0) {
        const s = await readCtrl(ctrl);
        if (s.state !== ST.RECEIVING || s.received !== off + part.length) throw new Error('転送が途中で崩れました');
      }
      $('prog').value = (off + part.length) / data.length;
      setStatus(`送信中… ${Math.round((off + part.length) / 1024)} / ${Math.round(data.length / 1024)} KB`);
    }
    await ctrl.writeValueWithResponse(new Uint8Array([0x45]));  // 'E'

    setStatus('M5Paper で保存しています…');
    let s;
    for (let t = 0; t < 50; ++t) {
      s = await readCtrl(ctrl);
      if (s.state === ST.SAVED || s.state === ST.ERROR) break;
      await sleep(200);
    }
    if (s.state !== ST.SAVED) throw new Error('M5Paper 側で保存できませんでした');
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`送りました（${Math.round(data.length / 1024)} KB・${sec} 秒）。M5Paper に表示されます。`, 'ok');
  } catch (e) {
    setStatus('送れませんでした: ' + e.message + '。電源ボタンを押し直してもう一度試してください。', 'err');
  } finally {
    try { device.gatt.disconnect(); } catch (e) {}
    $('send').disabled = false;
    $('prog').hidden = true;
  }
}
$('send').addEventListener('click', send);

// ---- 共有から開かれたとき ----
async function loadShared() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  const cache = await caches.open('share');
  const res = await cache.match('shared-image');
  if (res) {
    await loadBlob(await res.blob());
    await cache.delete('shared-image');
  }
}

if ('serviceWorker' in navigator) {
  // 新しい版が入ったら読み込み直す（初回インストール時は除く）
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !img) location.reload();
  });
  navigator.serviceWorker.register('sw.js');
}
loadShared();
