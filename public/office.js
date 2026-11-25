import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// 席の配置と色。色は roster.json と揃える(roster.json は public/ の外なので配信されない)
const DEPTS = [
  // sign は部署名を掲げる壁の位置。床に置くと名札と重なるため、壁の高い所に掛ける
  { name: '会議テーブル', color: '#e9b35a', rug: '#fbe7c6', x: 0, z: 0.4, w: 6.4, d: 5.6, round: true, sign: [0, 4.35, -7.3] },
  { name: '制作部', color: '#6fb3e0', rug: '#d6ebf8', x: -7.5, z: -3.4, w: 7.8, d: 4.6, sign: [-7.5, 4.6, -7.3] },
  { name: '検証部', color: '#5fbf7d', rug: '#d9f1df', x: 6.9, z: -4.05, w: 10.2, d: 7.1, sign: [6.9, 4.6, -7.3] },
  // 開発部・調査部は、会議テーブルの左右の空き(机の列の手前)に置く。部署札は左の壁の高い所/右の床
  { name: '開発部', color: '#ee8f7a', rug: '#fbe0d9', x: -7.3, z: 1.3, w: 8.4, d: 3.0, sign: [-12.3, 4.6, 1.2] },
  { name: 'SNS部', color: '#7fd0d8', rug: '#d8f3f5', x: -8.8, z: 4.3, w: 4.6, d: 2.3, sign: [-8.8, 0.3, 5.6] },
  { name: '調査部', color: '#4fb8c4', rug: '#d6f0f3', x: 7.0, z: 1.3, w: 6.2, d: 3.0, sign: [10.9, 0.3, 1.0] },
  // 環境影響チェック部・アクセス審査部は手前の空き(会議テーブルの左前、会議室の右)に置く。机は各1席(将来は同じ列に足せる)
  { name: '環境影響チェック部', color: '#8fd0c0', rug: '#dcf3ed', x: -2.8, z: 4.55, w: 3.8, d: 2.1, sign: [-2.8, 0.3, 7.1] },
  { name: 'アクセス審査部', color: '#e0b070', rug: '#f8ead2', x: 11.05, z: 4.5, w: 2.7, d: 2.1, sign: [12.2, 0.3, 7.1] },
];
// 社長室(ガラスで仕切った小部屋)。奥の壁の中央、会議テーブルの真後ろ(制作部と検証部のあいだの空き)に置く。
// 床を広げず、既存の机・名札・カメラ範囲(VIEW_W/VIEW_H)に影響しない。部長は机の列と会議テーブルのあいだから入口へ歩く
const PR = {
  box: { x0: -3.4, x1: 2.0, z0: -7.4, z1: -2.2 },
  door: { wall: 'z1', from: -1.6, to: -0.2 }, // 手前の壁の入口(壁に沿った座標)
  seat: { x: 0.4, z: -6.0 },
  stand: { x: -1.7, z: -4.6 }, // 部長が質問するときの立ち位置
  signAt: [-0.7, 4.6, -7.3], // 部署札と同じく奥の壁の高い所に掛ける
  way: [{ x: -0.9, z: -1.4 }, { x: -0.9, z: -3.2 }], // 席を出て入口へ
};
// 会議テーブルの札は奥の壁だと社長室の真上になるため、テーブルの左の床へ移す
DEPTS[0].sign = [-4.0, 0.3, 0.0];
const SEATS = {
  bucho: { x: 0, z: -0.7, color: '#f2c879', hair: '#5b4636', table: true },
  'report-writer': { x: -9.4, z: -3.9, color: '#8fc7e8', hair: '#3f3530' },
  'video-producer': { x: -5.6, z: -3.9, color: '#b6a4e6', hair: '#7a5236', lift: 1.4 },
  'numbers-checker': { x: 3.4, z: -3.9, color: '#9bd8a8', hair: '#2f2a2a' },
  'domain-reviewer': { x: 6.9, z: -3.9, color: '#f0a6a6', hair: '#8a5a3b', lift: 1.4 },
  'cost-auditor': { x: 10.4, z: -3.9, color: '#e8c0e0', hair: '#4a3a52' },
  // 開発部・調査部の席(seat ID は名簿しだい。dept の並び順で dev-N / research-N に割り当てる)
  'dev-1': { x: -10.3, z: 1.0, color: '#f4a58f', hair: '#4a3a30', bdx: -40 },
  'dev-2': { x: -7.3, z: 1.0, color: '#f7b79f', hair: '#3a3333', lift: 2.0 },
  'dev-3': { x: -4.3, z: 1.0, color: '#ee9a86', hair: '#6b4a33', bdx: 40 },
  'research-1': { x: 5.3, z: 1.0, color: '#7fd0d6', hair: '#2f2a2a', bdx: -30 },
  'research-2': { x: 8.5, z: 1.0, color: '#9ad9c9', hair: '#56483d', lift: 2.0, bdx: 30 },
  // 検証部の増員4席(後列は手前の机のすき間の真後ろ、手前列は通路ぎわ。経路は straight=その場から通路へ直進)
  'privacy-checker': { x: 8.65, z: -6.45, color: '#a9c4f0', hair: '#2f2a2a', lift: 1.4, straight: true },
  'deliverable-reviewer': { x: 2.9, z: -1.6, color: '#f2d49b', hair: '#56483d', straight: true, tagZ: 1.15 },
  'compliance-checker': { x: 11.0, z: -1.6, color: '#c9e3a0', hair: '#3f3530', straight: true, tagZ: 1.15, tagX: -1.7 },
  'sns-writer': { x: -8.8, z: 3.2, color: '#7fd0d8', hair: '#3a3333', straight: true, tagZ: 1.7 }, // SNS部(左手前の空き)
  'pc-impact-checker': { x: -2.8, z: 3.6, color: '#8fd0c0', hair: '#4a3a30', tagZ: 1.7 }, // 環境影響チェック部(会議テーブルの左前)
  'access-auditor': { x: 11.05, z: 3.6, color: '#e0b070', hair: '#3a3333', tagZ: 1.7 }, // アクセス審査部(会議室の右)
  president: { x: PR.seat.x, z: PR.seat.z, color: '#7f8fb0', hair: '#2f2a2a', lift: 0.3 },
};
const DONE_SHOW_MS = 4000;
const QUIET_MS = 8000;
const FEED_MAX = 50;
// ダイオラマを斜め上から見たときの画面上の広さ(ワールド単位)。重ね表示を避けた空き領域に収める
const VIEW_W = 28.5;
const VIEW_H = 13.6;
const mobileMq = window.matchMedia('(max-width: 760px)'); // スマホは縦に並べる配置(CSSと同じ境界)
const AZIMUTH = THREE.MathUtils.degToRad(28);
const ELEVATION = THREE.MathUtils.degToRad(35);

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---------- 3D の土台 ----------
const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
stage.appendChild(renderer.domElement);

const labels = new CSS2DRenderer();
labels.sortObjects = false; // 吹き出しを名札より手前に出すため z-index は自前で付ける
Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
stage.appendChild(labels.domElement);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
const target = new THREE.Vector3(0, 2.4, -0.5);
camera.position.set(
  target.x + Math.sin(AZIMUTH) * Math.cos(ELEVATION) * 60,
  target.y + Math.sin(ELEVATION) * 60,
  target.z + Math.cos(AZIMUTH) * Math.cos(ELEVATION) * 60,
);
camera.lookAt(target);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(target);
controls.enablePan = false;
controls.enableDamping = true;
controls.minAzimuthAngle = AZIMUTH - 0.45;
controls.maxAzimuthAngle = AZIMUTH + 0.45;
controls.minPolarAngle = Math.PI / 2 - ELEVATION - 0.25;
controls.maxPolarAngle = Math.PI / 2 - ELEVATION + 0.2;
controls.minZoom = 0.8;
controls.maxZoom = 2.6;
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0xe9dccb, 2.1));
const sun = new THREE.DirectionalLight(0xfff4e6, 2.2);
sun.position.set(9, 20, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 16, bottom: -16, near: 1, far: 60 });
sun.shadow.bias = -0.0008;
sun.shadow.radius = 4;
scene.add(sun);

const matCache = new Map();
const mat = (color, extra = {}) => {
  const key = color + JSON.stringify(extra);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, ...extra }));
  return matCache.get(key);
};
function mesh(geo, material, x = 0, y = 0, z = 0, parent = scene) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// ---------- 部屋 ----------
const ROOM = { x0: -12.5, x1: 12.5, z0: -7.5, z1: 5.6 };
const roomW = ROOM.x1 - ROOM.x0;
const roomD = ROOM.z1 - ROOM.z0;
const roomCx = (ROOM.x0 + ROOM.x1) / 2;
const roomCz = (ROOM.z0 + ROOM.z1) / 2;
mesh(box(roomW + 0.6, 0.7, roomD + 0.6), mat('#e8d6c3'), roomCx, -0.36, roomCz);
const floor = mesh(box(roomW, 0.05, roomD), mat('#f7eee3'), roomCx, 0, roomCz);
floor.castShadow = false;
for (let i = 1; i < roomW / 2.5; i++) {
  mesh(box(0.03, 0.06, roomD), mat('#efe2d3'), ROOM.x0 + i * 2.5, 0.005, roomCz).castShadow = false;
}
mesh(box(roomW + 0.6, 5, 0.35), mat('#fbf6ef'), roomCx, 2.5, ROOM.z0 - 0.15);
mesh(box(0.35, 5, roomD + 0.3), mat('#f6efe7'), ROOM.x0 - 0.15, 2.5, roomCz - 0.15);
mesh(box(roomW + 0.6, 0.35, 0.4), mat('#e9d9c6'), roomCx, 0.17, ROOM.z0 + 0.05);
mesh(box(0.4, 0.35, roomD), mat('#e9d9c6'), ROOM.x0 + 0.05, 0.17, roomCz);

for (const wx of [-9.4, -5, 5, 9.4]) {
  mesh(box(3.4, 2.1, 0.1), mat('#ffffff'), wx, 2.8, ROOM.z0 + 0.06);
  mesh(box(3.0, 1.75, 0.1), mat('#cfe7f6', { emissive: '#bfe0f5', emissiveIntensity: 0.25 }), wx, 2.8, ROOM.z0 + 0.1);
  mesh(box(0.08, 1.75, 0.12), mat('#ffffff'), wx, 2.8, ROOM.z0 + 0.12);
}
for (const wz of [-2.5, 4]) {
  mesh(box(0.1, 2.3, 3.4), mat('#ffffff'), ROOM.x0 + 0.06, 3, wz);
  mesh(box(0.1, 1.95, 3.0), mat('#cfe7f6', { emissive: '#bfe0f5', emissiveIntensity: 0.25 }), ROOM.x0 + 0.1, 3, wz);
}
// 時計
const clockFace = mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.1, 20), mat('#ffffff'), 2.75, 3.3, ROOM.z0 + 0.1);
clockFace.rotation.x = Math.PI / 2;
const clockRim = mesh(new THREE.TorusGeometry(0.55, 0.06, 6, 20), mat('#e9b35a'), 2.75, 3.3, ROOM.z0 + 0.14);
clockRim.castShadow = false;
const hand = mesh(box(0.05, 0.38, 0.03), mat('#4a4458'), 2.75, 3.3, ROOM.z0 + 0.18);
hand.geometry.translate(0, 0.15, 0);

function plant(x, z, s = 1) {
  mesh(new THREE.CylinderGeometry(0.38 * s, 0.3 * s, 0.6 * s, 8), mat('#e7a98c'), x, 0.3 * s, z);
  mesh(new THREE.IcosahedronGeometry(0.62 * s, 0), mat('#8fcf9a'), x, 1.05 * s, z);
  mesh(new THREE.IcosahedronGeometry(0.45 * s, 0), mat('#a6dcae'), x + 0.25 * s, 1.5 * s, z + 0.1);
}
plant(ROOM.x0 + 0.9, ROOM.z0 + 0.9, 1.2);
plant(ROOM.x1 - 0.8, ROOM.z0 + 0.9, 1);
plant(ROOM.x0 + 0.9, ROOM.z1 - 0.9, 1);
plant(-2.9, ROOM.z0 + 0.8, 0.8);

// 本棚(左の壁ぎわ)
const shelf = new THREE.Group();
shelf.position.set(ROOM.x0 + 0.55, 0, 4.2); // 開発部の席(z=1付近)と重ならない手前へ置く
scene.add(shelf);
mesh(box(0.8, 2.6, 2.6), mat('#e3c9a8'), 0, 1.3, 0, shelf);
const bookColors = ['#8fc7e8', '#f0a6a6', '#9bd8a8', '#f2c879', '#b6a4e6', '#e8c0e0'];
for (let r = 0; r < 3; r++) {
  for (let i = 0; i < 6; i++) {
    const h = 0.45 + ((i * 7 + r * 3) % 4) * 0.06;
    mesh(box(0.55, h, 0.28), mat(bookColors[(i + r) % 6]), 0.12, 0.35 + r * 0.82 + h / 2, -1.0 + i * 0.36, shelf);
  }
}
// ホワイトボード(会議テーブルの後ろ)
mesh(box(3.6, 1.9, 0.12), mat('#ffffff'), 0, 2.4, ROOM.z0 + 0.25);
mesh(box(3.8, 0.12, 0.25), mat('#c9b8a4'), 0, 1.4, ROOM.z0 + 0.3);
for (const [w, y, c] of [[2.2, 2.9, '#8fc7e8'], [1.6, 2.5, '#f0a6a6'], [2.6, 2.1, '#9bd8a8']]) {
  mesh(box(w, 0.08, 0.02), mat(c), -1.6 + w / 2 + 0.2, y, ROOM.z0 + 0.32).castShadow = false;
}

// ---------- 部署の島 ----------
for (const d of DEPTS) {
  const rug = d.round
    ? mesh(new THREE.CylinderGeometry(d.w / 2, d.w / 2, 0.04, 40), mat(d.rug), d.x, 0.04, d.z)
    : mesh(box(d.w, 0.04, d.d), mat(d.rug), d.x, 0.04, d.z);
  rug.castShadow = false;
  const tag = el('div', 'dept', d.name);
  tag.style.setProperty('--c', d.color);
  const o = new CSS2DObject(tag);
  o.position.set(...d.sign);
  tag.style.zIndex = 58; // 名札(50〜55)の下に隠れて部署名が読めなくならないよう、名札より上
  scene.add(o);
}

// 会議テーブル
mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.14, 24), mat('#f3dcb5'), 0, 1.0, 0.6);
mesh(new THREE.CylinderGeometry(0.25, 0.4, 0.95, 10), mat('#d8bd96'), 0, 0.48, 0.6);
for (const [x, z, r] of [[-1.15, 1.9, 0.6], [0.5, 1.5, -0.3], [-0.6, 0.3, 0.2]]) {
  mesh(box(0.55, 0.03, 0.75), mat('#ffffff'), x, 1.09, z).rotation.y = r;
}
mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.25, 10), mat('#f0a6a6'), 1.0, 1.2, 0.9);
function chair(x, z, rot, color, parent = scene) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rot;
  parent.add(g);
  mesh(box(0.95, 0.16, 0.9), mat(color), 0, 0.58, 0, g);
  mesh(box(0.95, 0.85, 0.15), mat(color), 0, 1.05, -0.42, g);
  mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 6), mat('#b8adc4'), 0, 0.27, 0, g);
  mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 8), mat('#b8adc4'), 0, 0.03, 0, g);
  return g;
}
chair(-2.05, 0.9, Math.PI / 2 + 0.2, '#f6d9a8');
chair(2.05, 0.9, -Math.PI / 2 - 0.2, '#f6d9a8');

// ---------- 人形と机 ----------
const SKIN = '#ffe1c9';
const avatars = new Map();

