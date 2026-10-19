import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { shots, blocking, SENSOR_MM, ASPECT } from './shots.js';
import { CHARACTER_URLS, CHARACTER_HEIGHTS, AUDIO_URLS } from './assets.js';

const D = THREE.MathUtils.degToRad;
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// убираем shadow acne на всех источниках
function fixShadows(root) { root.traverse(o => { if (o.isLight && o.shadow) { o.shadow.bias = -0.0008; o.shadow.normalBias = 0.03; } }); }

const camera = new THREE.PerspectiveCamera(40, ASPECT, 0.05, 300);
camera.filmGauge = SENSOR_MM;

// ---------- материалы и примитивы ----------
const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...o });
const M = {
  log: mat(0x5a4330), logDark: mat(0x3a2a1c), floor: mat(0x4a3826), wall: mat(0x8a7a5c),
  wallpaper: mat(0x9c8b6a), wood: mat(0x6b4a2e), woodDark: mat(0x3d2817), fabric: mat(0x6e6455),
  sheet: mat(0xe8e4da), white: mat(0xdedad0), metal: mat(0x888888, { metalness: 0.6, roughness: 0.4 }),
  glassLit: new THREE.MeshBasicMaterial({ color: 0xffc070 }), glassDark: mat(0x0b0f18, { roughness: 0.2 }),
  ground: mat(0x1d2416), roof: mat(0x2b2b2e), oilcloth: mat(0xb8a98a), tile: mat(0x6f7a6a),
  paper: mat(0xf2efe6), lamp: new THREE.MeshBasicMaterial({ color: 0xf0fff8 }),
  candle: mat(0xf3ead2), flame: new THREE.MeshBasicMaterial({ color: 0xffb040 }),
  night: new THREE.MeshBasicMaterial({ color: 0x05070c }),
};

function box(w, h, d, m, x, y, z, parent, ry = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z); mesh.rotation.y = ry;
  mesh.castShadow = true; mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}
function cyl(rt, rb, h, m, x, y, z, parent, seg = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}

// Комната: пол, потолок, 4 стены с проёмами. openings: [{wall:'n'|'s'|'e'|'w', at, w, h, sill}]
function room(parent, W, Dp, H, wallMat, openings = []) {
  box(W, 0.05, Dp, M.floor, 0, -0.025, 0, parent);
  box(W, 0.05, Dp, M.white, 0, H + 0.025, 0, parent).castShadow = false;
  const walls = { n: [W, -Dp / 2, 0], s: [W, Dp / 2, Math.PI], e: [Dp, W / 2, -Math.PI / 2], w: [Dp, -W / 2, Math.PI / 2] };
  for (const [k, [len, off, ry]] of Object.entries(walls)) {
    const g = new THREE.Group();
    g.rotation.y = ry;
    if (k === 'n' || k === 's') g.position.z = off; else g.position.x = off;
    // стена собирается из кусков вокруг проёмов
    const ops = openings.filter(o => o.wall === k).sort((a, b) => a.at - b.at);
    let cursor = -len / 2;
    for (const o of ops) {
      const l = o.at - o.w / 2;
      if (l > cursor) box(l - cursor, H, 0.12, wallMat, (cursor + l) / 2, H / 2, 0, g);
      if (o.sill > 0) box(o.w, o.sill, 0.12, wallMat, o.at, o.sill / 2, 0, g);
      const top = o.sill + o.h;
      if (top < H) box(o.w, H - top, 0.12, wallMat, o.at, (H + top) / 2, 0, g);
      cursor = o.at + o.w / 2;
    }
    if (cursor < len / 2) box(len / 2 - cursor, H, 0.12, wallMat, (cursor + len / 2) / 2, H / 2, 0, g);
    parent.add(g);
  }
}

