import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { sfx, unlockAudio } from './audio.js';

// ---------------------------------------------------------------------------
// Physics happens in 2D on the table plane: x runs left/right, z runs from the
// top of the table (negative) down to the player (positive). Gravity pulls +z,
// as if the table were tilted toward the player. Rendering maps (x, z) onto a
// 3D table that is tilted for looks only.
// ---------------------------------------------------------------------------

const BALL_R = 1.35;
const GRAVITY = 150;
const DAMPING = 0.12;
const MAX_SPEED = 380;
const WALL_BOUNCE = 0.55;
const DRAIN_Z = 53;

const PLAY_LEFT = -28;
const LANE_INNER = 24;
const LANE_OUTER = 28;
const ARC_CENTER_Z = -30;
const ARC_R = 28;

const FLIPPER_LEN = 10.5;
const FLIPPER_R = 1.3;
const FLIPPER_REST = 0.58;    // rad below horizontal (tip down toward drain)
const FLIPPER_ACTIVE = -0.50; // rad above horizontal (tip flicked up)
const FLIPPER_UP_SPEED = 24;
const FLIPPER_DOWN_SPEED = 10;

const PLUNGER_POS = { x: 26, z: 45.5 };
const GATE_Z = -27;

// --- tiny 2D vector helpers ------------------------------------------------

const len2 = (x, z) => Math.hypot(x, z);

function closestOnSegment(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const abLen2 = abx * abx + abz * abz;
  let t = abLen2 === 0 ? 0 : ((px - ax) * abx + (pz - az) * abz) / abLen2;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + t * abx, z: az + t * abz, t };
}

// --- table layout ------------------------------------------------------------

function arcPoints(n) {
  // Top of the table: half circle from the left wall over to the right wall.
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const phi = Math.PI - (i / n) * Math.PI; // 180° (left) -> 0° (right)
    pts.push({ x: ARC_R * Math.cos(phi), z: ARC_CENTER_Z - ARC_R * Math.sin(phi) });
  }
  return pts;
}

function buildSegments() {
  const segs = [];
  const add = (a, b, opts = {}) => segs.push({ a, b, bounce: WALL_BOUNCE, kick: 0, score: 0, ...opts });

  // Outer walls
  add({ x: PLAY_LEFT, z: 34 }, { x: PLAY_LEFT, z: ARC_CENTER_Z });          // left wall
  add({ x: LANE_OUTER, z: ARC_CENTER_Z }, { x: LANE_OUTER, z: 48 });        // right outer wall (plunger lane)
  add({ x: LANE_INNER, z: 48 }, { x: LANE_OUTER, z: 48 });                  // plunger lane floor
  const arc = arcPoints(28);
  for (let i = 0; i < arc.length - 1; i++) add(arc[i], arc[i + 1]);

  // Plunger lane inner wall (also the playfield's right edge)
  add({ x: LANE_INNER, z: GATE_Z + 1 }, { x: LANE_INNER, z: 34 });

  // One-way gate at the top of the plunger lane: the ball launches up through
  // it but cannot fall back into the lane from the playfield.
  add({ x: LANE_INNER, z: GATE_Z }, { x: LANE_OUTER, z: GATE_Z }, { oneWayUp: true, bounce: 0.2 });

  // Bottom funnels toward the flippers, with a slingshot section in the middle
  const funnel = (side) => {
    const s = side; // -1 left, +1 right
    const x0 = s < 0 ? PLAY_LEFT : LANE_INNER;
    const p0 = { x: x0, z: 34 };
    const p3 = { x: s * 12.6, z: 43.6 };
    const lerp = (t) => ({ x: p0.x + (p3.x - p0.x) * t, z: p0.z + (p3.z - p0.z) * t });
    const p1 = lerp(0.2);
    const p2 = lerp(0.78);
    add(p0, p1);
    add(p1, p2, { kick: 60, score: 25, sling: true, bounce: 0.7 });
    add(p2, p3);
    return { p1, p2 };
  };
  const slingL = funnel(-1);
  const slingR = funnel(1);

  return { segs, slingL, slingR };
}

const BUMPERS = [
  { x: 0, z: -41, r: 3.3, kick: 90, score: 100 },
  { x: -10, z: -30, r: 3.3, kick: 90, score: 100 },
  { x: 10, z: -30, r: 3.3, kick: 90, score: 100 },
];

// --- flippers ----------------------------------------------------------------

