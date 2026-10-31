#!/usr/bin/env node
/** Assertions over the pure core. Prints every measured value; exit 1 on failure. */
import { readFileSync } from "node:fs";
import {
  createField, exactRotor, integrateFixed, integrateAdaptive, endpointError,
  resampleByArcLength, arcLength, tubeGeometry, makeSeeds, minFixedSteps,
} from "../src/core.mjs";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  if (!ok) failures++;
};

// 1. Exact-solution test (rotor has a closed-form circular trajectory).
{
  const f = createField("rotor", { omega: 1 });
  const p0 = [1, 0, 0];
  const ad = integrateAdaptive(f, p0, { tol: 1e-9, maxTime: 2 * Math.PI });
  const truth = exactRotor([1, 0], 2 * Math.PI, 1);
  const err = Math.hypot(ad.points.at(-1)[0] - truth[0], ad.points.at(-1)[1] - truth[1]);
  check("rotor exact solution", err < 1e-6, `err=${err.toExponential(2)} steps=${ad.steps} evals=${ad.evals}`);
}

// 2. A coarse fixed step silently fails the same check.
{
  const f = createField("rotor", { omega: 1 });
  const coarse = integrateFixed(f, [1, 0, 0], { h: 0.5, maxTime: 2 * Math.PI });
  const truth = exactRotor([1, 0], 2 * Math.PI, 1);
  const err = Math.hypot(coarse.points.at(-1)[0] - truth[0], coarse.points.at(-1)[1] - truth[1]);
  check("coarse fixed step fails", err > 1e-3, `h=0.5 err=${err.toExponential(2)} (expected > 1e-3)`);
}

// 3. Arc-length resampling really is uniform.
{
  const f = createField("jet", {});
  const p = integrateFixed(f, [1.1, 0.2, -0.4], { h: 1e-3, maxTime: 4 }).points;
  const r = resampleByArcLength(p, 0.05);
  let worst = 0;
  for (let i = 2; i < r.length; i++) {
    const a = Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1], r[i][2] - r[i - 1][2]);
    const b = Math.hypot(r[i - 1][0] - r[i - 2][0], r[i - 1][1] - r[i - 2][1], r[i - 1][2] - r[i - 2][2]);
    worst = Math.max(worst, Math.abs(a - b));
  }
  check("resample spacing (0.1% tol)", worst < 1e-4, `max|ds_i-ds|=${worst.toExponential(2)} samples=${r.length} arc=${arcLength(p).toFixed(4)}`);
}

// 4. Tube tessellation: counts, unit normals, index bounds.
{
  const pts = resampleByArcLength(integrateFixed(createField("jet"), [0.8, 0.3, 0.1], { h: 1e-3, maxTime: 3 }).points, 0.05);
  const t = tubeGeometry(pts, { radius: 0.02, radial: 8 });
  let normalErr = 0;
  for (let i = 0; i < t.normals.length; i += 3) {
    const l = Math.hypot(t.normals[i], t.normals[i + 1], t.normals[i + 2]);
    normalErr = Math.max(normalErr, Math.abs(l - 1));
  }
  const idxOk = t.indices.every((v) => Number.isInteger(v) && v >= 0 && v < t.vertexCount);
  check("tube vertex count", t.vertexCount === pts.length * 8, `${t.vertexCount} == ${pts.length}*8`);
  check("tube triangle count", t.triangleCount === (pts.length - 1) * 16, `${t.triangleCount} == ${(pts.length - 1)}*16`);
  check("tube unit normals", normalErr < 1e-9, `max|n|-1=${normalErr.toExponential(2)}`);
  check("tube index bounds", idxOk, `indices=${t.indices.length} in [0,${t.vertexCount})`);
}

// 5. Determinism.
{
  const f = createField("jet", {});
  const a = integrateAdaptive(f, [0.9, -0.4, 0.2], { tol: 1e-7, maxTime: 4 });
  const b = integrateAdaptive(f, [0.9, -0.4, 0.2], { tol: 1e-7, maxTime: 4 });
  const same = JSON.stringify(a.points) === JSON.stringify(b.points) && a.evals === b.evals;
  check("deterministic rerun", same, `evals=${a.evals} points=${a.points.length}`);
}

// 6. Accuracy + work claim: at <=1e-6 endpoint error, adaptive uses fewer evals.
{
  const f = createField("jet", { amp: 25, width: 0.15, drift: 0.4 });
  const seeds = makeSeeds(8, 20261031, 1.1);
  const ratios = [];
  let worst = 0;
  let adTotal = 0;
  let baseTotal = 0;
  for (const s of seeds) {
    const ref = integrateFixed(f, s.p0, { h: 1e-4, maxTime: 4 });
    const ad = integrateAdaptive(f, s.p0, { tol: 1e-7, maxTime: 4 });
    const err = endpointError(ad, ref);
    worst = Math.max(worst, err);
    const base = minFixedSteps(f, s.p0, ref, { target: 1e-6, maxTime: 4 });
    adTotal += ad.evals;
    baseTotal += base.steps * 4;
    ratios.push((base.steps * 4) / ad.evals);
  }
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  check("adaptive endpoint error <= 1e-6", worst <= 1e-6, `worst=${worst.toExponential(2)} over ${seeds.length} seeds`);
  check("adaptive uses fewer evals", median >= 1.5, `median ratio=${median.toFixed(2)}x  evals ${baseTotal} -> ${adTotal} (${(100 * (1 - adTotal / baseTotal)).toFixed(1)}% fewer)`);
}

// 7. Sample data is regenerable and matches the generator.
{
  const data = JSON.parse(readFileSync(new URL("../data/field.json", import.meta.url), "utf8"));
  const regenerated = makeSeeds(data.seeding.count, data.seeding.lcgSeed, data.seeding.extent);
  const same = JSON.stringify(regenerated) === JSON.stringify(data.seeds);
  check("data/field.json matches generator", same && data.seeds.length === 48, `seeds=${data.seeds.length} field=${data.field.name} identical=${same}`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