// ---------- ЛОКАЦИИ ----------
function buildExterior() {
  const s = new THREE.Group();
  s.add(new THREE.HemisphereLight(0x3a4a6a, 0x0a0c08, 0.7));
  const moon = new THREE.DirectionalLight(0x8fa8d8, 0.9);
  moon.position.set(-20, 30, 10); moon.castShadow = true;
  moon.shadow.camera.left = -30; moon.shadow.camera.right = 30; moon.shadow.camera.top = 30; moon.shadow.camera.bottom = -30;
  moon.shadow.mapSize.set(2048, 2048);
  s.add(moon);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), M.ground);
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; s.add(ground);

  // сруб 8x6 м
  const house = new THREE.Group(); s.add(house);
  for (let i = 0; i < 11; i++) {
    const y = 0.15 + i * 0.26;
    cyl(0.14, 0.14, 8.3, M.log, 0, y, 3, house).rotation.z = Math.PI / 2;
    cyl(0.14, 0.14, 8.3, M.log, 0, y, -3, house).rotation.z = Math.PI / 2;
    cyl(0.14, 0.14, 6.3, M.log, 4, y + 0.13, 0, house).rotation.x = Math.PI / 2;
    cyl(0.14, 0.14, 6.3, M.log, -4, y + 0.13, 0, house).rotation.x = Math.PI / 2;
  }
  box(7.9, 2.9, 5.9, M.logDark, 0, 1.45, 0, house);
  // двускатная крыша
  for (const sgn of [1, -1]) {
    const r = box(9, 0.1, 4.0, M.roof, 0, 3.95, sgn * 1.6, house);
    r.rotation.x = sgn * D(35);
  }
  const gable = new THREE.Shape([new THREE.Vector2(-3.3, 0), new THREE.Vector2(3.3, 0), new THREE.Vector2(0, 2.3)]);
  for (const x of [4.05, -4.05]) {
    const g = new THREE.Mesh(new THREE.ShapeGeometry(gable), M.logDark);
    g.rotation.y = Math.PI / 2; g.position.set(x, 2.9, 0); house.add(g);
  }
  // окна фасада: кухня (-1.8) и сени (2.6) горят, остальные тёмные
  const win = (x, lit) => {
    box(0.9, 1.0, 0.05, lit ? M.glassLit : M.glassDark, x, 1.5, 3.16, house);
    box(1.05, 0.1, 0.12, M.wood, x, 0.95, 3.2, house); box(1.05, 0.1, 0.12, M.wood, x, 2.05, 3.2, house);
    if (lit) { const l = new THREE.PointLight(0xffb060, 6, 9, 1.6); l.position.set(x, 1.5, 3.8); house.add(l); }
  };
  win(-1.8, true); win(0.4, false); win(2.6, true);
  box(1.0, 2.0, 0.05, M.woodDark, 3.6, 1.0, 3.16, house); // дверь в сени
  // забор
  for (let x = -12; x <= 12; x += 0.35) box(0.08, 1.2 + Math.random() * 0.2, 0.03, M.woodDark, x, 0.6, 8, s);
  box(24, 0.07, 0.05, M.woodDark, 0, 0.9, 7.97, s);
  // лес
  const rnd = mulberry(7);
  const trunk = mat(0x2a2018), needle = mat(0x0f1a12);
  for (let i = 0; i < 260; i++) {
    const a = rnd() * Math.PI * 2, r = 13 + rnd() * 45;
    const x = Math.cos(a) * r, z = Math.sin(a) * r - 6;
    if (z > 9 && Math.abs(x) < 10) continue; // не загораживаем общий план
    const h = 14 + rnd() * 12;
    cyl(0.18, 0.3, h, trunk, x, h / 2, z, s, 6);
    const c = new THREE.Mesh(new THREE.ConeGeometry(2 + rnd(), h * 0.55, 7), needle);
    c.position.set(x, h * 0.72, z); c.castShadow = true; s.add(c);
  }
  s.fog = new THREE.FogExp2(0x0a1020, 0.028);
  s.background = new THREE.Color(0x0a1020);
  return s;
}