class Flipper {
  constructor(side) {
    this.side = side;       // -1 left, +1 right (pivot placement)
    this.dirX = -side;      // paddle points toward the table center
    this.pivot = { x: side * 12, z: 44 };
    this.angle = FLIPPER_REST;
    this.omega = 0;
    this.pressed = false;
  }
  dir(angle = this.angle) {
    return { x: this.dirX * Math.cos(angle), z: Math.sin(angle) };
  }
  tip(angle = this.angle) {
    const d = this.dir(angle);
    return { x: this.pivot.x + FLIPPER_LEN * d.x, z: this.pivot.z + FLIPPER_LEN * d.z };
  }
  step(h) {
    const target = this.pressed ? FLIPPER_ACTIVE : FLIPPER_REST;
    const speed = this.pressed ? FLIPPER_UP_SPEED : FLIPPER_DOWN_SPEED;
    const prev = this.angle;
    const delta = target - this.angle;
    const move = Math.sign(delta) * Math.min(Math.abs(delta), speed * h);
    this.angle += move;
    this.omega = (this.angle - prev) / h;
  }
}

// --- game state ----------------------------------------------------------------

const { segs: SEGMENTS, slingL, slingR } = buildSegments();
const flippers = [new Flipper(-1), new Flipper(1)];

const game = {
  score: 0,
  hiscore: Number(localStorage.getItem('flipperdelux.hiscore') || 0),
  balls: 3,
  state: 'ready', // ready | play | over
  power: 0,
  charging: false,
  ball: { x: PLUNGER_POS.x, z: PLUNGER_POS.z, vx: 0, vz: 0 },
};

function resetBall() {
  game.ball.x = PLUNGER_POS.x;
  game.ball.z = PLUNGER_POS.z;
  game.ball.vx = 0;
  game.ball.vz = 0;
  game.state = 'ready';
  game.power = 0;
  game.charging = false;
}

function newGame() {
  game.score = 0;
  game.balls = 3;
  resetBall();
  updateHud();
  showMessage('HOLD SPACE TO LAUNCH');
}

function addScore(points) {
  game.score += points;
  if (game.score > game.hiscore) {
    game.hiscore = game.score;
    localStorage.setItem('flipperdelux.hiscore', String(game.hiscore));
  }
  updateHud();
}

// --- physics step ----------------------------------------------------------------

function collideSegment(ball, seg) {
  if (seg.oneWayUp && ball.vz < 0) return false; // moving up-table: pass through
  const cp = closestOnSegment(ball.x, ball.z, seg.a.x, seg.a.z, seg.b.x, seg.b.z);
  const dx = ball.x - cp.x, dz = ball.z - cp.z;
  const dist = len2(dx, dz);
  if (dist >= BALL_R || dist === 0) return false;
  const nx = dx / dist, nz = dz / dist;
  const pen = BALL_R - dist;
  ball.x += nx * pen;
  ball.z += nz * pen;
  const vn = ball.vx * nx + ball.vz * nz;
  if (vn < 0) {
    ball.vx -= (1 + seg.bounce) * vn * nx;
    ball.vz -= (1 + seg.bounce) * vn * nz;
    if (seg.kick) {
      ball.vx += nx * seg.kick;
      ball.vz += nz * seg.kick;
    }
    return true;
  }
  return false;
}

function collideBumper(ball, b, now) {
  const dx = ball.x - b.x, dz = ball.z - b.z;
  const dist = len2(dx, dz);
  const minDist = BALL_R + b.r;
  if (dist >= minDist || dist === 0) return false;
  const nx = dx / dist, nz = dz / dist;
  ball.x += nx * (minDist - dist);
  ball.z += nz * (minDist - dist);
  const vn = ball.vx * nx + ball.vz * nz;
  if (vn < 0) {
    ball.vx -= 2 * vn * nx;
    ball.vz -= 2 * vn * nz;
  }
  ball.vx += nx * b.kick;
  ball.vz += nz * b.kick;
  if (!b.lastHit || now - b.lastHit > 0.08) {
    b.lastHit = now;
    addScore(b.score);
    sfx.bumper();
    b.flash = 1;
  }
  return true;
}

