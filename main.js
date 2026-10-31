/** Rendering only: consumes core.mjs outputs, never re-implements math. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  createField, integrateAdaptive, integrateFixed, endpointError,
  resampleByArcLength, tubeGeometry, meanSpeed, makeSeeds, minFixedSteps,
} from "./src/core.mjs";

const app = document.getElementById("app");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07090f);
scene.fog = new THREE.FogExp2(0x07090f, 0.055);

const camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.05, 100);
camera.position.set(2.8, 2.1, 3.4);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.45;
controls.target.set(0, 0.1, 0);

scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x0a0d16, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(3, 5, 4);
scene.add(key);

const grid = new THREE.GridHelper(6, 24, 0x1d2b4a, 0x121a2c);
grid.position.y = -1.35;
scene.add(grid);

const box = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(2.6, 2.6, 2.6)),
  new THREE.LineBasicMaterial({ color: 0x22304d })
);
scene.add(box);

const data = await fetch("./data/field.json").then((r) => r.json());
const field = createField(data.field.name, data.field.params);
const group = new THREE.Group();
scene.add(group);

let seeds = makeSeeds(24, data.seeding.lcgSeed, data.seeding.extent);
let tol = 1e-7;
let liveToken = 0;

const colorFor = (speed) => {
  const h = THREE.MathUtils.clamp(0.62 - speed * 0.032, 0.05, 0.62);
  return new THREE.Color().setHSL(h, 0.85, 0.55);
};

function clearGroup() {
  for (const child of [...group.children]) {
    child.geometry.dispose();
    child.material.dispose();
    group.remove(child);
  }
}

function build() {
  clearGroup();
  let steps = 0, evals = 0, rejected = 0;
  for (const s of seeds) {
    const run = integrateAdaptive(field, s.p0, { tol, maxTime: 4 });
    steps += run.steps;
    evals += run.evals;
    rejected += run.rejected;
    const pts = resampleByArcLength(run.points, 0.035);
    if (pts.length < 4) continue;
    const tube = tubeGeometry(pts, { radius: 0.016, radial: 7 });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(tube.positions, 3));
    geom.setAttribute("normal", new THREE.Float32BufferAttribute(tube.normals, 3));
    geom.setIndex(tube.indices);
    const mat = new THREE.MeshStandardMaterial({
      color: colorFor(meanSpeed(field, run.points)),
      roughness: 0.35,
      metalness: 0.25,
      emissive: colorFor(meanSpeed(field, run.points)).multiplyScalar(0.18),
    });
    group.add(new THREE.Mesh(geom, mat));
  }
  document.getElementById("steps").textContent = `${steps} (拒 ${rejected})`;
  document.getElementById("evals").textContent = evals.toLocaleString();
  return { evals, steps };
}

async function verifyLive() {
  const token = ++liveToken;
  const t0 = performance.now();
  const subset = seeds.slice(0, 12);
  const refs = subset.map((s) => integrateFixed(field, s.p0, { h: 1e-4, maxTime: 4 }));
  const runs = subset.map((s) => integrateAdaptive(field, s.p0, { tol, maxTime: 4 }));
  let worst = 0, adEvals = 0, baseEvals = 0;
  for (let i = 0; i < subset.length; i++) {
    worst = Math.max(worst, endpointError(runs[i], refs[i]));
    adEvals += runs[i].evals;
    const base = minFixedSteps(field, subset[i].p0, refs[i], { target: 1e-6, maxTime: 4 });
    baseEvals += base.steps * 4;
  }
  if (token !== liveToken) return;
  document.getElementById("base").textContent = baseEvals.toLocaleString();
  document.getElementById("saved").textContent =
    `${(100 * (1 - adEvals / baseEvals)).toFixed(1)}%  (${(baseEvals / adEvals).toFixed(2)}x)`;
  document.getElementById("error").textContent = worst.toExponential(2);
  document.getElementById("error").className = worst <= 1e-6 ? "v good" : "v";
  document.getElementById("error").title = `${(performance.now() - t0).toFixed(0)} ms in-browser`;
}

function refresh() {
  build();
  setTimeout(verifyLive, 30);
}

document.getElementById("n").addEventListener("input", (e) => {
  const n = Number(e.target.value);
  document.getElementById("nOut").textContent = n;
  seeds = makeSeeds(n, data.seeding.lcgSeed, data.seeding.extent);
  refresh();
});
document.getElementById("t").addEventListener("input", (e) => {
  tol = Math.pow(10, -Number(e.target.value));
  document.getElementById("tOut").textContent = `1e-${e.target.value}`;
  refresh();
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

refresh();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