function buildLivingRoom() {
  const s = new THREE.Group();
  room(s, 5, 4.5, 2.5, M.wallpaper, [{ wall: 'e', at: 1.2, w: 0.9, h: 2.0, sill: 0 }]);
  s.add(new THREE.HemisphereLight(0x3a2a1a, 0x0a0806, 0.25));
  // гроб на двух табуретках
  for (const x of [-0.55, 0.55]) {
    box(0.36, 0.04, 0.36, M.wood, x, 0.45, 0, s);
    for (const dx of [-0.15, 0.15]) for (const dz of [-0.15, 0.15]) box(0.04, 0.45, 0.04, M.wood, x + dx, 0.225, dz, s);
  }
  const coffin = new THREE.Group(); coffin.position.set(0, 0.47, 0); s.add(coffin);
  box(1.95, 0.04, 0.6, M.woodDark, 0, 0.02, 0, coffin);
  box(1.95, 0.32, 0.04, M.wood, 0, 0.18, 0.3, coffin); box(1.95, 0.32, 0.04, M.wood, 0, 0.18, -0.3, coffin);
  box(0.04, 0.32, 0.6, M.wood, 0.98, 0.18, 0, coffin); box(0.04, 0.32, 0.6, M.wood, -0.98, 0.18, 0, coffin);
  box(1.85, 0.06, 0.52, M.sheet, 0, 0.07, 0, coffin);
  box(0.3, 0.08, 0.35, M.sheet, -0.78, 0.14, 0, coffin); // подушка
  // шифоньер в углу, кресла, тумба с телевизором
  box(1.1, 2.0, 0.6, M.woodDark, -1.85, 1.0, -1.9, s);
  const chair = (x, z, ry) => {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; s.add(g);
    box(0.75, 0.38, 0.75, M.fabric, 0, 0.19, 0, g); box(0.75, 0.55, 0.15, M.fabric, 0, 0.6, -0.3, g);
    box(0.13, 0.25, 0.75, M.fabric, 0.33, 0.5, 0, g); box(0.13, 0.25, 0.75, M.fabric, -0.33, 0.5, 0, g);
  };
  chair(-1.9, -0.4, Math.PI / 2); chair(-1.9, 0.6, Math.PI / 2);
  box(0.6, 0.6, 0.45, M.woodDark, 1.6, 0.3, -1.95, s);
  box(0.5, 0.4, 0.4, mat(0x222222), 1.6, 0.8, -1.95, s);
  // зеркало под простынёй
  box(0.7, 1.0, 0.03, M.metal, 0.3, 1.5, -2.18, s);
  const sheet = box(0.95, 1.5, 0.04, M.sheet, 0.3, 1.35, -2.13, s);
  sheet.scale.z = 1.5;
  // свечи: изголовье, стол у стены
  const candle = (x, y, z, i) => {
    cyl(0.012, 0.012, 0.18, M.candle, x, y + 0.09, z, s, 8);
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), M.flame); f.position.set(x, y + 0.2, z); s.add(f);
    const l = new THREE.PointLight(0xff9a40, 1.3, 5, 1.8); l.position.set(x, y + 0.24, z);
    l.castShadow = i < 2; l.shadow.mapSize.set(512, 512); l.userData.flicker = Math.random() * 10;
    s.add(l); flickers.push(l);
  };
  box(0.5, 0.75, 0.5, M.woodDark, -1.25, 0.375, 0, s);
  candle(-1.25, 0.75, 0.1, 0); candle(-1.3, 0.75, -0.12, 1);
  box(0.9, 0.75, 0.5, M.woodDark, 1.9, 0.375, 0.2, s);
  candle(1.85, 0.75, 0.2, 2); candle(2.0, 0.75, 0.35, 3); candle(1.95, 0.75, 0.05, 4);
  // дверной проём в сени - тёплая подсветка
  const door = new THREE.PointLight(0xffc080, 0.8, 4); door.position.set(2.9, 1.6, 1.2); s.add(door);
  s.background = new THREE.Color(0x000000);
  return s;
}