function collideFlipper(ball, f) {
  const tip = f.tip();
  const cp = closestOnSegment(ball.x, ball.z, f.pivot.x, f.pivot.z, tip.x, tip.z);
  const dx = ball.x - cp.x, dz = ball.z - cp.z;
  const dist = len2(dx, dz);
  const minDist = BALL_R + FLIPPER_R;
  if (dist >= minDist || dist === 0) return false;
  const nx = dx / dist, nz = dz / dist;
  ball.x += nx * (minDist - dist);
  ball.z += nz * (minDist - dist);
  // Surface velocity of the contact point: v = dθ/dt · d(pos)/dθ. With the
  // segment parameterized as pivot + s·L·(dirX·cosθ, sinθ) and r = cp - pivot,
  // that derivative works out to (-dirX·r.z, dirX·r.x).
  const rx = cp.x - f.pivot.x, rz = cp.z - f.pivot.z;
  const svx = -f.dirX * f.omega * rz;
  const svz = f.dirX * f.omega * rx;
  const rvx = ball.vx - svx, rvz = ball.vz - svz;
  const vn = rvx * nx + rvz * nz;
  if (vn < 0) {
    const e = 0.45;
    ball.vx -= (1 + e) * vn * nx;
    ball.vz -= (1 + e) * vn * nz;
    return true;
  }
  return false;
}

let slingFlashL = 0, slingFlashR = 0;

function physicsStep(h, now) {
  const ball = game.ball;

  for (const f of flippers) f.step(h);

  if (game.state === 'ready') return; // ball parked on the plunger

  ball.vz += GRAVITY * h;
  const damp = Math.max(0, 1 - DAMPING * h);
  ball.vx *= damp;
  ball.vz *= damp;
  const speed = len2(ball.vx, ball.vz);
  if (speed > MAX_SPEED) {
    ball.vx *= MAX_SPEED / speed;
    ball.vz *= MAX_SPEED / speed;
  }
  ball.x += ball.vx * h;
  ball.z += ball.vz * h;

  for (const seg of SEGMENTS) {
    const hit = collideSegment(ball, seg);
    if (hit && seg.sling) {
      addScore(seg.score);
      sfx.sling();
      if (seg.a.x < 0) slingFlashL = 1; else slingFlashR = 1;
    } else if (hit && len2(ball.vx, ball.vz) > 60) {
      sfx.wall();
    }
  }
  for (const b of BUMPERS) collideBumper(ball, b, now);
  for (const f of flippers) collideFlipper(ball, f);

  // Ball fell back down the plunger lane after a weak launch: re-arm.
  if (game.state === 'play' && ball.x > LANE_INNER && ball.z > 43 && len2(ball.vx, ball.vz) < 8) {
    resetBall();
    showMessage('HOLD SPACE TO LAUNCH');
  }

  if (ball.z > DRAIN_Z) drained();
}

function drained() {
  game.balls -= 1;
  updateHud();
  if (game.balls > 0) {
    sfx.drain();
    resetBall();
    showMessage('HOLD SPACE TO LAUNCH');
  } else {
    sfx.gameOver();
    game.state = 'over';
    showMessage(`GAME OVER\nSCORE ${game.score.toLocaleString()}  ·  PRESS R`);
  }
}

// --- input ----------------------------------------------------------------

const keys = { left: false, right: false, space: false };

function setFlipper(side, pressed) {
  const f = side < 0 ? flippers[0] : flippers[1];
  if (pressed && !f.pressed) sfx.flip();
  f.pressed = pressed;
}

function chargeStart() {
  if (game.state === 'ready') {
    game.charging = true;
  }
}

function chargeRelease() {
  if (game.state === 'ready' && game.charging) {
    const power = Math.max(0.25, game.power);
    game.ball.vz = -(160 + 210 * power);
    game.ball.vx = 0;
    game.state = 'play';
    game.charging = false;
    game.power = 0;
    sfx.launch();
    showMessage('');
  }
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  unlockAudio();
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') setFlipper(-1, true);
  if (e.code === 'KeyL' || e.code === 'ArrowRight') setFlipper(1, true);
  if (e.code === 'Space') { e.preventDefault(); keys.space = true; chargeStart(); }
  if (e.code === 'KeyR' && game.state === 'over') { sfx.newBall(); newGame(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') setFlipper(-1, false);
  if (e.code === 'KeyL' || e.code === 'ArrowRight') setFlipper(1, false);
  if (e.code === 'Space') { keys.space = false; chargeRelease(); }
});

// Touch: left half of the screen = left flipper, right half = right flipper.
window.addEventListener('touchstart', (e) => {
  unlockAudio();
  for (const t of e.changedTouches) {
    if (t.target === launchBtn) continue;
    setFlipper(t.clientX < window.innerWidth / 2 ? -1 : 1, true);
  }
}, { passive: true });
window.addEventListener('touchend', () => {
  setFlipper(-1, false);
  setFlipper(1, false);
}, { passive: true });

const launchBtn = document.getElementById('launchBtn');
launchBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); unlockAudio(); chargeStart(); });
launchBtn.addEventListener('pointerup', (e) => { e.preventDefault(); chargeRelease(); });