function buildSeat(seatId, cfg) {
  const root = new THREE.Group();
  root.position.set(cfg.x, 0, cfg.z);
  scene.add(root);
  const tint = new THREE.Color(cfg.color);
  const chairColor = '#' + tint.clone().lerp(new THREE.Color('#ffffff'), 0.35).getHexString();
  chair(0, 0, 0, chairColor, root);

  let laptopBack = null;
  if (!cfg.table) {
    const desk = new THREE.Group();
    desk.position.set(0, 0, 0.95);
    root.add(desk);
    mesh(box(2.1, 0.12, 1.0), mat('#f3e3cc'), 0, 1.0, 0, desk);
    mesh(box(2.0, 0.9, 0.08), mat('#ead6bb'), 0, 0.5, 0.42, desk);
    for (const sx of [-0.98, 0.98]) mesh(box(0.1, 0.95, 0.9), mat('#e2ccb0'), sx, 0.48, 0, desk);
    mesh(box(0.75, 0.04, 0.5), mat('#d9d4e2'), 0, 1.08, -0.05, desk);
    laptopBack = mesh(box(0.75, 0.5, 0.04), new THREE.MeshStandardMaterial({ color: '#e6e1ee', roughness: 0.6, flatShading: true }), 0, 1.32, 0.2, desk);
    laptopBack.rotation.x = -0.25;
    const mugColor = bookColors[Math.abs(seatId.length * 7) % bookColors.length];
    mesh(new THREE.CylinderGeometry(0.11, 0.1, 0.22, 10), mat(mugColor), 0.72, 1.17, 0.1, desk);
    mesh(box(0.42, 0.03, 0.56), mat('#ffffff'), -0.68, 1.07, 0.05, desk).rotation.y = 0.25;
  } else {
    const lap = new THREE.Group();
    lap.position.set(0, 0, 0.55);
    root.add(lap);
    mesh(box(0.75, 0.04, 0.5), mat('#d9d4e2'), 0, 1.1, 0, lap);
    laptopBack = mesh(box(0.75, 0.5, 0.04), new THREE.MeshStandardMaterial({ color: '#e6e1ee', roughness: 0.6, flatShading: true }), 0, 1.36, 0.24, lap);
    laptopBack.rotation.x = -0.25;
  }

  const body = new THREE.Group();
  root.add(body);
  mesh(new THREE.CylinderGeometry(0.3, 0.42, 0.75, 10), mat(cfg.color), 0, 1.0, 0, body);
  mesh(new THREE.SphereGeometry(0.42, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mat(cfg.color), 0, 1.36, 0, body).scale.y = 0.35;
  const head = new THREE.Group();
  head.position.set(0, 1.82, 0);
  body.add(head);
  mesh(new THREE.SphereGeometry(0.38, 14, 10), mat(SKIN), 0, 0, 0, head);
  const hair = mesh(new THREE.SphereGeometry(0.41, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.1), mat(cfg.hair), 0, 0.04, -0.04, head);
  hair.rotation.x = -0.35;
  for (const sx of [-0.13, 0.13]) {
    mesh(new THREE.SphereGeometry(0.065, 8, 6), mat('#3b3340'), sx, -0.03, 0.34, head).castShadow = false;
    const cheek = mesh(new THREE.SphereGeometry(0.07, 8, 6), mat('#ffb7c2'), sx * 1.7, -0.12, 0.3, head);
    cheek.scale.set(1, 0.6, 0.4);
    cheek.castShadow = false;
  }
  const smile = mesh(new THREE.TorusGeometry(0.07, 0.018, 4, 10, Math.PI), mat('#c96b7a'), 0, -0.13, 0.36, head);
  smile.rotation.z = Math.PI;
  smile.castShadow = false;
  if (seatId === 'president') {
    mesh(box(0.1, 0.45, 0.05), mat('#b5483f'), 0, 1.12, 0.36, body).rotation.x = -0.18;
  }
  if (seatId === 'bucho') {
    mesh(box(0.1, 0.4, 0.05), mat('#5a6fb0'), 0, 1.12, 0.36, body).rotation.x = -0.18;
    mesh(new THREE.TorusGeometry(0.2, 0.05, 6, 16), mat('#f2c879', { metalness: 0.3 }), 0, 0.43, -0.02, head).rotation.x = Math.PI / 2;
  }
  const arms = [-1, 1].map((sx) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.4, 1.2, 0.05);
    body.add(pivot);
    mesh(box(0.16, 0.16, 0.6), mat(cfg.color), 0, -0.12, 0.28, pivot);
    mesh(new THREE.SphereGeometry(0.1, 8, 6), mat(SKIN), 0, -0.12, 0.6, pivot);
    pivot.rotation.x = 0.35;
    return pivot;
  });

  // 吹き出し(頭の上)
  const bubbleWrap = el('div', 'bubble-anchor');
  bubbleWrap.style.zIndex = 100;
  const bubbleObj = new CSS2DObject(bubbleWrap);
  bubbleObj.center.set(0.5, 1);
  bubbleObj.position.set(0, 2.55 + (cfg.lift ?? 0), 0);
  body.add(bubbleObj);

  // 名札(机の前の床)
  const tag = el('div', 'tag');
  tag.style.setProperty('--c', cfg.color);
  const name = el('span', 'n');
  const tok = el('span', 'tok');
  const role = el('span', 'r');
  const pg = el('span', 'pg');
  pg.hidden = true;
  const pgBar = el('i', 'pg-bar');
  const pgTxt = el('b', 'pg-pct');
  const pgNow = el('em', 'pg-now');
  pg.append(pgBar, pgTxt, pgNow);
  tag.append(name, role, tok, pg);
  tag.style.zIndex = 50;
  const tagObj = new CSS2DObject(tag);
  tagObj.position.set(cfg.tagX ?? 0, 0.1, cfg.tagZ ?? (cfg.table ? 2.95 : 1.85));
  root.add(tagObj);

  avatars.set(seatId, {
    cfg, root, body, head, arms, laptopBack, bubbleWrap, tagObj, name, role, tok, pg, pgBar, pgTxt, pgNow,
    phase: Math.random() * Math.PI * 2, stand: 0,
    shown: { kind: null, text: null },
  });
}
for (const [id, cfg] of Object.entries(SEATS)) buildSeat(id, cfg);
// 作業中の人の足元に、担当色の光の輪を出す(3D の中でパッと見で分かるように)
for (const [id, a] of avatars) {
  if (id === 'president') continue;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.4, 40), new THREE.MeshBasicMaterial({ color: a.cfg.color, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  ring.visible = false;
  a.body.add(ring);
  a.ring = ring;
}

// ---------- 社長室(ガラス壁の小部屋と、机に座る社長) ----------
const GLASS_H = 2.6;
const glassMat = new THREE.MeshStandardMaterial({ color: '#bfe0f5', transparent: true, opacity: 0.26, roughness: 0.15, depthWrite: false });
const frameMat = mat('#dbe7f4');
/** 壁に沿った [from, to] の隙間(入口)を空けて、ガラス板と枠を並べる */
function glassWall(axis, fixed, a, b, gap) {
  const spans = gap ? [[a, gap.from], [gap.to, b]] : [[a, b]];
  const at = (u, y) => (axis === 'x' ? [u, y, fixed] : [fixed, y, u]);
  const dims = (len, h, t) => (axis === 'x' ? box(len, h, t) : box(t, h, len));
  for (const [u0, u1] of spans) {
    const len = u1 - u0;
    const c = (u0 + u1) / 2;
    const pane = mesh(dims(len, GLASS_H - 0.2, 0.05), glassMat, ...at(c, GLASS_H / 2 + 0.05));
    pane.castShadow = false;
    pane.receiveShadow = false;
    pane.renderOrder = 2;
    mesh(dims(len, 0.1, 0.14), frameMat, ...at(c, GLASS_H)).castShadow = false;
    mesh(dims(len, 0.12, 0.14), frameMat, ...at(c, 0.08)).castShadow = false;
  }
  for (const u of new Set(spans.flat())) mesh(dims(0.14, GLASS_H, 0.14), frameMat, ...at(u, GLASS_H / 2)).castShadow = false;
}
function buildPresidentRoom() {
  const { x0, x1, z0, z1 } = PR.box;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const rug = mesh(box(x1 - x0, 0.04, z1 - z0), mat('#e3ecf8'), cx, 0.04, cz);
  rug.castShadow = false;
  const door = PR.door;
  glassWall('x', z1, x0, x1, door);
  glassWall('z', x0, z0, z1, null);
  glassWall('z', x1, z0, z1, null);
  plant(x1 - 0.7, z0 + 0.7, 0.9);
  plant(x1 - 0.7, z1 - 0.7, 0.8);
  const sign = el('div', 'dept', '社長室');
  sign.style.setProperty('--c', '#7f95c4');
  sign.style.zIndex = 58;
  const o = new CSS2DObject(sign);
  o.position.set(...PR.signAt);
  scene.add(o);
}
buildPresidentRoom();

// ---------- 会議室(ガラス壁の小部屋。レビューのとき部長と担当が集まる) ----------
// 会議テーブルの右前、調査部の机の手前の空きに置く(撮影で比べて決めた。理由は報告)
const MR = { x0: 2.4, x1: 9.6, z0: 3.7, z1: 5.5, door: { from: 2.8, to: 4.0 }, table: { x: 6.0, z: 4.6, w: 3.2, d: 0.8 } };
function buildMeetingRoom() {
  const { x0, x1, z0, z1, door, table } = MR;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  mesh(box(x1 - x0, 0.04, z1 - z0), mat('#efe6f8'), cx, 0.04, cz).castShadow = false;
  glassWall('x', z0, x0, x1, door); // 奥側(オフィス側)の壁に出入口
  glassWall('x', z1, x0, x1, null);
  glassWall('z', x0, z0, z1, null);
  glassWall('z', x1, z0, z1, null);
  mesh(box(table.w, 0.12, table.d), mat('#f3dcb5'), table.x, 1.0, table.z);
  mesh(box(0.3, 0.95, 0.3), mat('#d8bd96'), table.x, 0.48, table.z);
  for (const [x, z, r] of [[table.x - 0.8, table.z - 0.1, 0.2], [table.x + 0.6, table.z + 0.1, -0.3]]) {
    mesh(box(0.5, 0.03, 0.35), mat('#ffffff'), x, 1.08, z).rotation.y = r;
  }
  const sign = el('div', 'dept', '会議室');
  sign.style.setProperty('--c', '#9a7fe0');
  sign.style.zIndex = 58;
  sign.style.translate = '-22px 2px'; // 手前の担当の名札と重なりにくいよう少し左へ
  const o = new CSS2DObject(sign);
  o.position.set(x1 - 0.2, 0.3, z1 + 0.6);
  scene.add(o);
}
buildMeetingRoom();
{
  const p = avatars.get('president');
  p.name.textContent = '社長';
  p.role.textContent = '';
}

// ---------- 会議(社長から依頼を受けたとき、担当が会議テーブルへ集まる) ----------
const MEETING_MS = 3500;
const MEETING_MAX_MS = 10000; // 誰かが席に戻れず集まりきらなくても会議を終わらせる上限
const WALK_SPEED = 6; // ワールド単位/秒
const AISLE_Z = -1.8; // 机の列と会議テーブルの間の通路
const TAG_OUT = 1.0; // 会議中、名札を立ち位置よりテーブルの外側へ出す距離
const RING_RX = 6.4; // 会議の立ち位置は、テーブルを囲む横長の楕円(席にいる全員が集まっても重ならない)
const RING_RZ = 3.0;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TABLE = { x: DEPTS[0].x, z: 0.6 };
/** @typedef {{ x: number, z: number }} Pt */
// 楕円は角度が等間隔だと両端が混み合うので、円周の長さで等分した「度」(0-360)で位置を表す
const RING_N = 720;
const ringLen = [0];
for (let i = 1; i <= RING_N; i++) {
  const t0 = ((i - 1) / RING_N) * Math.PI * 2;
  const t1 = (i / RING_N) * Math.PI * 2;
  ringLen.push(ringLen[i - 1] + Math.hypot(RING_RX * (Math.sin(t1) - Math.sin(t0)), RING_RZ * (Math.cos(t1) - Math.cos(t0))));
}
/** @param {number} deg @returns {Pt} */
const ringPt = (deg) => {
  const want = ((((deg % 360) + 360) % 360) / 360) * ringLen[RING_N];
  let i = 1;
  while (i < RING_N && ringLen[i] < want) i++;
  const f = (want - ringLen[i - 1]) / Math.max(1e-9, ringLen[i] - ringLen[i - 1]);
  const t = (((i - 1 + f) / RING_N)) * Math.PI * 2;
  return { x: TABLE.x + RING_RX * Math.sin(t), z: TABLE.z + RING_RZ * Math.cos(t) };
};
/** @param {Pt} p */
const ringAngle = (p) => {
  const t = (Math.atan2((p.x - TABLE.x) / RING_RX, (p.z - TABLE.z) / RING_RZ) + Math.PI * 2) % (Math.PI * 2);
  const i = Math.min(RING_N, Math.round((t / (Math.PI * 2)) * RING_N));
  return (ringLen[i] / ringLen[RING_N]) * 360;
};
const AISLE_SEATS = new Set(['report-writer', 'video-producer', 'numbers-checker', 'domain-reviewer', 'cost-auditor', 'privacy-checker', 'deliverable-reviewer', 'compliance-checker', 'sns-writer']); // 奥の列(通路から回り込む)

// 席 -> 会議の立ち位置までの折れ線。奥の列は、隣の机との隙間から通路へ出る。それ以外の席は、椅子の後ろへ出てから円周へ向かう。
// 席にいる人は全員(開発部・調査部も)集まる
function planMeetingPaths() {
  const guests = [...avatars.entries()].filter(([id]) => id !== 'bucho' && id !== 'president');
  const step = 360 / (guests.length + 1);
  const slots = Array.from({ length: guests.length + 1 }, (_, j) => j * step);
  let far = 0; // 部長の向かい側(180度)に最も近い1つは部長用に空ける
  slots.forEach((v, i) => { if (Math.abs(v - 180) < Math.abs(slots[far] - 180)) far = i; });
  slots.splice(far, 1);
  const sideOf = (a) => a.cfg.x + (a.cfg.x < 0 ? 1.9 : -1.9);
  const entryOf = (id, a) => (AISLE_SEATS.has(id) ? { x: sideOf(a), z: AISLE_Z } : { x: a.cfg.x, z: a.cfg.z - 1.3 });
  // 円周上で追い越し・すれ違いが起きないよう、入口の角度の順に立ち位置を割り当てる
  const sorted = guests
    .map(([id, a]) => ({ id, a, ang: ringAngle(entryOf(id, a)) }))
    .sort((p, q) => p.ang - q.ang);
  sorted.forEach(({ id, a, ang }, i) => {
    /** @type {Pt[]} */
    const pts = [{ x: a.cfg.x, z: a.cfg.z }];
    const e = entryOf(id, a);
    if (AISLE_SEATS.has(id)) pts.push({ x: e.x, z: a.cfg.z }, e);
    else pts.push(e);
    pts.push(ringPt(ang));
    const goal = slots[i];
    const dir = goal >= ang ? 1 : -1;
    for (let d = ang + dir * 15; dir > 0 ? d < goal : d > goal; d += dir * 15) pts.push(ringPt(d));
    pts.push(ringPt(goal));
    setChain(avatars.get(id), pts, TABLE);
    avatars.get(id).tagOut = TAG_OUT + (i % 3) * 0.85; // 隣どうしの名札が重ならないよう、外側へ交互にずらす
  });
}
function setChain(a, pts, focus) {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
  Object.assign(a, { chain: pts, cum, len: cum[cum.length - 1], s: 0, sTarget: 0, facing: 0, focus });
}
planMeetingPaths();

// 部長が質問を持って社長室へ行く道。会議と同じ仕組み(折れ線に沿って歩く・名札が追従)で動かす。
// 机の列と会議テーブルのあいだの通路から回り込み、社長室の入口を通って社長の机の前へ
const SEAT_PRES = { x: PR.seat.x, z: PR.seat.z };
{
  const b = avatars.get('bucho');
  setChain(b, [{ x: b.cfg.x, z: b.cfg.z }, ...PR.way, { x: PR.stand.x, z: PR.stand.z }], SEAT_PRES);
}

// ---------- レビューを受ける担当が、部長の席の横へ歩いて見せに行く(会議と同じ折れ線・名札追従の仕組みを使う) ----------
// 指示を受ける担当が立つ、部長の席の周りの立ち位置(最大3人。4人目以降は歩かず表示のみ)
const RV_SLOTS = [{ x: -1.9, z: -1.0 }, { x: 1.9, z: -1.0 }, { x: 0.0, z: -2.0 }];
const BUCHO_SEAT = { x: SEATS.bucho.x, z: SEATS.bucho.z };
// 会議室(レビュー用のガラスの部屋)。会議テーブルの右前、研究席の手前の空きに置く(撮影で比べて決めた。理由は報告)
const MR_LANE_X = 3.4; // 会議テーブルと調査部の机のあいだを南へ下る通路
const MR_DOOR = { x: 3.4, z: 4.1 };
const MR_FOCUS = { x: MR.table.x, z: MR.table.z };
const MR_BUCHO = { x: 3.4, z: 4.9 };
const MR_SLOTS = [{ x: 5.2, z: 4.1 }, { x: 6.8, z: 4.1 }, { x: 6.0, z: 5.2 }]; // 会議室でレビューを受ける担当の立ち位置
const rvSlot = new Map(); // avatar id -> 立ち位置の番号(歩いている・待っている間だけ持つ)
let rvWanted = new Set(); // いま部長の席の横/会議室へ行くべき avatar id(最大3)
let roomFresh = false; // 画面を開き直したとき、すでにレビュー中なら部長は最初から会議室にいる
let lastDoneId = null; // 直近に完了した担当(対象が特定できないときの候補)
const ASSIGN_MS = 2500; // 指示を受ける間、部長の席の横に立つ時間
const ASSIGN_MAX_MS = 15000;
let lastDelegSeq = 0; // 画面が見た最新の委任番号(再接続・再読み込みでは歩かず、番号だけ合わせる)
const lastAssignAt = new Map(); // avatar id -> 最後に指示を受けに歩いた時刻
const asHold = new Map(); // 指示を受けに来る担当 avatar id -> { startedAt, arrivedAt }
const visiting = (id) => rvWanted.has(id); // レビューを受ける担当は、検証系(qa-tester など)だと作業中の表示でも会議室へ入る
const useChain = (a, c) => Object.assign(a, { chain: c.chain, cum: c.cum, len: c.len, focus: c.focus });
const chainOf = (pts, focus) => {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
  return { chain: pts, cum, len: cum[cum.length - 1], focus };
};
// 自席 -> 通路 までの共通の道(会議の経路と同じ。奥の列は隣の机の隙間から通路へ出る)
function toAisle(id, a) {
  const pts = [{ x: a.cfg.x, z: a.cfg.z }];
  if (a.cfg.straight) { pts.push({ x: a.cfg.x, z: AISLE_Z }); return pts; }
  const side = a.cfg.x + (a.cfg.x < 0 ? 1.9 : -1.9);
  if (AISLE_SEATS.has(id)) pts.push({ x: side, z: a.cfg.z }, { x: side, z: AISLE_Z });
  else pts.push({ x: a.cfg.x, z: a.cfg.z - 1.3 }, { x: a.cfg.x, z: AISLE_Z });
  return pts;
}
// 指示を受けに部長の席の横へ行く道
function seatChain(id, a, slot) {
  const pts = toAisle(id, a);
  if (Math.abs(slot.x - pts[pts.length - 1].x) > 0.01) pts.push({ x: slot.x, z: AISLE_Z });
  pts.push(slot);
  return chainOf(pts, BUCHO_SEAT);
}
// レビューのために会議室へ行く道(通路 -> 南へ下る通路 -> 会議室の出入口 -> 立ち位置)
function roomChain(id, a, slot) {
  const pts = toAisle(id, a);
  pts.push({ x: MR_LANE_X, z: AISLE_Z }, { x: MR_LANE_X, z: 3.4 }, { x: MR_DOOR.x, z: 3.4 }, MR_DOOR);
  if (slot.z > MR.table.z) pts.push({ x: 4.2, z: slot.z });
  pts.push(slot);
  return chainOf(pts, MR_FOCUS);
}
function buchoRoomChain() {
  const b = avatars.get('bucho');
  return chainOf([{ x: b.cfg.x, z: b.cfg.z }, { x: MR_LANE_X, z: b.cfg.z }, { x: MR_LANE_X, z: 3.4 }, { x: MR_DOOR.x, z: 3.4 }, MR_DOOR, MR_BUCHO], MR_FOCUS);
}
const reviewActive = () => !!current.reviewing;
// レビュー対象の担当を求める。レビュー中の案件カードの担当と、reviewing.target に合う担当。特定できなければ直近に完了した担当
function resolveReviewees() {
  const rv = current.reviewing;
  const ids = [];
  const add = (m) => { const id = m && aid(m.seat); if (id && id !== 'bucho' && id !== 'president' && avatars.get(id)?.chain && !ids.includes(id)) ids.push(id); };
  const byName = (n) => { const q = String(n ?? '').trim(); if (!q) return null; const ms = current.members.filter((m) => m.seat !== 'bucho' && (m.nickname === q || seatRole(m) === q || m.name === q)); return ms.find((m) => m.status !== 'idle') ?? ms[0] ?? null; };
  for (const c of current.board) if (c.status === 'reviewing' || c.column === 'reviewing') add(byName(c.owner));
  if (rv) {
    const t = String(rv.target ?? '');
    const hit = current.members.find((m) => m.seat !== 'bucho' && [seatNick(m), seatRole(m), m.name].some((n) => n && t.includes(n)));
    add(hit);
    if (!ids.length && lastDoneId) add(current.members.find((m) => aid(m.seat) === lastDoneId));
  }
  return rv || ids.length ? ids : [];
}
function updateReview(fresh) {
  const want = reviewActive() ? resolveReviewees() : []; // 会議室に入るのは reviewing が入ったときだけ(案件カードだけでは入らない)
  const next = new Set();
  const roomIds = new Set();
  for (const id of want) {
    const a = avatars.get(id);
    if (!rvSlot.has(id)) {
      const used = new Set([...rvSlot].filter(([k]) => avatars.get(k)?.rvKind === 'room').map(([, v]) => v));
      const free = [0, 1, 2].find((i) => !used.has(i));
      if (free == null) continue; // 4人目以降は歩かず表示のみ
      rvSlot.set(id, free);
      a.rvC = roomChain(id, a, MR_SLOTS[free]);
      a.rvKind = 'room';
      if (fresh && a.s <= 0.01) a.rvStartFresh = true;
    }
    next.add(id); roomIds.add(id);
  }
  // 指示を受ける担当(部長が会議室にいる間は、戻ってから)
  if (!reviewActive()) {
    for (const id of asHold.keys()) {
      if (roomIds.has(id)) continue; // レビューを優先
      const a = avatars.get(id);
      if (!rvSlot.has(id)) {
        const used = new Set([...rvSlot].filter(([k]) => avatars.get(k)?.rvKind === 'seat').map(([, v]) => v));
        const free = [0, 1, 2].find((i) => !used.has(i));
        if (free == null) continue;
        rvSlot.set(id, free);
        a.rvC = seatChain(id, a, RV_SLOTS[free]);
        a.rvKind = 'seat';
      }
      next.add(id);
    }
  }
  rvWanted = next;
}

/** @type {{ until: number, released: Set<string>, delegated: boolean, gathered: boolean } | null} */
let meeting = null;
// 指示で全員が会議テーブルに集まる動きはやめた(委任された担当だけが部長の席へ来る)。会議の状態は常に無し
const newMeeting = () => null;
const asking = () => (current.decisions ?? []).some((d) => d?.status === 'pending');
const meetingOn = () => meeting != null && Date.now() < meeting.until;
const instructing = () => meetingOn() && !meeting.delegated;

// 新しい指示が始まったとき、会議より先に部長が社長室へ指示を聞きに行く。
// phase: walk(歩いて向かう)-> listen(社長の前で聞く)-> back(席へ戻る)。戻ったら、必要なら会議を始める
const HEAR_MS = 2800;
const HEAR_MAX_MS = 25000;
/** @type {{ phase: 'walk' | 'listen' | 'back', until: number, text: string, delegated: boolean, startedAt: number } | null} */
let hearing = null;
// 部長の stop(作業完了)で、社長室へ報告に行く動き。walk -> listen(社長がうなずく約3秒)-> back
const REPORT_MS = 3000;
const REPORT_MAX_MS = 25000;
/** @type {{ phase: 'walk' | 'listen' | 'back', until: number, text: string, startedAt: number } | null} */
let reporting = null;
const clipHead = (t, n = 24) => { const u = [...String(t ?? '').replace(/\s+/g, ' ').trim()]; return u.length > n ? `${u.slice(0, n).join('')}…` : u.join(''); };

// ---------- 画面サイズと視点 ----------
const LABEL_PAD = 30;
function layout() {
  const mobile = mobileMq.matches;
  // スマホは画面上部の固定枠(#stage)いっぱいに、PC は全画面に描く
  const w = mobile ? stage.clientWidth : window.innerWidth;
  const h = mobile ? stage.clientHeight : window.innerHeight;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  controls.enablePan = mobile; // 指2本で動かして、一部を拡大して見られるように
  if (mobile) {
    const sm = Math.min(w / VIEW_W, h / VIEW_H);
    Object.assign(camera, { left: -w / 2 / sm, right: w / 2 / sm, top: h / 2 / sm, bottom: -h / 2 / sm });
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    return;
  }
  const hud = $('#hud').getBoundingClientRect();
  const board = $('#board').getBoundingClientRect();
  const feed = $('#feed').getBoundingClientRect();
  let x0 = hud.right + 6;
  let x1 = feed.left - 6;
  if (x1 - x0 < 360) { x0 = 0; x1 = w; }
  const y0 = board.bottom + 6;
  const ib = $('#inbox');
  // 部屋の下端の部署ラベル(アクセス審査部・会議室など)は床の外へ出るので、その分の余白を足す
  const y1 = (ib.hidden ? h - 4 : Math.min(h - 4, ib.getBoundingClientRect().top - 4)) - LABEL_PAD;
  const s = Math.min((x1 - x0) / VIEW_W, (y1 - y0) / VIEW_H);
  Object.assign(camera, { left: -w / 2 / s, right: w / 2 / s, top: h / 2 / s, bottom: -h / 2 / s });
  // 重ね表示に隠れない空き領域の中心へ、画面上の中心をずらす
  // 左の指示パネルの下に部屋の左の壁・床の端が潜りやすいので、右の余白(部屋の右奥は何も無い)があるぶんだけ右へ寄せる
  const bias = THREE.MathUtils.clamp((x1 - x0) / 2 / s - 14.5, 0, 2.2) * s;
  camera.setViewOffset(w, h, -((x0 + x1) / 2 + bias - w / 2), -((y0 + y1) / 2 - h / 2), w, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', layout);
mobileMq.addEventListener('change', layout);
layout();

// ---------- 状態 ----------
let current = { members: [], nicknames: {}, board: [], counters: { tools: 0, delegates: 0, startedAt: null }, log: [] };
let usage = null;
const seen = new Map(); // seat -> 前回の status
const doneUntil = new Map();
let lastFeedKey = null;
let bubbleSeq = 0;

// 役割名 -> 「ミナトくん」。部長のように愛称に役割が含まれるときは重ねない
const nickOf = (role) => current.nicknames?.[role] ?? role;
const labelOf = (role) => {
  const n = nickForRole(role);
  return n === role || n.includes(role) ? n : `${n}(${role})`;
};
// 席の ID -> 3D の人形の ID。名簿の席(制作部など)はそのまま。開発部・調査部は dept ごとに名簿の並び順で dev-N / research-N に座らせる
const deptKind = (d) => (/^(dev|開発)/.test(String(d ?? '')) ? 'dev' : /^(research|調査)/.test(String(d ?? '')) ? 'research' : null);
const slotMap = new Map();
function mapSeats(members) {
  slotMap.clear();
  const n = { dev: 0, research: 0 };
  for (const m of members) {
    if (avatars.has(m.seat)) continue;
    const k = deptKind(m.dept);
    if (k && n[k] < 5 && avatars.has(`${k}-${n[k] + 1}`)) slotMap.set(m.seat, `${k}-${++n[k]}`);
  }
}
const aid = (seat) => (avatars.has(seat) ? seat : slotMap.get(seat) ?? seat);
// 席の nickname。無い古い形は、役割名 -> 愛称の対応表(nicknames)に頼る
function seatNick(m) {
  return m.nickname || current.nicknames?.[m.name] || m.name;
}
const seatRole = (m) => m.role ?? m.name ?? '';
const countOf = (m) => (Number.isFinite(m?.count) && m.count > 1 ? Math.floor(m.count) : 1);
// ボード・通知は「役割名」で担当を指す。席の nickname で呼ぶため、その役割の担当(動いている席を優先)から引く
function nickForRole(role) {
  const ms = current.members.filter((m) => m.nickname === role || seatRole(m) === role || m.name === role);
  if (!ms.length) return nickOf(role);
  const exact = ms.find((m) => m.nickname === role);
  if (exact) return seatNick(exact);
  return seatNick(ms.find((m) => m.status !== 'idle') ?? ms[0]);
}
const STATUS_WORD = { working: '作業中', reviewing: 'レビュー中', waiting: '確認待ち', done: '完了' };
const colorOfSeat = (seat) => SEATS[aid(seat)]?.color ?? '#c9c1e0';
function colorOfName(name) {
  const ms = current.members.filter((x) => x.name === name || seatRole(x) === name || x.nickname === name);
  const m = ms.find((x) => x.status !== 'idle') ?? ms[0];
  return m ? colorOfSeat(m.seat) : '#c9c1e0';
}
const doneFrom = new Map(); // 完了のハートを全員同時に出さないよう、1人ずつ時間をずらして出す
let nextDoneAt = 0; // 次の完了を見せてよい時刻(全担当をまたいで1人ずつ)
const doneGap = () => (mobileMq.matches ? 2000 : 900);
const shownStatus = (m) => (m.status === 'done' && (Date.now() > (doneUntil.get(m.seat) ?? 0) || Date.now() < (doneFrom.get(m.seat) ?? 0)) ? 'idle' : m.status);

function applySnapshot(snap, fresh) {
  if (!snap) return;
  if (fresh) seen.clear();
  mapSeats(snap.members ?? []);
  for (const m of snap.members ?? []) {
    const prev = seen.get(m.seat);
    if (m.status === 'done' && prev?.status !== 'done') { let at = Date.now(); if (m.seat !== 'bucho') { at = Math.max(at, nextDoneAt); nextDoneAt = at + doneGap(); } doneFrom.set(m.seat, at); doneUntil.set(m.seat, at + DONE_SHOW_MS); if (m.seat !== 'bucho') lastDoneId = aid(m.seat); }
    seen.set(m.seat, { status: m.status });
  }
  current = { members: snap.members ?? [], nicknames: snap.nicknames ?? {}, board: snap.board ?? [], counters: snap.counters ?? {}, log: snap.log ?? [], quota: snap.quota ?? null, answers: Array.isArray(snap.answers) ? snap.answers.filter((x) => x && typeof x === 'object') : null, decisions: Array.isArray(snap.decisions) ? snap.decisions : [], instructions: Array.isArray(snap.instructions) ? snap.instructions.filter((x) => x && typeof x === 'object') : [], reviewing: snap.reviewing && typeof snap.reviewing === 'object' ? snap.reviewing : null, waiting: normWaiting(snap.waiting), activity: Array.isArray(snap.activity) ? snap.activity.filter((x) => x && typeof x === 'object').slice(0, 200) : null };
  if (snap.usage) usage = snap.usage;
  if (fresh && current.reviewing) roomFresh = true;
  updateReview(fresh);
  renderInbox(snap.inbox);
  renderInstructions(snap);
  renderAvatars();
  renderBoard();
  renderFeed(fresh);
  renderCounters();
  renderUsage();
  renderQuota();
  renderAnswers();
  renderWaitbar();
  renderDecision();
  renderActivity();
  if (asking()) {
    reporting = null; // 質問が最優先
    meeting = null; // 会議中でも質問が来たら会議を打ち切って社長室へ向かう
    hearing = null; // 質問と指示が同時なら質問を優先する
    const b = avatars.get('bucho');
    if (fresh && b.chain) b.s = b.len; // 画面を開き直したときは、歩かず最初から社長室にいる
  }
  renderPresident();
}

// ---------- 社長の指示(一覧。最新が上。instructions が無い古いサーバーは instruction 1件の表示) ----------
const IN_BADGE = { queued: '部長の受け取り待ち', assigning: '受付済み', working: '作業中', done: '作業完了' };
let inSig = '';
function renderInstructions(snap) {
  let list = Array.isArray(snap.instructions) ? snap.instructions.filter((x) => x && typeof x === 'object') : null;
  const one = snap.instruction && typeof snap.instruction === 'object' ? snap.instruction : null;
  if (!list) list = one ? [{ id: 'single', ...one }] : [];
  const rows = [...list].reverse(); // 最新を上に
  const curIdx = rows.findIndex((r) => r.status !== 'queued'); // 受け取り済みの最新が「現在の指示」(全文を出す)
  const sig = JSON.stringify([rows, one?.text, one?.ts, curIdx]);
  if (sig === inSig) return;
  inSig = sig;
  const waiting = rows.filter((r) => r.status === 'queued').length;
  const w = $('#in-wait');
  w.hidden = waiting === 0;
  w.textContent = `受け取り待ち ${waiting} 件`;
  const ul = $('#in-list');
  if (!rows.length) { ul.replaceChildren(el('li', 'in-empty', 'まだ指示はありません。ターミナルで部長に指示すると、ここに出ます')); return; }
  ul.replaceChildren(...rows.map((r, i) => {
    const cur = i === curIdx;
    const li = el('li', `in-item${cur ? ' cur' : ''}${r.status === 'done' ? ' done' : ''}`);
    li.dataset.s = IN_BADGE[r.status] ? r.status : 'working';
    const meta = el('div', 'in-meta');
    meta.append(el('span', 'in-badge', IN_BADGE[r.status] ?? '作業中'), el('span', '', `${fmtTime(r.ts)} ${r.source === 'office' ? '画面から' : 'ターミナル'}`.trim()));
    let text = String(r.text ?? '');
    if (cur && one?.text && (one.ts === r.ts || list.length === 1)) text = one.text;
    else text = [...text].slice(0, 100).join('');
    li.append(meta, el('p', 'in-text', text));
    return li;
  }));
}

// ---------- 部長への指示入力(待ち受け方式。inbox が無い・canSend が false なら出さない) ----------
const ibForm = $('#inbox');
const ibText = $('#ib-text');
const ibSend = $('#ib-send');
const ibError = $('#ib-error');
let ibBusy = false;
let ibInfo = null;
const IB_ERRORS = {
  400: '送れませんでした。空か長すぎます',
  403: 'この画面からは送れません',
  413: '文章が長すぎます。短くしてください',
  415: '送れませんでした(形式エラー)',
  429: '部長が受け取り待ちの指示がいっぱいです。しばらくしてからもう一度送ってください',
};
function renderInbox(inbox) {
  ibInfo = inbox && typeof inbox === 'object' ? inbox : null;
  const pcShow = !!ibInfo && ibInfo.canSend === true && !mobileMq.matches;
  const instrOnly = !!ibInfo && ibInfo.canSend !== true && ibInfo.canInstruct === true; // 遠隔(スマホ)は指示の送信だけ。判断カード・コマンド等は出さない
  const show = pcShow || instrOnly;
  const was = !ibForm.hidden;
  ibForm.hidden = !show;
  ibForm.classList.toggle('instr-only', instrOnly);
  $('#ib-mnote').hidden = !instrOnly;
  ibText.placeholder = instrOnly ? '部長への指示を入力' : '部長への指示を入力(Enterで送信・Shift+Enterで改行)';
  if (show) {
    const st = $('#ib-status');
    st.className = `ib-status${ibInfo.listening ? ' on' : ''}`;
    const msg = ibInfo.listening ? '部長は待ち受け中' : '部長は今、指示を受け付けていません';
    st.innerHTML = '<i></i><span></span>';
    st.querySelector('span').textContent = msg;
    if (!ibInfo.listening) {
      const how = '指示を送るには、ターミナルで部長の待ち受けを開始してください(wait-instruction)。待ち受け中は「部長は待ち受け中」に変わります';
      const h = el('button', 'ib-help', '?');
      h.type = 'button'; h.title = how; h.setAttribute('aria-label', `説明: ${how}`);
      const note = el('span', 'ib-howto', how); note.hidden = true;
      h.addEventListener('click', () => { note.hidden = !note.hidden; });
      st.append(h, note);
    }
    if (ibInfo.pending > 0) st.append(el('span', 'sent', `送信済み(部長の受け取り待ち ${ibInfo.pending} 件)`));
  }
  if (show !== was) layout();
}
function ibShowError(msg) { ibError.textContent = msg; ibError.hidden = !msg; layout(); }
function ibResize() {
  ibText.style.height = 'auto';
  const lh = parseFloat(getComputedStyle(ibText).lineHeight) || 21;
  ibText.style.height = `${Math.min(ibText.scrollHeight, lh * 3 + 10)}px`;
  layout();
}
async function ibSubmit() {
  if (micState !== 'idle' && srRec) { vdbg('送る(録音中)'); srSendAfterStop = true; srStop(true); return; } // 録音中は即止めて、仮表示を取り込んだ文字をその場で送る
  const text = ibText.value;
  if (ibBusy || micState !== 'idle' || !text.trim()) return; // 起動中は送らない
  ibBusy = true; ibSend.disabled = true; ibShowError('');
  try {
    const r = await fetch('/instruction', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (r.status === 202) { ibText.value = ''; ibResize(); }
    else if (r.status === 403 && ibInfo?.canInstruct === true) ibShowError('合言葉が切れました。PCのQRを読み取り直してください');
    else if (r.status === 429 && r.headers.get('Retry-After')) ibShowError('送りすぎです。1分ほど待ってからもう一度送ってください');
    else ibShowError(IB_ERRORS[r.status] ?? `送れませんでした(エラー ${r.status})`);
  } catch {
    ibShowError('送れませんでした。サーバーに繋がっていません');
  } finally {
    ibBusy = false; ibSend.disabled = false;
  }
}
ibSend.addEventListener('pointerdown', () => { vdbg('送る pointerdown'); if (micState !== 'idle' && srRec) ibSubmit(); }); // クリックを待たず押した瞬間に止める
ibForm.addEventListener('submit', (e) => { e.preventDefault(); ibSubmit(); });
ibText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); ibSubmit(); }
});
ibText.addEventListener('input', () => { ibResize(); if (!ibError.hidden) ibShowError(''); });
mobileMq.addEventListener('change', () => renderInbox(ibInfo));
// スマホのキーボードで入力欄が隠れないよう、見えている範囲の下端に合わせる
if (window.visualViewport) {
  const vv = window.visualViewport;
  const kb = () => document.documentElement.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
  vv.addEventListener('resize', kb); vv.addEventListener('scroll', kb);
}

function heartSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 29');
  svg.setAttribute('class', 'heart');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M16 28C6 20 0 14 0 8 0 3.5 3.5 0 8 0c3.5 0 6.5 2 8 5 1.5-3 4.5-5 8-5 4.5 0 8 3.5 8 8 0 6-6 12-16 20z');
  svg.append(p);
  return svg;
}

function renderAvatars() {
  // スマホ幅は吹き出し・ハートが混むので、完了は同時に最大2件(レビュー中の吹き出しがあるぶんは減らす)、ハートは1件だけ
  let doneLeft = mobileMq.matches ? Math.max(0, Math.min(2, 3 - rvWanted.size)) : Infinity;
  let heartLeft = mobileMq.matches ? 1 : Infinity;
  for (const m of current.members) {
    const a = avatars.get(aid(m.seat));
    if (!a) continue;
    const st = shownStatus(m);
    a.status = st;
    const tg = a.tagObj.element.classList;
    tg.toggle('is-working', st === 'working');
    tg.toggle('is-idle', st === 'idle');
    tg.toggle('rv-dim', st === 'idle' && reviewActive() && m.seat !== 'bucho' && !rvWanted.has(aid(m.seat))); // レビュー中は、待機の名札を薄くして会議室の名札を読みやすくする
    const pr = m.progress && Number.isFinite(m.progress.pct) ? m.progress : null; // 推測で%は作らない。無い担当はバーを出さない
    if (a.pg) {
      const show = st === 'working' && !!pr;
      a.pg.hidden = !show;
      if (show) {
        const pc = Math.max(0, Math.min(100, Math.round(pr.pct)));
        a.pgBar.style.setProperty('--pct', `${pc}%`);
        a.pgTxt.textContent = pc >= 100 ? '完了' : `${pc}%`;
        a.pgNow.textContent = pr.current ? `いま: ${clip(pr.current, 12)}` : '';
        a.pgNow.hidden = !pr.current;
      }
    }
    const nick = seatNick(m);
    const role = seatRole(m);
    a.name.textContent = countOf(m) > 1 ? `${nick} ×${countOf(m)}` : nick;
    a.role.textContent = role; // 担当(役職名)は必ず出す
    let kind = null;
    let text = '';
    let quietBranch = false;
    let heart = true;
    if (m.seat === 'bucho' && asking()) { kind = 'waiting'; text = askHeader(); }
    else if (m.seat === 'bucho' && reporting && reporting.phase === 'listen') { kind = 'report'; text = 'ご報告します'; }
    else if (m.seat === 'bucho' && hearing && hearing.phase !== 'back') { kind = 'quiet'; text = '承ります'; }
    else if (m.seat === 'bucho' && instructing()) { kind = 'quiet'; text = '指示を出します'; }
    else if (m.seat === 'bucho' && current.reviewing) { kind = 'review'; text = reviewText(current.reviewing); } // 解除されるまで残す(8秒で消える待機の吹き出しとは別枠)
    else if (m.seat !== 'bucho' && a.rvOn && rvWanted.has(aid(m.seat)) && a.s >= a.len - 0.01) { kind = 'show'; text = a.rvKind === 'seat' ? 'はい' : '見てください'; }
    else if (st === 'working' && isReviewer(m)) { kind = 'review'; text = reviewText(current.reviewing); }
    else if (st === 'working') { if (m.seat === 'bucho') { kind = 'working'; text = m.bubble || '作業中'; } } // 担当は名札(進捗付き)が出るので、頭上の「作業中」吹き出しは出さない
    else if (st === 'done') { if (m.seat === 'bucho' || doneLeft-- > 0) { kind = 'done'; text = 'できました'; heart = m.seat === 'bucho' || heartLeft-- > 0; } }
    else if (st === 'waiting' && m.seat === 'bucho' && current.waiting?.kind === 'idle') { kind = 'quiet'; text = '社長の次の指示待ち'; }
    else if (st === 'waiting' && m.seat === 'bucho' && current.waiting?.text) { kind = 'waiting'; text = clip(current.waiting.text, 44); }
    else if (st === 'waiting') { kind = 'waiting'; text = m.bubble || '確認待ち'; }
    else if (m.seat === 'bucho' && m.bubble) {
      // 待機中の吹き出し(「社長に報告」など)は出しっぱなしにせず、表示から約8秒で消す。内容が変わればまた8秒
      quietBranch = true;
      if (a.quiet?.text !== m.bubble) a.quiet = { text: m.bubble, since: Date.now() };
      if (Date.now() - a.quiet.since < QUIET_MS) { kind = 'quiet'; text = m.bubble; }
    }
    if (!quietBranch) a.quiet = null; // 待機中の吹き出しの時計は、その吹き出しが続いている間だけ持つ
    if (a.shown.kind === kind && a.shown.text === text && a.shown.rv === !!a.rvOn && a.shown.hr === heart) continue;
    a.shown = { kind, text, rv: !!a.rvOn, hr: heart };
    a.bubbleWrap.replaceChildren();
    if (!kind) continue;
    const b = el('div', `bubble ${kind}`);
    if (a.cfg.bdx) { b.style.translate = `${a.cfg.bdx}px 0`; b.style.setProperty('--tail', `${-a.cfg.bdx}px`); }
    if (kind === 'review' && m.seat === 'bucho' && a.rvOn) b.style.translate = '0 -44px'; // 会議室では、担当の「見てください」と重ならないよう上へ上げる
    if (kind === 'show') { // 部長の「レビュー中」の吹き出しと重ならないよう、立ち位置ごとに横へずらす
      const sl = rvSlot.get(aid(m.seat));
      const room = a.rvKind === 'room';
      const dx = (room ? [-30, 30, 0] : mobileMq.matches ? [-70, 70, 0] : [-100, 100, 0])[sl] ?? 0;
      b.style.translate = `${dx}px ${sl === 2 ? (room ? 8 : mobileMq.matches ? -46 : -26) : 0}px`;
      b.style.setProperty('--tail', `${-dx}px`);
    }
    b.style.setProperty('--c', colorOfSeat(m.seat));
    if (kind === 'done' && heart) a.bubbleWrap.append(heartSvg());
    if (kind === 'waiting') b.append(el('span', 'q', '?'));
    if (kind === 'review') b.append(el('span', 'rv-h', '🔍レビュー中'));
    const t = el('span', 't', text);
    if (kind === 'waiting') t.style.display = 'inline';
    b.append(t);
    if (kind === 'working') {
      const dots = el('span', 'dots');
      dots.append(el('i'), el('i'), el('i'));
      b.append(dots);
    }
    a.bubbleWrap.append(b);
    // 新しく変わった吹き出しを一番上に重ねる(隣どうしで隠れても最新の動きは見える)
    a.bubbleWrap.style.zIndex = 100 + ++bubbleSeq;
  }
}