function buildKitchen() {
  const s = new THREE.Group();
  room(s, 4, 3.5, 2.5, M.wall, [
    { wall: 'n', at: 0, w: 1.1, h: 1.25, sill: 0.9 },
    { wall: 's', at: -1.1, w: 0.9, h: 2.0, sill: 0 },
  ]);
  // плитка-панель снизу стен
  box(3.9, 1.0, 0.02, M.tile, 0, 0.5, 1.68, s); box(0.02, 1.0, 3.4, M.tile, 1.93, 0.5, 0, s);
  box(0.02, 1.0, 3.4, M.tile, -1.93, 0.5, 0, s);
  // окно: тёмная ночь, распахнутые ставни
  box(1.1, 1.25, 0.02, M.night, 0, 1.525, -1.82, s);
  box(1.2, 0.06, 0.3, M.wood, 0, 0.9, -1.65, s);
  const shutter = (sgn) => { const sh = box(0.55, 1.25, 0.03, M.wood, sgn * 0.85, 1.525, -1.5, s); sh.rotation.y = sgn * D(-70); };
  shutter(1); shutter(-1);
  // стол со скатертью-клеёнкой
  box(1.5, 0.04, 0.8, M.oilcloth, 0, 0.74, -1.2, s);
  for (const dx of [-0.68, 0.68]) for (const dz of [-0.35, 0.35]) box(0.05, 0.72, 0.05, M.wood, dx, 0.36, -1.2 + dz, s);
  // альбом + кружки
  box(0.3, 0.01, 0.22, M.paper, -0.5, 0.765, -1.2, s, D(15));
  const drawing = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.2), new THREE.MeshBasicMaterial({ map: drawingTexture() }));
  drawing.rotation.x = -Math.PI / 2; drawing.rotation.z = D(15) + Math.PI / 2; drawing.position.set(-0.5, 0.772, -1.2); s.add(drawing);
  cyl(0.04, 0.035, 0.09, M.white, 0.65, 0.805, -1.15, s);
  cyl(0.04, 0.035, 0.09, M.white, -0.1, 0.805, -1.4, s);
  // стулья / табурет
  const stool = (x, z, h) => { box(0.38, 0.04, 0.38, M.wood, x, h - 0.02, z, s); for (const dx of [-0.16, 0.16]) for (const dz of [-0.16, 0.16]) box(0.035, h - 0.04, 0.035, M.wood, x + dx, (h - 0.04) / 2, z + dz, s); };
  stool(-1.1, -1.2, 0.46); stool(-0.3, -0.55, 0.46); stool(0.3, -0.55, 0.46); stool(1.1, -1.2, 0.56);
  // плита, шкафы
  box(0.6, 0.85, 0.6, M.white, -1.55, 0.425, 1.1, s);
  cyl(0.1, 0.12, 0.18, mat(0xd0d0c8), -1.6, 0.94, 1.0, s);
  box(1.6, 0.85, 0.55, M.wood, 0.9, 0.425, 1.42, s);
  box(1.6, 0.7, 0.33, M.wood, -0.6, 1.85, 1.58, s);
  // настенные часы на 10:47 (восточная стена)
  const clock = new THREE.Mesh(new THREE.CircleGeometry(0.16, 32), new THREE.MeshBasicMaterial({ map: clockTexture(10, 47) }));
  clock.position.set(0.6, 1.9, 1.67); clock.rotation.y = Math.PI; s.add(clock);
  cyl(0.17, 0.17, 0.03, M.woodDark, 0.6, 1.9, 1.69, s, 32).rotation.x = Math.PI / 2;
  // люминесцентные лампы
  for (const x of [-0.8, 0.8]) {
    box(1.2, 0.04, 0.08, M.lamp, x, 2.46, -0.4, s).castShadow = false;
    const p = new THREE.PointLight(0xe8fff4, 4.5, 7, 1.2); p.position.set(x, 2.35, -0.4);
    p.castShadow = true; p.shadow.mapSize.set(1024, 1024); s.add(p);
  }
  s.add(new THREE.HemisphereLight(0xd8f0e8, 0x3a3a30, 0.5));
  s.background = new THREE.Color(0x000000);
  return s;
}