// --- HUD ----------------------------------------------------------------

const scoreEl = document.getElementById('score');
const hiscoreEl = document.getElementById('hiscore');
const ballsEl = document.getElementById('balls');
const messageEl = document.getElementById('message');
const powerEl = document.getElementById('power');
const powerFill = powerEl.firstElementChild;

function updateHud() {
  scoreEl.textContent = game.score.toLocaleString();
  hiscoreEl.textContent = `HI ${game.hiscore.toLocaleString()}`;
  ballsEl.textContent = '●'.repeat(Math.max(0, game.balls));
}

function showMessage(text) {
  messageEl.textContent = text;
}

// --- rendering ----------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05030f);
scene.fog = new THREE.Fog(0x05030f, 160, 320);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 500);
camera.position.set(0, 78, 108);
camera.lookAt(0, 0, 0);

// The whole table lives in this group; tilting it is purely cosmetic.
const table = new THREE.Group();
table.rotation.x = -0.10;
table.position.y = -4;
scene.add(table);

// Lights
scene.add(new THREE.AmbientLight(0x404060, 1.2));
const keyLight = new THREE.DirectionalLight(0xfff2e0, 2.2);
keyLight.position.set(-30, 80, 40);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -45;
keyLight.shadow.camera.right = 45;
keyLight.shadow.camera.top = 70;
keyLight.shadow.camera.bottom = -70;
scene.add(keyLight);
const pink = new THREE.PointLight(0xff3fa4, 320, 120);
pink.position.set(-24, 26, -30);
table.add(pink);
const cyan = new THREE.PointLight(0x2fd4ff, 320, 120);
cyan.position.set(24, 26, 10);
table.add(cyan);

// Materials
const wallMat = new THREE.MeshStandardMaterial({ color: 0x8f7bff, metalness: 0.6, roughness: 0.35 });
const floorMat = new THREE.MeshStandardMaterial({ color: 0x140b33, metalness: 0.3, roughness: 0.7 });
const ballMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1.0, roughness: 0.08 });
const flipperMat = new THREE.MeshStandardMaterial({ color: 0xff4470, metalness: 0.5, roughness: 0.3, emissive: 0x550018 });
const bumperMat = new THREE.MeshStandardMaterial({ color: 0x222244, metalness: 0.7, roughness: 0.3 });

// Floor
{
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(64, 116), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -3);
  floor.receiveShadow = true;
  table.add(floor);
  // Decorative glowing arcs on the playfield
  const decoMat = new THREE.MeshBasicMaterial({ color: 0x5533ff });
  for (const [radius, y] of [[16, 0.06], [20, 0.06]]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.35, radius, 64, 1, Math.PI * 0.15, Math.PI * 0.7), decoMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, y, -18);
    table.add(ring);
  }
}

// Walls from physics segments
const WALL_H = 3.2;
const slingMeshes = { L: null, R: null };
for (const seg of SEGMENTS) {
  const dx = seg.b.x - seg.a.x, dz = seg.b.z - seg.a.z;
  const length = len2(dx, dz);
  const isSling = !!seg.sling;
  const isGate = !!seg.oneWayUp;
  const mat = isSling
    ? new THREE.MeshStandardMaterial({ color: 0xff9a2f, metalness: 0.4, roughness: 0.3, emissive: 0xa03c00, emissiveIntensity: 0.8 })
    : isGate
      ? new THREE.MeshStandardMaterial({ color: 0x44ff99, transparent: true, opacity: 0.25, emissive: 0x22aa66 })
      : wallMat;
  const h = isGate ? 1.2 : WALL_H;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, h, 1.3), mat);
  mesh.position.set((seg.a.x + seg.b.x) / 2, h / 2, (seg.a.z + seg.b.z) / 2);
  mesh.rotation.y = -Math.atan2(dz, dx);
  mesh.castShadow = !isGate;
  mesh.receiveShadow = true;
  table.add(mesh);
  if (isSling) slingMeshes[seg.a.x < 0 ? 'L' : 'R'] = mesh;
  // Round the wall joints with small posts
  for (const p of [seg.a, seg.b]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, h, 12), isGate ? mat : wallMat);
    post.position.set(p.x, h / 2, p.z);
    table.add(post);
  }
}