const reviewText = (rv) => {
  const t = String(rv?.target ?? '').trim();
  if (t && mobileMq.matches && rvWanted.size) return `${clipHead(t, 5)}を確認中`; // スマホ幅は担当の吹き出しと重ならないよう短くする
  return t ? `${t}を確認中` : '確認中';
};
// 部長以外の担当(動作確認担当など)が確認する側のとき、その担当の頭上にも対象を出す
const isReviewer = (m) => {
  const by = String(current.reviewing?.by ?? '');
  return !!by && m.seat !== 'bucho' && (by === seatNick(m) || by === seatRole(m) || by === m.name);
};
function askHeader() {
  const d = current.decisions.find((x) => x?.status === 'pending');
  const h = String(d?.header || d?.question || '').trim() || 'ご質問があります';
  return h.length > 22 ? `${h.slice(0, 21)}…` : h;
}
// 社長は質問が来ると顔を上げ、頭上に「?」を出す
function renderPresident() {
  const a = avatars.get('president');
  const ask = asking();
  const hear = !ask && hearing != null && hearing.phase === 'listen'; // 部長が目の前に来て、指示を話している間
  const rep = !ask && reporting != null && reporting.phase === 'listen'; // 部長が報告している間(うなずく)
  const key = ask ? 'ask' : rep ? `rep:${reporting.text}` : hear ? `hear:${hearing.text}` : '';
  a.asking = ask || hear || rep; // 顔を上げる
  a.nodding = rep;
  if (a.bubbleKey === key) return;
  a.bubbleKey = key;
  a.bubbleWrap.replaceChildren();
  if (!key) return;
  const b = el('div', ask ? 'bubble waiting mark' : 'bubble quiet say');
  b.style.setProperty('--c', colorOfSeat('president'));
  if (ask) b.append(el('span', 'q', '?'));
  else if (rep) { b.classList.add('report-sum'); b.append(el('span', 't', reporting.text)); }
  else b.append(el('span', 't', `『${hearing.text}』`));
  a.bubbleWrap.append(b);
  a.bubbleWrap.style.zIndex = 100 + ++bubbleSeq;
}