function drawingTexture() {
  const c = document.createElement('canvas'); c.width = 280; c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f1e8'; g.fillRect(0, 0, 280, 200);
  g.strokeStyle = '#222'; g.lineWidth = 2;
  // доска
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#333' : '#ddd'; g.fillRect(110 + i * 15, 120 + j * 10, 15, 10); }
  // витязь
  g.beginPath(); g.arc(60, 70, 14, 0, 7); g.stroke(); g.beginPath(); g.moveTo(60, 56); g.lineTo(60, 46); g.stroke();
  g.strokeRect(45, 84, 30, 50); g.beginPath(); g.moveTo(80, 90); g.lineTo(100, 60); g.stroke();
  // тварь
  g.fillStyle = '#111'; g.beginPath(); g.ellipse(220, 90, 32, 48, 0, 0, 7); g.fill();
  g.fillStyle = '#c00'; g.beginPath(); g.arc(208, 72, 4, 0, 7); g.arc(232, 72, 4, 0, 7); g.fill();
  g.strokeStyle = '#111'; for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(195 + i * 12, 135); g.lineTo(185 + i * 14, 175); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function clockTexture(h, m) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f2efe4'; g.beginPath(); g.arc(128, 128, 126, 0, 7); g.fill();
  g.fillStyle = '#111'; g.font = 'bold 26px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 1; i <= 12; i++) { const a = i / 12 * Math.PI * 2; g.fillText(i, 128 + Math.sin(a) * 100, 128 - Math.cos(a) * 100); }
  const hand = (a, len, w) => { g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.sin(a) * len, 128 - Math.cos(a) * len); g.stroke(); };
  hand((h % 12 + m / 60) / 12 * Math.PI * 2, 60, 8); hand(m / 60 * Math.PI * 2, 92, 5);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------- ПЕРСОНАЖИ ----------
const loader = new GLTFLoader();
const charCache = {};

async function loadCharacter(id) {
  if (!charCache[id]) {
    charCache[id] = loader.loadAsync(CHARACTER_URLS[id]).then(gltf => {
      const root = gltf.scene;
      root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
      // нормализуем рост и ставим ступни на пол
      const b = new THREE.Box3().setFromObject(root);
      const k = CHARACTER_HEIGHTS[id] / (b.max.y - b.min.y);
      root.scale.multiplyScalar(k);
      root.updateMatrixWorld(true);
      const b2 = new THREE.Box3().setFromObject(root);
      root.position.y -= b2.min.y;
      root.position.x -= (b2.min.x + b2.max.x) / 2;
      root.position.z -= (b2.min.z + b2.max.z) / 2;
      return root;
    });
  }
  const proto = await charCache[id];
  const { clone } = await import('three/addons/utils/SkeletonUtils.js');
  return clone(proto);
}

function findBone(root, ...names) {
  let found = null;
  const want = names.map(n => n.toLowerCase());
  root.traverse(o => {
    if (found || !o.isBone) return;
    const n = o.name.toLowerCase().replace(/^mixamorig:?/, '').replace(/[_\s.]/g, '');
    if (want.includes(n)) found = o;
  });
  return found;
}

// поворот кости вокруг оси в мировых координатах персонажа (до установки в сцену)
const _q = new THREE.Quaternion(), _p = new THREE.Quaternion();
function rotWorld(bone, axis, deg) {
  if (!bone) return;
  bone.parent.getWorldQuaternion(_p);
  _q.setFromAxisAngle(axis, D(deg));
  const local = _p.clone().invert().multiply(_q).multiply(_p);
  bone.quaternion.premultiply(local);
  bone.updateMatrixWorld(true);
}
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