// Bumpers
const bumperVisuals = [];
for (const b of BUMPERS) {
  const group = new THREE.Group();
  group.position.set(b.x, 0, b.z);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(b.r, b.r * 1.12, 2.6, 32), bumperMat);
  body.position.y = 1.3;
  body.castShadow = true;
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(b.r * 0.7, b.r * 0.7, 1.2, 32),
    new THREE.MeshStandardMaterial({ color: 0xff2266, emissive: 0xff2266, emissiveIntensity: 0.6 })
  );
  cap.position.y = 3.2;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(b.r * 0.95, 0.28, 12, 40),
    new THREE.MeshStandardMaterial({ color: 0x2fd4ff, emissive: 0x2fd4ff, emissiveIntensity: 1.2 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 2.7;
  group.add(body, cap, ring);
  table.add(group);
  bumperVisuals.push({ b, cap, ring, baseY: group.position.y, group });
}

// Flippers
const flipperVisuals = flippers.map((f) => {
  const group = new THREE.Group();
  group.position.set(f.pivot.x, FLIPPER_R + 0.2, f.pivot.z);
  const geo = new THREE.CapsuleGeometry(FLIPPER_R, FLIPPER_LEN, 6, 16);
  geo.rotateZ(Math.PI / 2);          // capsule along +x
  geo.translate(FLIPPER_LEN / 2, 0, 0); // pivot at one end
  const mesh = new THREE.Mesh(geo, flipperMat);
  mesh.castShadow = true;
  group.add(mesh);
  const hinge = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 3, 20), wallMat);
  group.add(hinge);
  table.add(group);
  return { f, group };
});

// Ball
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 32, 32), ballMat);
ballMesh.castShadow = true;
table.add(ballMesh);
const ballGlow = new THREE.PointLight(0xaaccff, 60, 18);
table.add(ballGlow);

// Plunger
const plunger = new THREE.Mesh(
  new THREE.CylinderGeometry(1.1, 1.1, 4, 16),
  new THREE.MeshStandardMaterial({ color: 0xffd75e, metalness: 0.8, roughness: 0.3, emissive: 0x704c00 })
);
plunger.rotation.x = Math.PI / 2;
plunger.position.set(PLUNGER_POS.x, BALL_R, 49.5);
table.add(plunger);

// Post-processing: bloom for the neon bits
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.5, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// --- main loop ----------------------------------------------------------------

const FIXED_H = 1 / 480;
let last = performance.now() / 1000;
let accumulator = 0;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  let dt = Math.min(now - last, 1 / 30);
  last = now;

  // Plunger charge
  if (game.charging) {
    game.power = Math.min(1, game.power + dt / 1.1);
    powerEl.style.display = 'block';
    powerFill.style.height = `${game.power * 100}%`;
  } else {
    powerEl.style.display = 'none';
  }

  accumulator += dt;
  let steps = 0;
  while (accumulator >= FIXED_H && steps < 40) {
    physicsStep(FIXED_H, now);
    accumulator -= FIXED_H;
    steps++;
  }

  // Sync visuals
  ballMesh.position.set(game.ball.x, BALL_R, game.ball.z);
  ballGlow.position.set(game.ball.x, BALL_R + 4, game.ball.z);
  ballMesh.rotation.x += game.ball.vz * dt / BALL_R;
  ballMesh.rotation.z -= game.ball.vx * dt / BALL_R;

  for (const { f, group } of flipperVisuals) {
    group.rotation.y = f.side === -1 ? -f.angle : Math.PI + f.angle;
  }

  for (const v of bumperVisuals) {
    if (v.b.flash > 0) {
      v.b.flash = Math.max(0, v.b.flash - dt * 6);
      v.cap.material.emissiveIntensity = 0.6 + v.b.flash * 3.5;
      v.ring.material.emissiveIntensity = 1.2 + v.b.flash * 4;
      v.group.scale.setScalar(1 + v.b.flash * 0.12);
    }
  }
  if (slingFlashL > 0) {
    slingFlashL = Math.max(0, slingFlashL - dt * 5);
    if (slingMeshes.L) slingMeshes.L.material.emissiveIntensity = 0.8 + slingFlashL * 4;
  }
  if (slingFlashR > 0) {
    slingFlashR = Math.max(0, slingFlashR - dt * 5);
    if (slingMeshes.R) slingMeshes.R.material.emissiveIntensity = 0.8 + slingFlashR * 4;
  }

  // Plunger springs down while charging
  plunger.position.z = 49.5 + game.power * 2.2;

  composer.render();
}

newGame();
updateHud();
frame();

// Handle for debugging / testing from the console.
window.__game = game;