const clip = (t, n) => { const a = [...String(t ?? '').replace(/\s+/g, ' ').trim()]; return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join(''); };
// ---------- 確認待ちの内容(snapshot.waiting。無い・null の古いサーバーは欄を出さない) ----------
const WAIT_KIND = { permission: '許可待ち', question: '質問', idle: '次の指示待ち', other: '確認待ち' };
function normWaiting(w) {
  if (!w || typeof w !== 'object') return null;
  const text = String(w.text ?? '').trim();
  const kind = WAIT_KIND[w.kind] ? w.kind : 'other';
  if (!text && kind !== 'idle') return null;
  return { kind, text, detail: String(w.detail ?? '').trim(), since: w.since ?? null };
}
const fmtSince = (since) => {
  const t = since == null ? NaN : new Date(since).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分`;
  return `${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`;
};
function renderWaitbar() {
  const box = $('#waitbar');
  const w = current.waiting;
  const pend = (current.decisions ?? []).some((d) => d?.status === 'pending') || !$('#decision').hidden; // ご判断の帯が出ているときは重ねない
  const show = !!w && !pend;
  box.hidden = !show;
  if (!show) return;
  box.dataset.kind = w.kind;
  $('#wb-kind').textContent = WAIT_KIND[w.kind];
  $('#wb-text').textContent = w.kind === 'idle' ? (w.text && w.text !== WAIT_KIND.idle ? w.text : '社長の次の指示をお待ちしています') : w.text;
  const d = $('#wb-detail');
  d.textContent = w.detail ? clip(w.detail, 160) : '';
  d.hidden = !w.detail;
  tickWaitbar();
}
function tickWaitbar() {
  const w = current.waiting;
  if (!w) return;
  const e = fmtSince(w.since);
  $('#wb-since').textContent = e ? `${e}前から` : '';
}
setInterval(tickWaitbar, 1000);
let dcH = 0;
const dcMode = (d) => (d.source === 'office' ? (['choice', 'open', 'terminal'].includes(d.mode) ? d.mode : 'choice') : 'terminal'); // hook 由来は答えを返せないので terminal 扱い
const dcTermClosed = new Map(); // ターミナルの入力で自動で閉じた確認カード id -> { header, until }(履歴として約30秒見せる)
const dcAnsweredShow = new Map(); // 確定した判断 id -> { label, until }(「回答済み」を少し見せる)
const dcSeenPending = new Set();
let dcBusy = false;
async function dcPost(path, body) {
  if (dcBusy) return;
  dcBusy = true;
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) $('#dc-note').textContent = r.status === 409 ? 'すでに選択済みか、回答済みです' : `送れませんでした(エラー ${r.status})`;
  } catch { $('#dc-note').textContent = '送れませんでした(通信エラー)'; }
  dcBusy = false;
}
// ---------- 「その他(自由に入力)」(入力文は画面のメモリだけ。console・保存・ログ・innerHTML には出さない) ----------
const OTHER_MAX = 500;
const otherDraft = new Map(); // 判断 id -> 入力中の文字(カードごとに独立)
const otherSent = new Map(); // 送って、サーバーの確定待ち(取り消し猶予中)の判断 id
let otherShownId = null;
const otherConfirming = (d) => d.pickedOther === true || (d.pickedOther === undefined && (d.otherPending === true || otherSent.has(d.id))); // サーバーは猶予中 pickedOther:true(無い古い版は送信済みの記憶で代用)
const otherLen = (v) => Array.from(String(v).trim()).length; // サーバーと同じ: 前後の空白を除いたコードポイント数
function otherCheck() {
  const ta = $('#dc-other-text');
  const t = otherLen(ta.value);
  const over = t > OTHER_MAX;
  $('#dc-other-count').textContent = `${t}/${OTHER_MAX}`;
  $('#dc-other-count').classList.toggle('over', over);
  $('#dc-other-send').disabled = ta.disabled || t === 0 || over || dcBusy;
}
async function otherSend() {
  const id = otherShownId;
  const ta = $('#dc-other-text');
  const text = ta.value.trim();
  if (id == null || !text || otherLen(text) > OTHER_MAX || dcBusy) return;
  dcBusy = true;
  $('#dc-other-send').disabled = true;
  let ok = false;
  try {
    const r = await fetch('/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, other: text }) });
    ok = r.ok;
    if (!ok) $('#dc-note').textContent = r.status === 409 ? 'すでに選択済みか、回答済みです' : `送れませんでした(エラー ${r.status})`;
  } catch { $('#dc-note').textContent = '送れませんでした(通信エラー)'; }
  dcBusy = false;
  if (ok) otherSent.set(id, Date.now());
  renderDecision();
}
$('#dc-other-text').addEventListener('input', () => { if (otherShownId != null) otherDraft.set(otherShownId, $('#dc-other-text').value); otherCheck(); });
$('#dc-other-send').addEventListener('click', otherSend);
function renderOther(d, show, confirming) {
  const box = $('#dc-other');
  const ta = $('#dc-other-text');
  box.hidden = !show;
  if (!show) { otherShownId = null; return; }
  if (otherShownId !== d.id) { otherShownId = d.id; ta.value = otherDraft.get(d.id) ?? ''; } // 別のカードに替わったときだけ値を入れ替える(同じカードの再描画では触らない)
  ta.disabled = confirming;
  otherCheck();
}
function otherCleanup(all) {
  const live = new Set(all.filter((d) => d?.status === 'pending').map((d) => d.id));
  for (const k of [...otherDraft.keys()]) if (!live.has(k)) otherDraft.delete(k);
  for (const k of [...otherSent.keys()]) if (!live.has(k)) otherSent.delete(k);
}
function renderDecision() {
  const box = $('#decision');
  const all = current.decisions ?? [];
  const pend = all.filter((d) => d?.status === 'pending');
  // 確定した(pending だったものが answered になった)判断は、約6秒「回答済み」を見せる
  for (const d of all) {
    if (d.status === 'pending') dcSeenPending.add(d.id);
    else if (dcSeenPending.has(d.id)) {
      dcSeenPending.delete(d.id);
      if (d.source === 'office' && d.closedByTerminal === true) dcTermClosed.set(d.id, { header: d.header ?? '', until: Date.now() + 30000 });
      else if (d.source === 'office' && d.answeredOther === true) dcAnsweredShow.set(d.id, { label: 'その他', until: Date.now() + 6000 });
      else if (d.source === 'office' && Number.isInteger(d.choice)) dcAnsweredShow.set(d.id, { label: d.options?.[d.choice]?.label ?? '', until: Date.now() + 6000 });
      else if (d.source === 'office' && dcMode(d) === 'open') dcAnsweredShow.set(d.id, { open: true, until: Date.now() + 6000 }); // 自由記入は選択肢が無い
    }
  }
  for (const [k, v] of dcAnsweredShow) if (v.until < Date.now()) dcAnsweredShow.delete(k);
  for (const [k, v] of dcTermClosed) if (v.until < Date.now()) dcTermClosed.delete(k);
  const done = [...dcAnsweredShow.values()].pop() ?? ([...dcTermClosed.values()].pop() ? { term: true, header: [...dcTermClosed.values()].pop().header } : undefined);
  const appeared = box.hidden && (pend.length > 0 || !!done);
  box.hidden = pend.length === 0 && !done;
  const note = $('#dc-note');
  otherCleanup(all);
  const confirmBar = $('#dc-confirm');
  const others = $('#dc-others');
  if (!pend.length && done) {
    $('#dc-header').textContent = '';
    $('#dc-question').textContent = done.term ? `ターミナルの入力で閉じました${done.header ? `(${done.header})` : ''}` : done.open ? 'ご回答を受け取りました。部長が確認します' : `回答済み: ${done.label}`;
    $('#dc-more').hidden = true;
    $('#dc-options').replaceChildren();
    confirmBar.hidden = true; others.hidden = true; renderOther(null, false, false);
    note.textContent = done.term ? '' : done.open ? '' : '部長が受け取って、作業を再開します';
    note.hidden = !note.textContent;
  } else if (pend.length) {
    const d = pend[0];
    const mode = dcMode(d);
    $('#dc-header').textContent = d.header ?? '';
    $('#dc-question').textContent = d.question ?? '';
    const more = $('#dc-more');
    more.hidden = false;
    more.textContent = `未回答 ${pend.length} 件`;
    const picked = Number.isInteger(d.choice) ? d.choice : null;
    const canClick = mode === 'choice' && !mobileMq.matches && ibInfo?.canSend === true;
    const ul = $('#dc-options');
    ul.className = `dc-options${canClick ? ' click' : ''}`;
    ul.replaceChildren(...(d.options ?? []).map((o, idx) => {
      const li = el('li');
      const btn = el('button', `dc-opt${picked === idx ? ' picked' : ''}`);
      btn.type = 'button';
      btn.disabled = !canClick || picked !== null;
      btn.append(el('span', 'l', o.label ?? ''));
      if (o.description) btn.append(el('span', 'd', o.description));
      if (canClick && picked === null) btn.addEventListener('click', () => dcPost('/answer', { id: d.id, choice: idx }));
      li.append(btn);
      return li;
    }));
    // 「その他」入力欄(選択肢カードをPCでクリックできるときだけ。allowOther が false なら出さない)
    const oc = otherConfirming(d);
    renderOther(d, canClick && d.allowOther !== false && (picked === null || oc), oc);
    // 取り消しバー(選択中だけ。残り秒は confirmAt から出す)
    confirmBar.hidden = picked === null && !oc;
    if (picked !== null || oc) {
      $('#dc-chosen').textContent = oc && picked === null ? 'その他の内容を送りました。' : `「${d.options?.[picked]?.label ?? ''}」を選びました。`;
      const cancel = $('#dc-cancel');
      cancel.onclick = async () => { await dcPost('/answer-cancel', { id: d.id }); otherSent.delete(d.id); renderDecision(); };
      cancel.disabled = !canClick;
      tickDecision();
    }
    const noSend = mobileMq.matches || ibInfo?.canSend !== true;
    note.textContent = mode === 'open' ? (noSend ? 'PCの画面でお答えください' : '下の「社長の指示」入力欄に書いて送ってください(部長が受け取ります)')
      : mode === 'terminal' ? (d.source === 'office' ? 'ターミナルでお答えください(ターミナルで答えると自動で閉じます)' : 'ターミナルでお答えください')
      : canClick ? (picked === null && !oc ? '選択肢をクリックするか、下の欄に書いてください(5秒以内なら取り消せます)' : '')
      : mobileMq.matches ? 'PCでお答えください(スマホは閲覧のみ)' : '判断待ち(PCの画面でお答えください)';
    note.hidden = !note.textContent;
    const rest = pend.slice(1);
    others.hidden = !rest.length;
    others.textContent = rest.length ? `次の確認: ${rest.slice(0, 3).map((x) => clip(x.header || x.question, 16)).join(' / ')}${rest.length > 3 ? ' ほか' : ''}` : '';
  }
  if (appeared && mobileMq.matches && window.scrollY < 30) {
    // スマホは帯が画面の下にあり見落としやすい。まだ下へスクロールしていないときだけ、3Dの下に帯が見える位置まで送る
    requestAnimationFrame(() => {
      const top = box.getBoundingClientRect().top + window.scrollY - $('#stage').offsetHeight - 8;
      if (top > 0 && window.scrollY < 30) window.scrollTo({ top, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
    });
  }
  // PC では案件ボードを帯の高さだけ下げ、3D の空き領域も取り直す
  const wb = $('#waitbar');
  const h = mobileMq.matches ? 0 : !box.hidden ? box.offsetHeight + 10 : !wb.hidden ? wb.offsetHeight + 10 : 0;
  if (h !== dcH) { dcH = h; document.documentElement.style.setProperty('--dc-h', `${h}px`); layout(); }
}
function tickDecision() {
  const d = (current.decisions ?? []).find((x) => x.status === 'pending' && (Number.isInteger(x.choice) || otherConfirming(x)));
  const until = d ? (d.confirmAt != null ? Number(d.confirmAt) : otherSent.has(d.id) ? otherSent.get(d.id) + 5000 : null) : null;
  if (d && until != null) {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    $('#dc-cancel').textContent = `取り消す(あと${left}秒)`;
  }
  if (dcAnsweredShow.size || dcTermClosed.size) renderDecision();
}
setInterval(tickDecision, 250);

function ownerCount(role) {
  const ms = current.members.filter((m) => (m.nickname === role || seatRole(m) === role || m.name === role) && m.status !== 'idle');
  return ms.reduce((mx, m) => Math.max(mx, countOf(m)), 1);
}
// レビュー中の列: レビューを受ける担当の名前だけ(担当を特定できなければ target の名前部分)
const rvName = (rv) => {
  const t = String(rv?.target ?? '');
  const m = current.members.find((x) => x.seat !== 'bucho' && [seatNick(x), seatRole(x), x.name].some((n) => n && t.includes(n)));
  return m ? seatNick(m) : clip(t.replace(/『.*$/, ''), 10) || 'レビュー中';
};
function renderBoard() {
  const cols = { idle: [], working: [], reviewing: [], waiting: [], done: [] };
  // 「タスク振り待ち」は案件ではなく、まだ担当に振られていない社長の指示(受け取り待ち・振り中)。古い順に 1,2,3…
  const queue = (current.instructions ?? []).filter((r) => r.status === 'queued' || r.status === 'assigning');
  for (const c of current.board) {
    const k = c.status === 'reviewing' ? 'reviewing' : c.column;
    (cols[k] ?? cols.working).push(c);
  }
  const rv = current.reviewing;
  const idleNames = new Map(); // 席ごとの nickname(同じ名前は無いので ×N にはならない)
  for (const m of current.members) {
    if (shownStatus(m) !== 'idle') continue;
    idleNames.set(seatNick(m), { n: 1, c: colorOfSeat(m.seat) });
  }
  for (const col of document.querySelectorAll('#board .col')) {
    const key = col.dataset.col;
    const ul = col.querySelector('ul');
    const items = [];
    if (key === 'queue') {
      queue.forEach((r, i) => {
        const li = el('li', 'card q');
        li.dataset.id = `q${r.id ?? i}:${r.status}:${i}`;
        li.style.setProperty('--c', r.status === 'assigning' ? '#e8962e' : '#8a8399');
        li.append(el('span', 't', [...String(r.text ?? '').replace(/\s+/g, ' ').trim()].slice(0, 100).join('') || '(指示)'), el('span', 'o', `${i + 1}番目 ${r.status === 'assigning' ? '受付済み' : '受け取り待ち'}`));
        items.push(li);
      });
      col.querySelector('.count').textContent = queue.length;
    } else if (key === 'idle') {
      for (const [name, { n, c }] of idleNames) {
        const li = el('li', 'chip', n > 1 ? `${name} ×${n}` : name);
        li.style.setProperty('--c', c);
        items.push(li);
      }
      col.querySelector('.count').textContent = [...idleNames.values()].reduce((s, v) => s + v.n, 0);
    } else {
      const list = key === 'done' ? [...cols.done].reverse() : cols[key];
      for (const [ci, c] of list.entries()) {
        const li = el('li', key === 'reviewing' ? 'card rv' : 'card');
        li.dataset.id = `${c.id}:${Number.isFinite(c.pct) ? c.pct : ''}:${ownerCount(c.owner)}`;
        li.style.setProperty('--c', colorOfName(c.owner));
        // 作業内容(件名・説明)は出さず、担当の名前だけ(同じ席が×2なら「ノリさん ×2」)
        li.classList.add('nm');
        li.append(el('span', 't', `${nickForRole(c.owner)}${ownerCount(c.owner) > 1 ? ` ×${ownerCount(c.owner)}` : ''}`));
        if (Number.isFinite(c.pct) && key === 'working') {
          const bar = el('i', 'card-pg');
          bar.style.setProperty('--pct', `${Math.max(0, Math.min(100, Math.round(c.pct)))}%`);
          li.append(bar, el('b', 'card-pct', `${Math.round(c.pct)}%`));
        }
        if (key === 'reviewing') {
          // 確認している人・いま見ているファイル(契約は snapshot.reviewing。1件だけなので、先頭のカードに付ける)
          const own = ci === 0 && rv ? rv : null;
          li.dataset.id = `${c.id}:rv`;
        } else if (key === 'waiting' && c.waitText) {
          li.dataset.id = `${c.id}:${c.waitText}`;
          li.append(el('span', 'wt', clip(String(c.waitText), 80)));
        } else if (key === 'working' && (c.sentBack || c.returned)) {
          li.append(el('span', 'back', '差し戻し'));
        }
        items.push(li);
      }
      if (key === 'reviewing' && !list.length && rv) {
        // 案件カードが無くても、レビュー中の対象は列に出す
        const li = el('li', 'card rv');
        li.dataset.id = `rv:${rv.target}|${rv.by}|${rv.file}`;
        li.style.setProperty('--c', '#9a7fe0');
        li.classList.add('nm');
        li.append(el('span', 't', rvName(rv)));
        items.push(li);
      }
      col.querySelector('.count').textContent = Math.max(list.length, key === 'reviewing' && rv ? 1 : 0);
    }
    // 変わっていないカードは作り直さない(出現アニメーションを毎回走らせないため)
    const sig = items.map((i) => i.dataset.id ?? i.textContent).join('|');
    if (ul.dataset.sig === sig) continue;
    const before = new Set([...ul.children].map((li) => li.dataset.id).filter(Boolean));
    for (const li of items) if (li.dataset.id && before.has(li.dataset.id)) li.style.animation = 'none';
    ul.dataset.sig = sig;
    ul.replaceChildren(...(items.length ? items : [el('li', 'empty', 'なし')]));
  }
}

const fmtTime = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ja-JP', { hour12: false });
};

function renderFeed(fresh) {
  const rows = current.log.slice(-FEED_MAX).reverse();
  const key = rows.length ? `${rows[0].ts}|${rows[0].who}|${rows[0].text}|${current.log.length}` : '';
  if (key === lastFeedKey) return;
  const oldTop = lastFeedKey;
  lastFeedKey = key;
  const list = $('#feed-list');
  let newCount = 0;
  if (!fresh && oldTop != null) {
    const prevLen = Number(oldTop.split('|').pop()) || 0;
    newCount = Math.max(0, current.log.length - prevLen);
  }
  list.replaceChildren(...rows.map((r, i) => {
    const li = el('li', i < newCount ? 'new' : '');
    li.style.setProperty('--c', colorOfName(r.who));
    li.append(el('span', 'time', fmtTime(r.ts)), el('span', 'who', nickForRole(r.who)), el('span', 'text', r.text));
    return li;
  }));
  if (!rows.length) list.replaceChildren(el('li', 'empty', 'まだ通知はありません。作業が始まると、ここに新しい順で出ます'));
}

function fmtElapsed(startedAt) {
  if (startedAt == null) return '—';
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderCounters() {
  const c = current.counters ?? {};
  $('#st-tools').textContent = c.tools ?? 0;
  $('#st-delegates').textContent = c.delegates ?? 0;
  $('#st-elapsed').textContent = fmtElapsed(c.startedAt);
}

// ---------- 回答掲示板(snapshot.answers。無い古いサーバーは欄ごと隠す) ----------
const ANSWER_NEW_MS = 30000;
const answerSeen = new Map(); // id -> 初めて画面に出た時刻
let anSig = '';
function renderAnswers() {
  const sec = $('#answers');
  const list = current.answers;
  if (!list) { sec.hidden = true; return; }
  sec.hidden = false;
  const canRead = ibInfo?.canSend !== false && !mobileMq.matches;
  const now = Date.now();
  for (const a of list) if (!answerSeen.has(a.id)) answerSeen.set(a.id, now);
  const rows = list.map((a) => ({ a, hot: a.status === 'new' && now - answerSeen.get(a.id) < ANSWER_NEW_MS }));
  const sig = JSON.stringify([rows.map((r) => [r.a, r.hot]), canRead]);
  if (sig === anSig) return;
  anSig = sig;
  const ul = $('#an-list');
  if (!rows.length) { ul.replaceChildren(el('li', 'an-empty', 'まだ回答はありません')); return; }
  ul.replaceChildren(...rows.map(({ a, hot }) => {
    const li = el('li', `an-card${hot ? ' hot' : ''}`);
    const t = Number.isFinite(a.askedAt) ? new Date(a.askedAt) : null;
    const hm = t ? `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}` : '';
    const head = el('div', 'an-head');
    head.append(el('span', 'an-q', String(a.question ?? '')), el('span', 'an-time', hm));
    const body = el('div', 'an-a', String(a.answer ?? ''));
    const foot = el('div', 'an-foot');
    foot.append(el('span', 'an-by', a.by ? `答えた人: ${a.by}` : ''));
    if (hot) foot.append(el('span', 'an-new', '新着'));
    if (canRead && a.status === 'new') {
      const b = el('button', 'an-read', '既読');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await fetch('/answer-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: a.id }) }); } catch { b.disabled = false; }
      });
      foot.append(b);
    }
    li.append(head, body, foot);
    return li;
  }));
}
setInterval(() => { if (current.answers) renderAnswers(); }, 1000);

// ---------- 利用枠(snapshot.quota。無い・欠けは「取得できません」。数字は推測しない) ----------
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const okWin = (w) => w && Number.isFinite(w.pct) && Number.isFinite(w.resetsAt);
function quotaRow(label, w, kind) {
  const row = el('div', 'q-row');
  const head = el('div', 'q-head');
  head.append(el('span', 'q-l', label));
  if (!okWin(w)) {
    head.append(el('b', 'q-pct', '—'));
    row.append(head, el('p', 'q-sub', '取得できません'));
    return row;
  }
  const pct = Math.max(0, Math.min(100, w.pct));
  const left = 100 - pct;
  head.append(el('b', 'q-pct', `${Math.round(pct)}%使用`));
  const bar = el('div', 'q-bar');
  const fill = el('i');
  fill.style.width = `${pct}%`;
  bar.append(fill);
  row.dataset.lv = left < 10 ? 'red' : left < 20 ? 'orange' : 'ok';
  const at = new Date(w.resetsAt * 1000);
  const hm = `${at.getHours()}時${String(at.getMinutes()).padStart(2, '0')}分`;
  let sub;
  if (kind === 'five') {
    const ms = Math.max(0, at.getTime() - Date.now());
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    sub = ms <= 0 ? '回復の時刻を過ぎました' : `あと${h ? `${h}時間` : ''}${m}分で回復(${hm})`;
  } else {
    sub = `${WD[at.getDay()]}曜${hm}に回復`;
  }
  row.append(head, bar, el('p', 'q-sub', sub));
  return row;
}
function renderQuota() {
  const q = current.quota;
  const box = $('#quota');
  const bothMissing = !q || (!okWin(q.fiveHour) && !okWin(q.sevenDay));
  const kids = [el('div', 'q-title', '利用枠')];
  if (bothMissing) {
    kids.push(el('p', 'q-none', '取得できません(プランやバージョンにより出ない場合があります)'));
  } else {
    kids.push(quotaRow('5時間枠', q.fiveHour, 'five'), quotaRow('週間枠', q.sevenDay, 'week'));
    const age = Number.isFinite(q.updatedAt) ? Math.floor((Date.now() - q.updatedAt) / 60000) : 0;
    if (age >= 10) kids.push(el('p', 'q-old', `${age}分前の値`));
  }
  box.replaceChildren(...kids);
}
setInterval(() => { if (current.quota) renderQuota(); }, 1000);

const fmtK = (n) => (n >= 100000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(1)}k`);