function applyPose(root, pose) {
  root.updateMatrixWorld(true);
  const b = n => findBone(root, ...n);
  const B = {
    hips: b(['hips', 'pelvis']), spine: b(['spine', 'spine01']), chest: b(['spine2', 'spine02', 'chest', 'spine1']),
    neck: b(['neck']), head: b(['head']),
    lArm: b(['leftarm', 'leftupperarm', 'lupperarm']), rArm: b(['rightarm', 'rightupperarm', 'rupperarm']),
    lFore: b(['leftforearm', 'leftlowerarm', 'lforearm']), rFore: b(['rightforearm', 'rightlowerarm', 'rforearm']),
    lUp: b(['leftupleg', 'leftthigh', 'leftupperleg', 'lthigh']), rUp: b(['rightupleg', 'rightthigh', 'rightupperleg', 'rthigh']),
    lLeg: b(['leftleg', 'leftcalf', 'leftlowerleg', 'lcalf']), rLeg: b(['rightleg', 'rightcalf', 'rightlowerleg', 'rcalf']),
  };
  // A-поза -> руки вдоль тела (персонаж смотрит в +Z, его левая рука в +X)
  const armsDown = () => { rotWorld(B.lArm, Z, -38); rotWorld(B.rArm, Z, 38); };
  const sit = () => {
    rotWorld(B.lUp, X, -88); rotWorld(B.rUp, X, -88);
    rotWorld(B.lLeg, X, 88); rotWorld(B.rLeg, X, 88);
  };
  switch (pose) {
    case 'stand': armsDown(); break;
    case 'stand_hands': // руки сложены перед собой
      armsDown(); rotWorld(B.lArm, X, -25); rotWorld(B.rArm, X, -25);
      rotWorld(B.lFore, X, -70); rotWorld(B.rFore, X, -70); rotWorld(B.head, X, 18); break;
    case 'sit': armsDown(); sit(); rotWorld(B.lArm, X, -30); rotWorld(B.rArm, X, -30); rotWorld(B.lFore, X, -50); rotWorld(B.rFore, X, -50); rotWorld(B.head, X, 15); break;
    case 'draw': armsDown(); sit(); rotWorld(B.chest, X, 15); rotWorld(B.lArm, X, -45); rotWorld(B.rArm, X, -45);
      rotWorld(B.lFore, X, -55); rotWorld(B.rFore, X, -55); rotWorld(B.head, X, 12); break;
    case 'point': armsDown(); sit(); rotWorld(B.lArm, Z, 110); rotWorld(B.lArm, Y, -20); rotWorld(B.rArm, X, -30); rotWorld(B.rFore, X, -50); rotWorld(B.head, Y, 55); rotWorld(B.head, X, -12); break;
    case 'lie': // руки сложены на груди
      armsDown(); rotWorld(B.lArm, X, -25); rotWorld(B.rArm, X, -25); rotWorld(B.lArm, Z, 12); rotWorld(B.rArm, Z, -12);
      rotWorld(B.lFore, Z, -100); rotWorld(B.rFore, Z, 100); rotWorld(B.lFore, X, -15); rotWorld(B.rFore, X, -15); break;
  }
  return B;
}

// Запасной манекен, если GLB не загрузился (например, CSP просмотрщика режет внешний CDN).
const COSTUME = {
  mother: [0x4a3f36, 0x2a2622], grandpa: [0x1c1c1e, 0x26262a], ilya: [0x7a3b34, 0x2e3440],
  fedya: [0x5a6f8c, 0x2e3440], vera: [0x9a8a70, 0x5a4a5a], yerema: [0x8a7a9c, 0x8a7a9c],
};
function makeMannequin(id) {
  const h = CHARACTER_HEIGHTS[id], [top, bottom] = COSTUME[id] || [0x888888, 0x555555];
  const skin = mat(0xd8b49a), mt = mat(top), mb = mat(bottom);
  const root = new THREE.Group();
  const part = (len, r, m, parent) => {
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(len - 2 * r, 0.01), 4, 8), m);
    mesh.position.y = -len / 2; mesh.castShadow = true; parent.add(mesh); return mesh;
  };
  const joint = (parent, x, y, z) => { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; };
  const hips = joint(root, 0, 0.52 * h, 0);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.09 * h, 0.16 * h, 4, 8), mt);
  torso.position.y = 0.15 * h; torso.scale.z = 0.7; torso.castShadow = true; hips.add(torso);
  const head = joint(hips, 0, 0.36 * h, 0);
  const hm = new THREE.Mesh(new THREE.SphereGeometry(0.065 * h, 16, 12), id === 'mother' ? mt : skin);
  hm.position.y = 0.04 * h; hm.castShadow = true; head.add(hm);
  const B = { hips, head, mannequin: true };
  for (const [side, sx] of [['l', 1], ['r', -1]]) {
    const up = joint(hips, sx * 0.055 * h, 0, 0); part(0.25 * h, 0.035 * h, mb, up);
    const low = joint(up, 0, -0.25 * h, 0); part(0.25 * h, 0.03 * h, mb, low);
    const arm = joint(hips, sx * 0.12 * h, 0.27 * h, 0); part(0.17 * h, 0.028 * h, mt, arm);
    const fore = joint(arm, 0, -0.17 * h, 0); part(0.16 * h, 0.024 * h, mt, fore);
    B[side + 'Up'] = up; B[side + 'Leg'] = low; B[side + 'Arm'] = arm; B[side + 'Fore'] = fore;
  }
  return { root, B };
}