function renderUsage() {
  const u = usage;
  const total = u?.tokens?.total;
  $('#st-tokens').textContent = typeof total === 'number' ? fmtK(total) : '—';
  let cost = '—';
  if (typeof u?.usd === 'number') {
    cost = `$${u.usd.toFixed(2)}`;
    if (typeof u.jpy === 'number') cost += `(約¥${Math.round(u.jpy).toLocaleString('ja-JP')})`;
  }
  $('#st-cost').textContent = cost;
  $('#st-rate').textContent = typeof u?.usdJpy === 'number' ? `1ドル=${u.usdJpy}円(仮)` : '為替は仮のレート';
  $('#st-unpriced').hidden = !(u?.unpricedModels?.length > 0);
  const bySeat = u?.bySeat ?? {};
  for (const [seat, a] of avatars) {
    const n = Object.entries(bySeat).reduce((t, [k, v]) => (aid(k) === seat ? t + v : t), 0);
    a.tok.textContent = n > 0 ? fmtK(n) : '';
  }
}

// ---------- 接続(切れたら3秒ごとに再接続し、snapshot で描き直す) ----------
let es = null;
let retryTimer = null;
function setConn(ok) {
  const c = $('#conn');
  c.className = `conn ${ok ? 'on' : 'off'}`;
  c.textContent = ok ? '接続中' : '再接続しています…';
}
function connect() {
  es = new EventSource('/events');
  es.addEventListener('snapshot', (e) => { setConn(true); const sn = JSON.parse(e.data); if (Number.isFinite(sn?.delegation?.seq)) lastDelegSeq = Math.max(lastDelegSeq, sn.delegation.seq); applySnapshot(sn, true); window.dispatchEvent(new CustomEvent('mimamori:snapshot', { detail: sn })); }); // attention.js が接続を増やさず使う
  es.addEventListener('office', (e) => {
    const d = JSON.parse(e.data);
    if (d.snapshot) window.dispatchEvent(new CustomEvent('mimamori:snapshot', { detail: d.snapshot }));
    const kind = d.event?.kind;
    if (kind === 'prompt') {
      meeting = null;
      if (d.event?.agentId) meeting = newMeeting();
      else {
        reporting = null; // 次の指示が来たら報告を打ち切って、聞きに行く動きへ
        // 会議より先に、部長が社長室へ指示を聞きに行く(質問が出ているときは applySnapshot が打ち切る)
        const txt = d.snapshot?.instruction?.text ?? d.event?.body ?? d.event?.title ?? '';
        hearing = { phase: 'walk', until: 0, text: clipHead(txt), delegated: false, startedAt: Date.now() };
      }
    } else if (kind === 'stop') {
      meeting = null; hearing = null;
      if (!d.event?.agentId) reporting = { phase: 'walk', until: 0, text: reportSummary(d.snapshot, d.event), startedAt: Date.now() };
    }
    else if (kind === 'delegate') { if (meeting) meeting.delegated = true; if (hearing) hearing.delegated = true; }
    // 指示を受けに来る担当は、席の status/count に頼らず「委任イベントの対象の種類」で決める(hook は async で、SubagentStart が先に着くことがあるため)。
    // delegate: targetType の席。subagent_start が先に来た場合: その担当の席(agentType)。どちらも直近に歩いた席は二重に歩かせない
    const evType = kind === 'delegate' && !d.event?.agentId ? d.event?.targetType : kind === 'subagent_start' ? d.event?.agentType : null;
    const newcomers = [];
    // サーバーの委任番号(delegation.seq)が前回より大きければ新しい委任。hook の到着順に依存しない(主の判定)
    const dg = d.event?.delegation ?? d.snapshot?.delegation ?? null;
    let seqHandled = false;
    if (dg && Number.isFinite(dg.seq)) {
      seqHandled = true;
      if (dg.seq > lastDelegSeq) {
        lastDelegSeq = dg.seq;
        const m = dg.seat ? (d.snapshot?.members ?? []).find((x) => x.seat === dg.seat) : null;
        if (m && m.seat !== 'bucho') newcomers.push(aid(m.seat));
      }
    }
    if (!seqHandled && evType) {
      const ms = (d.snapshot?.members ?? []).filter((m) => m.seat !== 'bucho' && (m.seat === evType || m.type === evType));
      const m = ms.find((x) => x.status === 'working') ?? ms[0];
      if (m) newcomers.push(aid(m.seat));
    }
    if (!seqHandled && kind === 'delegate' && !d.event?.agentId && !newcomers.length) { // 種類から席が分からない古い形: 作業を始めた席・件数が増えた席
      for (const m of d.snapshot?.members ?? []) {
        const o = current.members.find((x) => x.seat === m.seat);
        if (m.seat !== 'bucho' && m.status === 'working' && (o?.status !== 'working' || countOf(m) > countOf(o))) newcomers.push(aid(m.seat));
      }
    }
    applySnapshot(d.snapshot, false);
    const nowMs = Date.now();
    for (const id of newcomers) {
      if (asHold.has(id) || !avatars.get(id)?.chain) continue;
      if (!seqHandled && kind === 'subagent_start' && nowMs - (lastAssignAt.get(id) ?? 0) < 15000) continue; // 直前の委任で歩いた席
      if (!seqHandled && kind === 'delegate' && nowMs - (lastAssignAt.get(id) ?? 0) < 4000) continue; // subagent_start が先に着いて歩いた直後
      lastAssignAt.set(id, nowMs);
      asHold.set(id, { startedAt: nowMs, arrivedAt: null });
    }
    if (newcomers.length) updateReview(false);
    // 呼ばれた(働き始めた)担当から順に、会議を抜けて自席へ戻る
    if (meeting) for (const m of current.members) if (m.status !== 'idle' && m.seat !== 'bucho') meeting.released.add(aid(m.seat));
  });
  es.addEventListener('usage', (e) => { usage = JSON.parse(e.data); renderUsage(); });
  es.onerror = () => {
    es.close();
    setConn(false);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 3000);
  };
}
connect();

function reportSummary(snap, ev) {
  const b = (snap?.members ?? []).find((m) => m.seat === 'bucho');
  let t = String(b?.bubble || ev?.text || '').replace(/。?\s*社長に報告します$/, '').replace(/\s+/g, ' ').trim();
  t = [...t].length > 36 ? `${[...t].slice(0, 35).join('')}…` : t;
  const done = (snap?.board ?? []).filter((c) => c.column === 'done' || c.status === 'done').length;
  return `${t || '作業が終わりました'}${done ? `(完了 ${done} 件)` : ''}`;
}
let wasInstructing = false;
setInterval(() => {
  renderCounters();
  // 「できました」を4秒出したあと着席表示へ戻す
  const expired = current.members.some((m) => m.status === 'done' && (avatars.get(aid(m.seat))?.status === 'done') && shownStatus(m) !== 'done');
  const instr = instructing();
  if (expired || instr !== wasInstructing) { wasInstructing = instr; renderAvatars(); renderBoard(); }
  else renderAvatars(); // 部長の待機中の吹き出しを時間で消すため(内容が同じなら何も作り直さない)
}, 500);

// ---------- アニメーション ----------
// 会議に出ている間は立ち、呼ばれたり会議が終わったら自席へ戻る
const atMeeting = (id) => meeting != null && meetingOn() && id !== 'bucho' && id !== 'president' && !meeting.released.has(id);
function tickAssign() {
  if (!asHold.size) return;
  const now = Date.now();
  let changed = false;
  for (const [id, h] of asHold) {
    const a = avatars.get(id);
    if (reviewActive()) { h.startedAt = now; continue; } // 部長が会議室にいる間は待つ(時間切れにしない)
    if (a.rvOn && a.s >= a.len - 0.01 && h.arrivedAt == null) { h.arrivedAt = now; changed = true; }
    if ((h.arrivedAt != null && now - h.arrivedAt > ASSIGN_MS) || now - h.startedAt > ASSIGN_MAX_MS) { asHold.delete(id); changed = true; }
  }
  if (changed) { updateReview(false); renderAvatars(); }
}
function tickHearing() {
  if (!hearing) return;
  const b = avatars.get('bucho');
  const now = Date.now();
  if (now - hearing.startedAt > HEAR_MAX_MS) { hearing = null; renderAvatars(); renderPresident(); return; }
  if (hearing.phase === 'walk' && b.s >= b.len - 0.01) {
    Object.assign(hearing, { phase: 'listen', until: now + HEAR_MS });
    renderAvatars(); renderPresident();
  } else if (hearing.phase === 'listen' && now >= hearing.until) {
    hearing.phase = 'back';
    renderAvatars(); renderPresident();
  } else if (hearing.phase === 'back' && b.s <= 0.01) {
    // 席へ戻ったので、そこから会議を始める(聞いている間にもう担当へ依頼が出ていたら、集まる必要は無い)
    const skip = hearing.delegated;
    hearing = null;
    if (!skip) meeting = newMeeting();
    renderAvatars(); renderPresident();
  }
}
function tickReporting() {
  if (!reporting) return;
  const b = avatars.get('bucho');
  const now = Date.now();
  if (now - reporting.startedAt > REPORT_MAX_MS) { reporting = null; renderAvatars(); renderPresident(); return; }
  if (reporting.phase === 'walk' && b.s >= b.len - 0.01) {
    Object.assign(reporting, { phase: 'listen', until: now + REPORT_MS });
    renderAvatars(); renderPresident();
  } else if (reporting.phase === 'listen' && now >= reporting.until) {
    reporting.phase = 'back';
    renderAvatars(); renderPresident();
  } else if (reporting.phase === 'back' && b.s <= 0.01) {
    reporting = null;
    renderAvatars(); renderPresident();
  }
}
// スマホは3D領域が小さいので、名札が画面の左右からはみ出さないよう、はみ出した分だけ横へ戻す
function clampTags() {
  if (!mobileMq.matches) return;
  const sr = stage.getBoundingClientRect();
  for (const [, a] of avatars) {
    const e = a.tagObj.element;
    const r = e.getBoundingClientRect();
    if (!r.width) continue;
    const cur = parseFloat(e.style.marginLeft) || 0;
    let dx = 0;
    if (r.left < sr.left + 2) dx = sr.left + 2 - r.left;
    else if (r.right > sr.right - 2) dx = sr.right - 2 - r.right;
    if (dx) e.style.marginLeft = `${cur + dx}px`;
  }
}
let lastNow = 0;
function animate(now = 0) {
  const t = now / 1000;
  const dt = Math.min(0.25, t - lastNow);
  lastNow = t;
  for (const [id, a] of avatars) {
    let walking = false;
    if (a.chain && id === 'bucho') {
      // レビュー中は部長も会議室へ歩く。質問・報告・指示を聞く動きが来たら、席へ戻ってから社長室へ向かう
      if (!a.mtC) a.mtC = { chain: a.chain, cum: a.cum, len: a.len, focus: a.focus, tagOut: a.tagOut };
      const busy = asking() || (hearing != null && hearing.phase !== 'back') || (reporting != null && reporting.phase !== 'back');
      const wantRoom = reviewActive() && !busy;
      if (!a.rvOn && wantRoom && a.s <= 0.01) {
        useChain(a, a.rvC ??= buchoRoomChain()); a.tagOut = TAG_OUT; a.rvOn = true;
        if (roomFresh) { a.s = a.len; roomFresh = false; }
      } else if (a.rvOn && !wantRoom && a.s <= 0.01) {
        useChain(a, a.mtC); a.tagOut = a.mtC.tagOut; a.rvOn = false;
      }
    }
    if (a.chain && id !== 'bucho' && id !== 'president') {
      // レビューで部長の席へ歩く担当は、会議用とは別の折れ線を使う(切り替えは席にいるときだけ)
      if (!a.mtC) a.mtC = { chain: a.chain, cum: a.cum, len: a.len, focus: a.focus, tagOut: a.tagOut };
      const wantRv = visiting(id);
      if (!a.rvOn && wantRv && a.s <= 0.01 && !atMeeting(id) && a.rvC) {
        useChain(a, a.rvC); a.tagOut = a.rvKind === 'room' ? 0.3 : TAG_OUT; a.rvOn = true;
        if (a.rvStartFresh) { a.s = a.len; a.rvStartFresh = false; }
      } else if (a.rvOn && !wantRv && a.s <= 0.01) {
        useChain(a, a.mtC); a.tagOut = a.mtC.tagOut; a.rvOn = false; rvSlot.delete(id);
      }
    }
    if (a.chain) {
      const buchoBusy = asking() || (hearing != null && hearing.phase !== 'back') || (reporting != null && reporting.phase !== 'back');
      a.sTarget = (id === 'bucho' ? (a.rvOn ? reviewActive() && !buchoBusy : buchoBusy) : a.rvOn ? visiting(id) : atMeeting(id)) ? a.len : 0;
      const diff = a.sTarget - a.s;
      walking = !REDUCED_MOTION && Math.abs(diff) > 0.01;
      a.s = REDUCED_MOTION ? a.sTarget : a.s + Math.sign(diff) * Math.min(Math.abs(diff), WALK_SPEED * dt);
      let k = 1;
      while (k < a.cum.length - 1 && a.cum[k] < a.s) k++;
      const p0 = a.chain[k - 1];
      const p1 = a.chain[k];
      const f = THREE.MathUtils.clamp((a.s - a.cum[k - 1]) / Math.max(1e-6, a.cum[k] - a.cum[k - 1]), 0, 1);
      const x = p0.x + (p1.x - p0.x) * f;
      const z = p0.z + (p1.z - p0.z) * f;
      a.body.position.x = x - a.cfg.x;
      a.body.position.z = z - a.cfg.z;
      // 名札は席の前の床から、歩き出したらキャラの足元へ移ってついていく
      const seatZ = a.cfg.tagZ ?? (a.cfg.table ? 2.95 : 1.85);
      const m = Math.min(1, a.s / 1.5);
      // 会議では全員がテーブルを囲むので、名札はテーブルの外側へずらして重ならないようにする
      const ox = x - a.focus.x;
      const oz = z - a.focus.z;
      const od = Math.max(1e-6, Math.hypot(ox, oz));
      const out = a.tagOut ?? TAG_OUT;
      const tx = x + (ox / od) * out;
      const tz = z + (oz / od) * out;
      a.tagObj.element.classList.toggle('away', m > 0.05); // 歩いている間は役割・トークンを隠して幅を詰める
      a.tagObj.element.style.zIndex = m > 0 ? 60 : a.status === 'working' ? 55 : 50; // 動いている名札は、座っている人の名札の上に出す
      a.tagObj.position.set((tx - a.cfg.x) * m + (a.cfg.tagX ?? 0) * (1 - m), 0.1, seatZ * (1 - m) + (tz - a.cfg.z) * m);
      let face = 0; // 席では正面、会議の立ち位置ではテーブルの中心を向く
      if (walking) face = Math.atan2((p1.x - p0.x) * Math.sign(diff), (p1.z - p0.z) * Math.sign(diff));
      else if (a.s > 0.01) face = Math.atan2(a.focus.x - x, a.focus.z - z);
      let dr = face - a.facing;
      dr = Math.atan2(Math.sin(dr), Math.cos(dr));
      a.facing += REDUCED_MOTION ? dr : dr * 0.2;
      a.body.rotation.y = a.facing;
    }
    const away = a.chain && a.s > 0.01;
    const st = a.status ?? 'idle';
    const want = st === 'working' || st === 'done' || away ? 0.32 : 0;
    a.stand += (want - a.stand) * 0.08;
    let y = a.stand;
    let tilt = 0;
    if (walking) {
      y += Math.abs(Math.sin(t * 11 + a.phase)) * 0.1;
      a.arms[0].rotation.x = 0.2 + Math.sin(t * 11 + a.phase) * 0.5;
      a.arms[1].rotation.x = 0.2 - Math.sin(t * 11 + a.phase) * 0.5;
      a.head.rotation.x = 0;
    } else if (away && st !== 'done' && st !== 'waiting') {
      a.arms[0].rotation.x = a.arms[1].rotation.x = 0.2;
      a.head.rotation.x = 0;
    } else if (st === 'working') {
      y += Math.abs(Math.sin(t * 9 + a.phase)) * 0.04;
      a.arms[0].rotation.x = 0.35 + Math.sin(t * 16 + a.phase) * 0.18;
      a.arms[1].rotation.x = 0.35 + Math.sin(t * 16 + a.phase + Math.PI) * 0.18;
      a.head.rotation.x = 0.12;
    } else if (st === 'done') {
      y += Math.abs(Math.sin(t * 5 + a.phase)) * 0.18;
      a.arms[0].rotation.x = a.arms[1].rotation.x = -2.4;
      a.head.rotation.x = -0.1;
    } else if (st === 'waiting') {
      tilt = Math.sin(t * 2 + a.phase) * 0.18;
      a.arms[0].rotation.x = a.arms[1].rotation.x = 0.2;
      a.head.rotation.x = 0;
    } else {
      y += Math.sin(t * 1.8 + a.phase) * 0.012;
      a.arms[0].rotation.x = a.arms[1].rotation.x = 0.35;
      a.head.rotation.x = 0;
    }
    if (id === 'president' && a.asking) a.head.rotation.x = a.nodding && !REDUCED_MOTION ? -0.12 + Math.sin(t * 6) * 0.2 : -0.3; // 顔を上げて部長を見る。報告のときはうなずく
    a.body.position.y = y;
    if (a.ring) { a.ring.visible = st === 'working'; a.ring.position.y = 0.06 - y; a.ring.scale.setScalar(1 + Math.sin(t * 4 + a.phase) * 0.06); }
    a.head.rotation.z = tilt;
    const glow = st === 'working' && !away ? 0.55 + Math.sin(t * 4 + a.phase) * 0.15 : 0;
    a.laptopBack.material.emissive.set(a.cfg.color);
    a.laptopBack.material.emissiveIntensity = glow;
  }
  tickHearing();
  tickReporting();
  tickAssign();
  // 会議の長さは「全員が集まってから」数える(歩く時間で会議が削られないように)
  if (meeting && !meeting.gathered && meetingOn()) {
    const guests = [...avatars].filter(([id, a]) => a.chain && atMeeting(id));
    if (guests.every(([, a]) => a.s >= a.len - 0.01)) { meeting.gathered = true; meeting.until = Date.now() + MEETING_MS; }
  }
  hand.rotation.z = -t * 0.5;
  controls.update();
  renderer.render(scene, camera);
  labels.render(scene, camera);
  clampTags();
  requestAnimationFrame(animate);
}
animate();

// ---------- スマホ用QR(PC 側の画面だけ。遠隔用の口は /remote-info を返さない) ----------
(async () => {
  try {
    const r = await fetch('/remote-info', { cache: 'no-store' });
    // 404 = 遠隔が無効(OFFICE_REMOTE=1 なし)。PC の画面でだけ有効にする方法を案内する
    if (r.status === 404) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return;
      $('#qr').hidden = true;
      $('#phone-on').hidden = true;
      $('#phone-off').hidden = false;
      $('#phone').hidden = false;
      return;
    }
    const info = await r.json();
    if (!info?.url) return;
    const { default: qrcode } = await import('/vendor/qr/qrcode.mjs');
    const qr = qrcode(0, 'M');
    qr.addData(info.url);
    qr.make();
    $('#qr').src = qr.createDataURL(5, 8);
    $('#phone').hidden = false;
  } catch { /* QR が出せなくても本体の表示は止めない */ }
})();


// ---------- PC の画面だけで使う部品(エクスプローラー・コマンド窓・活動ログ)。遠隔・スマホ幅では出さない ----------
const pcOnly = () => ibInfo?.canSend === true && !mobileMq.matches;
function syncPcParts() {
  const on = pcOnly();
  $('#explorer').hidden = !on;
  if (on) cmdInit();
  $('#ib-cmd').hidden = !(on && cmdList.length);
  syncMic();
  if (!on) $('#cmd').hidden = true;
  renderActivity();
  layout();
}
mobileMq.addEventListener('change', syncPcParts);
// ---------- 音声入力(PC のみ。ブラウザ認識(Web Speech API)だけ。話すと同時に入力欄へ文字が入る。自動送信はしない) ----------
const micBtn = $('#ib-mic');
const micLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname); // サーバーの判定(ループバックのみ)と合わせる
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition; // 音声はブラウザ提供元のサーバーへ送られる
const MIC_UNSUPPORTED = 'このブラウザは音声認識に対応していません(Chrome または Edge で開いてください)';
const VM_CONSENT_KEY = 'office.voiceBrowserConsent';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動く */ } };
let voiceConsent = lsGet(VM_CONSENT_KEY) === '1';
let srRec = null; // SpeechRecognition
let srFinish = null; // 録音中の終了処理(onend が来ないときの保険用)
let srSendAfterStop = false; // 録音中に「送る」「Enter」が押された
let micState = 'idle'; // idle | starting | rec
function micSetState(st) {
  micState = st;
  micBtn.classList.toggle('rec', st === 'rec');
  micBtn.setAttribute('aria-pressed', st === 'rec' ? 'true' : 'false');
  micBtn.disabled = !SpeechRec || st === 'starting';
  micBtn.querySelector('.mic-label').textContent = st === 'rec' ? '聞き取り中(押して停止)' : '🎤 音声';
}
const SR_ERRORS = {
  'not-allowed': 'マイクの使用が許可されていません。アドレスバー左の鍵マークからマイクを許可してください',
  'service-not-allowed': 'このブラウザでは音声認識サービスが許可されていません。文字で入力してください',
  network: 'ネットワークに繋がらず、音声認識を使えませんでした。繋がってからもう一度押すか、文字で入力してください',
  'no-speech': '音声が聞こえませんでした。マイクに近づいて、もう一度押してください',
  'audio-capture': 'マイクが見つかりません。マイクの接続と、他のアプリが使っていないかを確認してください',
};
const SR_FALLBACK = '音声認識を使えませんでした。もう一度押すか、文字で入力してください';
const vNote = $('#ib-vnote');
// 末尾が「音声入力 終了」(空白・句読点・「修了」「終わり」・ひらがな/カタカナ・「します」等の揺れを許す)なら、その語句を除いた文字と stop=true を返す。文中にあるだけなら止めない
const VP = String.raw`[\s、,。.．，､・!！?？]*`;
const VOICE_STOP_RE = new RegExp(String.raw`${VP}(?:音\s*声|おんせい|オンセイ)\s*(?:入\s*力|にゅうりょく|ニュウリョク)${VP}(?:終\s*了|修\s*了|終わり|終り|おわり|しゅうりょう|シュウリョウ)(?:します|しました|する|です|でーす)?${VP}$`);
function voiceStopCheck(text) {
  const m = VOICE_STOP_RE.exec(text);
  return m ? { stop: true, text: text.slice(0, m.index) } : { stop: false, text };
}
// ?voicedebug=1 のときだけ出す診断表示(直近の認識文字列・状態遷移・押下の時刻)
const VDEBUG = new URLSearchParams(location.search).get('voicedebug') === '1';
const vdbgLines = [];
function vdbg(msg) {
  if (!VDEBUG) return;
  const d = new Date(), pad = (n, w = 2) => String(n).padStart(w, '0');
  vdbgLines.push(`${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${msg}`);
  if (vdbgLines.length > 12) vdbgLines.shift();
  let pre = $('#ib-vdebug');
  if (!pre) { pre = el('pre', null, ''); pre.id = 'ib-vdebug'; pre.style.cssText = 'margin:4px 0 0;font:11px/1.35 monospace;white-space:pre-wrap;max-height:9em;overflow:auto;opacity:.85'; $('#ib-voice').append(pre); }
  pre.textContent = vdbgLines.join('\n');
  $('#ib-voice').hidden = false;
}
function srStart() {
  if (micState !== 'idle') return;
  ibShowError('');
  let rec;
  try { rec = new SpeechRec(); } catch { ibShowError(SR_FALLBACK); return; }
  rec.lang = 'ja-JP'; rec.continuous = true; rec.interimResults = true;
  const base = ibText.value;
  let fin = '', interim = '', got = false, err = null, byVoice = false, ended = false;
  const join = (extra) => { const t = fin + extra; return !t ? base : base && !/\s$/.test(base) ? `${base} ${t}` : base + t; };
  const show = (extra) => { ibText.value = join(extra); ibResize(); };
  srRec = rec;
  for (const n of ['audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'nomatch']) rec[`on${n}`] = () => vdbg(n);
  rec.onstart = () => { vdbg('start'); micSetState('rec'); vNote.textContent = '話している途中の文字は仮表示です。話し終えると確定します'; $('#ib-voice').hidden = false; };
  rec.onresult = (e) => {
    if (byVoice || ended) return; // 「音声入力 終了」で止めた後に届く確定結果は取り込まない
    fin = ''; interim = ''; // 取りこぼし防止のため毎回、全結果から作り直す
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i], t = r[0]?.transcript ?? '';
      if (r.isFinal) fin += t; else interim += t;
    }
    vdbg(`result idx=${e.resultIndex} fin="${fin}" int="${interim}"`);
    // 確定+仮表示の末尾で判定(本物の Chrome は確定まで数秒遅れるため)。文中にあるだけなら止めない
    const v = voiceStopCheck(fin + interim);
    if (v.stop) { byVoice = true; fin = v.text; interim = ''; got = true; show(''); srStop(); return; }
    if (fin || interim) got = true;
    show(interim);
  };
  rec.onerror = (e) => { vdbg(`error ${e.error}`); err = e.error || 'unknown'; };
  const finish = () => { // onend、または stop() 後に onend が来ないときの保険から1回だけ呼ぶ
    if (ended) return;
    ended = true; vdbg('finish');
    if (srRec === rec) srRec = null;
    if (interim && !byVoice) { fin += interim; interim = ''; } // 仮のまま終わった分も捨てない
    show('');
    vNote.textContent = '';
    micSetState('idle');
    syncVoiceUi();
    if (byVoice) { vNote.textContent = '「音声入力 終了」で録音を止めました'; $('#ib-voice').hidden = false; }
    ibText.focus();
    const sendNow = srSendAfterStop; srSendAfterStop = false;
    if (sendNow && ibText.value.trim()) { ibSubmit(); return; } // 仮表示は上で入力欄へ取り込み済み
    if (err && err !== 'aborted') ibShowError(SR_ERRORS[err] ?? SR_FALLBACK);
    else if (!err && !got) ibShowError('聞き取れませんでした。もう一度話すか、文字で入力してください');
  };
  rec.onend = () => { vdbg('end'); finish(); };
  srFinish = finish;
  micSetState('starting');
  try { rec.start(); } catch { srRec = null; micSetState('idle'); ibShowError(SR_FALLBACK); }
}
function srStop(now = false) {
  const rec = srRec;
  if (!rec) return;
  vdbg(now ? 'stop(即時)' : 'stop');
  try { rec.stop(); } catch { /* ignore */ }
  if (now) { try { rec.abort(); } catch { /* ignore */ } srFinish?.(); return; } // 送る: onend を待たず、取り込み済みの文字で終了処理へ
  // 実機で stop() の後に onend が来ないことがある。1秒待って来なければ abort して強制的に終了処理へ進む
  setTimeout(() => { if (srRec === rec && micState !== 'idle') { try { rec.abort(); } catch { /* ignore */ } srFinish?.(); } }, 1000);
}
const consentBox = $('#ib-consent');
let consentThen = null;
function askConsent(then) { consentThen = then; consentBox.hidden = false; layout(); }
function closeConsent() { consentBox.hidden = true; consentThen = null; layout(); }
$('#ib-consent-yes').addEventListener('click', () => { voiceConsent = true; lsSet(VM_CONSENT_KEY, '1'); const f = consentThen; closeConsent(); f?.(); });
$('#ib-consent-no').addEventListener('click', () => closeConsent());
function syncVoiceUi() {
  if (micState === 'idle') vNote.textContent = SpeechRec ? '' : MIC_UNSUPPORTED;
  $('#ib-voice').hidden = !vNote.textContent;
}
micBtn.addEventListener('click', () => {
  vdbg('マイク押下');
  if (!SpeechRec) return;
  if (micState === 'idle') { if (!voiceConsent) askConsent(() => srStart()); else srStart(); }
  else if (micState === 'rec') srStop();
});
function syncMic() {
  const on = pcOnly() && micLocal;
  micBtn.hidden = !on;
  if (on) { micSetState(micState); syncVoiceUi(); }
  else $('#ib-voice').hidden = true;
  if (!on && srRec) { try { srRec.abort(); } catch { /* ignore */ } }
}