// те же позы, что и для скелета: персонаж смотрит в +Z, его левая сторона в +X
function poseMannequin(B, pose) {
  const r = (o, x = 0, y = 0, z = 0) => { o.rotation.x += D(x); o.rotation.y += D(y); o.rotation.z += D(z); };
  const sit = () => { r(B.lUp, -88); r(B.rUp, -88); r(B.lLeg, 88); r(B.rLeg, 88); };
  switch (pose) {
    case 'stand_hands': r(B.lArm, -25); r(B.rArm, -25); r(B.lFore, -70); r(B.rFore, -70); r(B.head, 18); break;
    case 'sit': sit(); r(B.lArm, -30); r(B.rArm, -30); r(B.lFore, -50); r(B.rFore, -50); break;
    case 'draw': sit(); r(B.lArm, -45); r(B.rArm, -45); r(B.lFore, -55); r(B.rFore, -55); r(B.head, 12); break;
    case 'point': sit(); r(B.lArm, 0, 0, 110); r(B.rArm, -30); r(B.rFore, -50); r(B.head, -12, 55); break;
    case 'lie': r(B.lArm, -25); r(B.rArm, -25); r(B.lFore, 0, 0, -100); r(B.rFore, 0, 0, 100); break;
  }
  B.hips.updateMatrixWorld(true);
}

let usedFallback = false;
async function placeCharacters(sceneNo, group) {
  for (const c of blocking[sceneNo] || []) {
    if (!CHARACTER_URLS[c.id]) continue;
    let ch, B;
    try {
      ch = await loadCharacter(c.id);
    } catch (e) {
      usedFallback = true;
      ({ root: ch, B } = makeMannequin(c.id));
    }
    const holder = new THREE.Group();
    holder.add(ch);
    if (B) poseMannequin(B, c.pose); else B = applyPose(ch, c.pose);
    if (c.seat !== undefined && B.hips) {
      ch.updateMatrixWorld(true);
      const hp = B.hips.getWorldPosition(new THREE.Vector3());
      ch.position.y += (c.seat + 0.07) - hp.y; // таз на высоту сиденья
      ch.position.z -= hp.z - 0.0;
    }
    if (c.pose === 'lie') holder.rotation.set(-Math.PI / 2, 0, 0, 'YXZ');
    holder.rotation.y = D(c.rotY || 0);
    if (c.pose === 'lie') {
      // лёжа: голова к -X (изголовье), лицо вверх
      holder.rotation.set(0, 0, 0);
      const inner = new THREE.Group(); inner.rotation.x = -Math.PI / 2; inner.add(ch);
      ch.position.y = 0; ch.position.z = 0;
      const b = new THREE.Box3().setFromObject(ch); ch.position.y -= (b.min.y + b.max.y) / 2;
      holder.add(inner); holder.rotation.y = D(c.rotY);
      inner.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(inner); inner.position.y -= bb.min.y;
    }
    holder.position.set(...c.pos);
    holder.name = c.id;
    group.add(holder);
  }
}

// ---------- СЦЕНЫ И ВОСПРОИЗВЕДЕНИЕ ----------
const flickers = [];
const builders = { 1: buildExterior, 2: buildLivingRoom, 3: buildKitchen };
const scenes = {};
async function getScene(n) {
  if (!scenes[n]) {
    const sc = new THREE.Scene();
    const set = builders[n]();
    if (set.fog) sc.fog = set.fog;
    sc.background = set.background;
    sc.add(set);
    await placeCharacters(n, sc);
    fixShadows(sc);
    scenes[n] = sc;
  }
  return scenes[n];
}

const lerp3 = (a, b, t) => a.map((v, i) => v + ((b ?? a)[i] - v) * t);
const ease = t => t * t * (3 - 2 * t);
function setupCamera(shot, t) {
  const e = ease(t);
  camera.position.set(...lerp3(shot.cam, shot.camEnd, e));
  camera.lookAt(new THREE.Vector3(...lerp3(shot.look, shot.lookEnd, e)));
  camera.setFocalLength(shot.lensEnd ? shot.lens + (shot.lensEnd - shot.lens) * e : shot.lens);
  camera.aspect = ASPECT; camera.updateProjectionMatrix();
}