let pcShown = null;
setInterval(() => { const on = pcOnly(); if (on !== pcShown) { pcShown = on; syncPcParts(); } }, 400);

// --- 活動ログ ---
const KIND_LABEL = { prompt: '指示', tool: '作業', delegate: '依頼', subagent_start: '開始', subagent_done: '完了', ask: '質問', stop: '報告', waiting: '待ち', review: 'レビュー', error: '異常', session_start: '出社' };
const KIND_COLOR = { prompt: '#8c78d0', tool: '#6fb3e0', delegate: '#e8962e', subagent_start: '#4fa56d', subagent_done: '#4fa56d', ask: '#d9473f', stop: '#5a6fb0', waiting: '#e0a52e', review: '#9a7fe0', error: '#d9473f', session_start: '#9c92b3' };
let acSig = '';
function renderActivity() {
  const box = $('#activity');
  const list = current.activity;
  const show = pcOnly() && Array.isArray(list);
  box.hidden = !show;
  if (!show) { acSig = ''; return; }
  const sig = `${list.length}|${list[0]?.ts}|${list[0]?.text}|${list[list.length - 1]?.ts}`;
  if (sig === acSig) return;
  acSig = sig;
  $('#ac-count').textContent = `${list.length}件`;
  const ul = $('#ac-list');
  if (!list.length) { ul.replaceChildren(el('li', 'ac-row', 'まだ活動はありません')); return; }
  ul.replaceChildren(...list.slice(0, 200).map((r) => {
    const li = el('li', 'ac-row');
    li.style.setProperty('--kc', KIND_COLOR[r.kind] ?? '#9c92b3');
    const text = el('span', 'ac-text');
    text.append(el('i', '', KIND_LABEL[r.kind] ?? String(r.kind ?? '')), document.createTextNode(String(r.text ?? '')));
    li.append(el('span', 'ac-time', fmtTime(r.ts)), el('span', 'ac-who', nickForRole(String(r.who ?? ''))), text);
    return li;
  }));
}

// --- コマンド窓(許可リスト方式。GET /commands -> [{id,label}]、POST /command {id} -> {ok,output,truncated}) ---
let cmdList = [];
let cmdTried = false;
let cmdRunning = false;
const cmdBtn = $('#ib-cmd');
async function cmdInit() {
  if (cmdTried) return;
  cmdTried = true;
  try {
    const r = await fetch('/commands', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    cmdList = (Array.isArray(j) ? j : j?.commands ?? []).filter((c) => c && typeof c.id === 'string').map((c) => ({ id: c.id, label: String(c.label ?? c.id) }));
  } catch { cmdList = []; }
  cmdBtn.hidden = !(pcOnly() && cmdList.length);
  $('#cmd-list').replaceChildren(...cmdList.map((c) => {
    const li = el('li');
    const b = el('button', '', c.label);
    b.type = 'button';
    b.dataset.id = c.id;
    b.addEventListener('click', () => cmdRun(c, b));
    li.append(b);
    return li;
  }));
  layout();
}
cmdBtn.addEventListener('click', () => {
  const pop = $('#cmd');
  pop.hidden = !pop.hidden;
  cmdBtn.setAttribute('aria-expanded', String(!pop.hidden));
});
$('#cmd-close').addEventListener('click', () => { $('#cmd').hidden = true; cmdBtn.setAttribute('aria-expanded', 'false'); cmdBtn.focus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#cmd').hidden) $('#cmd-close').click(); });
async function cmdRun(c, btn) {
  if (cmdRunning) return;
  cmdRunning = true;
  const buttons = [...document.querySelectorAll('#cmd-list button')];
  for (const b of buttons) { b.disabled = true; b.classList.toggle('on', b === btn); }
  $('#cmd-result').hidden = false;
  $('#cmd-title').textContent = `${c.label}を実行しています…`;
  $('#cmd-out').textContent = '';
  try {
    const r = await fetch('/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id }) });
    let j = null;
    try { j = await r.json(); } catch { /* 本文が無い・壊れている */ }
    if (!r.ok || !j) {
      $('#cmd-title').textContent = `${c.label}: 実行できませんでした(${r.status === 403 ? 'この画面からは実行できません' : r.status === 409 ? '別のコマンドを実行中です' : `エラー ${r.status}`})`;
    } else {
      const lines = String(j.output ?? '').replace(/\r\n/g, '\n').split('\n');
      const cut = lines.length > 200;
      $('#cmd-out').textContent = lines.slice(0, 200).join('\n') || '(出力なし)';
      $('#cmd-title').textContent = `${c.label}: ${j.ok ? '完了' : '失敗または異常終了'}${cut || j.truncated ? '(長いため途中まで表示)' : ''}`;
    }
  } catch {
    $('#cmd-title').textContent = `${c.label}: サーバーに繋がっていません`;
  } finally {
    cmdRunning = false;
    for (const b of buttons) b.disabled = false;
  }
}

// --- エクスプローラー(GET /tree?path= -> {path, entries:[{name,type:'dir'|'file'}]}。名前だけ。中身は見せない) ---
const exBtn = $('#ex-toggle');
let exPath = '';
let exLoaded = false;
const exKindOf = (n) => (n === '参考資料' ? ['参考資料', 'ex-k-ref'] : n === '成果物' ? ['成果物', 'ex-k-out'] : n === 'その他' ? ['その他', 'ex-k-etc'] : null);
exBtn.addEventListener('click', () => {
  const open = exBtn.getAttribute('aria-expanded') !== 'true';
  exBtn.setAttribute('aria-expanded', String(open));
  $('#ex-body').hidden = !open;
  if (open && !exLoaded) exLoad('');
});
async function exLoad(path) {
  const ul = $('#ex-list');
  $('#ex-path').textContent = `/${path}`;
  ul.replaceChildren(el('li', 'ex-msg', '読み込み中…'));
  try {
    const r = await fetch(`/tree?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 403 ? 'この画面からは見られません' : r.status === 404 && !path ? '読み込めませんでした。フォルダが未設定か、見つかりません。「フォルダを選ぶ」で選んでください' : `読み込めませんでした(エラー ${r.status})`);
    const j = await r.json();
    exLoaded = true;
    $('#ex-root-name').textContent = typeof j.rootName === 'string' ? `📁 ${j.rootName}` : '';
    exPath = typeof j.path === 'string' ? j.path : path;
    $('#ex-path').textContent = `/${exPath}`;
    const rows = [];
    if (exPath) {
      const up = el('button', 'ex-row ex-up');
      up.type = 'button';
      up.append(el('span', 'ex-ico'), el('span', 'ex-name', '上のフォルダへ'));
      up.addEventListener('click', () => exLoad(exPath.split('/').slice(0, -1).join('/')));
      rows.push(up);
    }
    for (const e of Array.isArray(j.entries) ? j.entries : []) {
      const isDir = (e.type ?? e.kind) === 'dir';
      const name = String(e.name ?? '');
      const row = el(isDir ? 'button' : 'div', `ex-row ${isDir ? 'ex-dir' : 'ex-file'}`);
      if (isDir) { row.type = 'button'; row.addEventListener('click', () => exLoad(exPath ? `${exPath}/${name}` : name)); }
      row.title = name;
      row.append(el('span', 'ex-ico'), el('span', 'ex-name', name));
      const k = isDir ? exKindOf(name) : null;
      if (k) row.append(el('span', `ex-kind ${k[1]}`, k[0]));
      rows.push(row);
    }
    if (rows.length === (exPath ? 1 : 0)) rows.push(el('div', 'ex-msg', '中身はありません'));
    ul.replaceChildren(...rows.map((r) => { const li = el('li'); li.append(r); return li; }));
  } catch (err) {
    ul.replaceChildren(el('li', 'ex-msg err', err instanceof Error && /見られません|読み込めません/.test(err.message) ? err.message : 'サーバーに繋がっていません'));
  }
}

// --- フォルダを選ぶ(GET /browse?path=<絶対パス> -> {path, parent, entries:[{name}], isRoot, drives?} / POST /project-root {root})。フォルダ名だけ。PC の画面だけ ---
const BS = String.fromCharCode(92); // バックスラッシュ(Windows の区切り)
let pkPath = '';
let pkBusy = false;
$('#ex-pick').addEventListener('click', () => {
  const open = $('#ex-picker').hidden;
  $('#ex-picker').hidden = !open;
  if (open) pkLoad(''); // 一番上(ドライブ一覧)から。現在の場所は絶対パスを画面に持たないため
});
$('#ex-pk-cancel').addEventListener('click', () => { $('#ex-picker').hidden = true; });
async function pkLoad(path) {
  const ul = $('#ex-pk-list');
  $('#ex-pk-note').textContent = '';
  ul.replaceChildren(el('li', 'ex-msg', '読み込み中…'));
  try {
    const r = await fetch(`/browse?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 403 ? 'このフォルダは開けません' : `読み込めませんでした(エラー ${r.status})`);
    const j = await r.json();
    pkPath = typeof j.path === 'string' ? j.path : '';
    $('#ex-pk-path').textContent = pkPath || 'ドライブ一覧';
    $('#ex-pk-ok').disabled = !pkPath || j.isRoot === true; // ドライブ直下・一覧は選べない
    const rows = [];
    if (pkPath) {
      const up = el('button', 'ex-row ex-up');
      up.type = 'button';
      up.append(el('span', 'ex-ico'), el('span', 'ex-name', '上のフォルダへ'));
      up.addEventListener('click', () => pkLoad(j.parent ?? ''));
      rows.push(up);
    }
    const sep = pkPath.includes(BS) ? BS : '/';
    for (const e of Array.isArray(j.entries) ? j.entries : []) {
      const name = String(e.name ?? '');
      const row = el('button', 'ex-row ex-dir');
      row.type = 'button';
      row.title = name;
      row.append(el('span', 'ex-ico'), el('span', 'ex-name', name));
      row.addEventListener('click', () => pkLoad(j.drives ? name : pkPath.endsWith(sep) ? pkPath + name : pkPath + sep + name));
      rows.push(row);
    }
    if (rows.length === (pkPath ? 1 : 0)) rows.push(el('div', 'ex-msg', '中にフォルダはありません'));
    ul.replaceChildren(...rows.map((x) => { const li = el('li'); li.append(x); return li; }));
  } catch (err) {
    pkPath = '';
    $('#ex-pk-ok').disabled = true;
    ul.replaceChildren(el('li', 'ex-msg err', err instanceof Error && /開けません|読み込めません/.test(err.message) ? err.message : 'サーバーに繋がっていません'));
    // 開けないフォルダに入ってしまっても戻れるよう、一番上へ戻る行を出す
    const top = el('button', 'ex-row ex-up');
    top.type = 'button';
    top.append(el('span', 'ex-ico'), el('span', 'ex-name', '一番上へ戻る'));
    top.addEventListener('click', () => pkLoad(''));
    const li = el('li'); li.append(top); ul.append(li);
  }
}
$('#ex-pk-ok').addEventListener('click', async () => {
  if (pkBusy || !pkPath) return;
  pkBusy = true;
  $('#ex-pk-ok').disabled = true;
  try {
    const r = await fetch('/project-root', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: pkPath }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { $('#ex-pk-note').textContent = j.reason ?? `変えられませんでした(エラー ${r.status})`; return; }
    $('#ex-picker').hidden = true;
    exLoad('');
    if (!j.saved) $('#ex-path').textContent += '(保存できなかったため、再起動すると元に戻ります)';
  } catch { $('#ex-pk-note').textContent = 'サーバーに繋がっていません'; } finally { pkBusy = false; $('#ex-pk-ok').disabled = !pkPath; }
});