const hud = document.getElementById('hud');
async function renderShot(id, t = 0) {
  const shot = shots.find(s => s.id === id);
  const sc = await getScene(shot.scene);
  setupCamera(shot, t);
  const time = performance.now() / 1000;
  for (const l of flickers) l.intensity = 1.3 * (0.85 + 0.15 * Math.sin(time * 9 + l.userData.flicker) * Math.sin(time * 5.3 + l.userData.flicker * 2));
  renderer.render(sc, camera);
  if (hud) hud.innerHTML = `<b>${shot.id}</b> · Сц.${shot.scene} · ${camera.getFocalLength().toFixed(0)} мм (S35) · ${shot.dur}с<br>${shot.desc}`;
  const sub = document.getElementById('sub');
  if (sub) {
    const sec = t * shot.dur;
    const line = (shot.lines || []).find(l => sec >= l.at && sec < l.at + l.len);
    sub.innerHTML = line ? `<span class="who">${line.who}</span> ${line.text}` : '';
    sub.hidden = !line;
  }
  const note = document.getElementById('fallback');
  if (note) note.hidden = !usedFallback;
  return shot;
}

function resize() {
  const w = canvas.parentElement.clientWidth;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, Math.round(w / ASPECT), false);
}
window.addEventListener('resize', resize);
resize();

// список шотов
const list = document.getElementById('shots');
let current = shots[0].id, playing = false, t0 = 0, playIndex = 0;
if (list) {
  const sceneNames = { 1: 'Сц. 1 · Нат. дом Громовых · ночь', 2: 'Сц. 2 · Инт. гостиная · ночь', 3: 'Сц. 3 · Инт. кухня · ночь' };
  let lastScene = null;
  for (const s of shots) {
    if (s.scene !== lastScene) {
      lastScene = s.scene;
      const h = document.createElement('div'); h.className = 'scene'; h.textContent = sceneNames[s.scene] || `Сц. ${s.scene}`;
      list.appendChild(h);
    }
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.onclick(); } };
    li.innerHTML = `<b>${s.id}</b> <span>${s.lens}мм · ${s.dur}с</span><div>${s.desc}</div>`;
    li.onclick = () => { setPlaying(false); current = s.id; mark(); renderShot(current, 0); };
    li.dataset.id = s.id; list.appendChild(li);
  }
}
// озвучка: реплики шота запускаются по таймерам от начала шота
const audioCache = {};
let audioTimers = [];
function stopAudio() {
  audioTimers.forEach(clearTimeout); audioTimers = [];
  Object.values(audioCache).forEach(a => { a.pause(); a.currentTime = 0; });
}
function startShotAudio(shot) {
  for (const l of shot.lines || []) {
    const a = audioCache[l.audio] ||= new Audio(AUDIO_URLS[l.audio]);
    audioTimers.push(setTimeout(() => { a.currentTime = 0; a.play().catch(() => {}); }, l.at * 1000));
  }
}
function setPlaying(on) {
  playing = on;
  const btn = document.getElementById('play');
  if (btn) btn.textContent = on ? '■ Стоп' : '▶ Аниматик';
  stopAudio();
  if (on) { playIndex = shots.findIndex(s => s.id === current); t0 = performance.now(); startShotAudio(shots[playIndex]); }
}

function mark() { list?.querySelectorAll('li').forEach(li => li.classList.toggle('on', li.dataset.id === current)); }

document.getElementById('play')?.addEventListener('click', () => setPlaying(!playing));

async function loop() {
  if (playing) {
    const shot = shots[playIndex];
    const t = (performance.now() - t0) / 1000 / shot.dur;
    if (t >= 1) { playIndex = (playIndex + 1) % shots.length; t0 = performance.now(); current = shots[playIndex].id; mark(); startShotAudio(shots[playIndex]); }
    await renderShot(current, Math.min(t, 1));
  } else {
    await renderShot(current, 0);
  }
  requestAnimationFrame(loop);
}

// API для headless-рендера
window.previz = { renderShot, shots, ready: Promise.all([1, 2, 3].map(getScene)) };
const params = new URLSearchParams(location.search);
if (!params.has('headless')) { mark(); window.previz.ready.then(loop); }
