/**
 * core.mjs — pure streamline math. No renderer, no DOM, no I/O, no globals.
 *
 * Two integrators over an analytic vector field:
 *   integrateFixed    — fixed-step RK4 (the baseline)
 *   integrateAdaptive — step-doubling RK4 with local error control (the subject)
 * Plus arc-length resampling, deviation measurement and tube tessellation.
 * Every function is deterministic and safe to import in node.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => {
  const l = len(a);
  return l < 1e-12 ? [0, 0, 0] : mul(a, 1 / l);
};

/** Build an analytic velocity field. */
export function createField(name = "abc", params = {}) {
  if (name === "abc") {
    const A = params.A ?? 1;
    const B = params.B ?? 1;
    const C = params.C ?? 1;
    return {
      name,
      params: { A, B, C },
      at([x, y, z]) {
        return [
          A * Math.sin(z) + C * Math.cos(y),
          B * Math.sin(x) + A * Math.cos(z),
          C * Math.sin(y) + B * Math.cos(x),
        ];
      },
    };
  }
  if (name === "jet") {
    const amp = params.amp ?? 25;
    const width = params.width ?? 0.15;
    const drift = params.drift ?? 0.4;
    return {
      name,
      params: { amp, width, drift },
      at([x, y, z]) {
        const s = 1 + amp * Math.exp(-Math.pow((z - 0.4) / width, 2));
        return [-y * s, x * s, drift];
      },
    };
  }
  if (name === "rotor") {
    const omega = params.omega ?? 1;
    return {
      name,
      params: { omega },
      at([x, y]) {
        return [-omega * y, omega * x, 0];
      },
    };
  }
  throw new Error("unknown field: " + name);
}

/** Closed-form solution for the rotor field (used as ground truth in tests). */
export function exactRotor([x0, y0], t, omega = 1) {
  const c = Math.cos(omega * t);
  const s = Math.sin(omega * t);
  return [x0 * c - y0 * s, x0 * s + y0 * c, 0];
}

/** One classical RK4 step. */
export function rk4Step(field, p, h) {
  const k1 = field.at(p);
  const k2 = field.at(add(p, mul(k1, h / 2)));
  const k3 = field.at(add(p, mul(k2, h / 2)));
  const k4 = field.at(add(p, mul(k3, h)));
  return add(p, mul(add(add(k1, mul(k2, 2)), add(mul(k3, 2), k4)), h / 6));
}

/** Fixed-step RK4 over a fixed time horizon — the baseline integrator. */
export function integrateFixed(field, p0, opts = {}) {
  const h = opts.h ?? 0.01;
  const maxTime = opts.maxTime ?? 4;
  let p = p0.slice();
  const points = [p.slice()];
  let t = 0;
  let steps = 0;
  while (t < maxTime - 1e-12) {
    const hh = Math.min(h, maxTime - t);
    p = rk4Step(field, p, hh);
    t += hh;
    steps++;
    points.push(p.slice());
  }
  return { points, steps, evals: steps * 4, time: t, h };
}

/**
 * Adaptive step-doubling RK4 over a fixed time horizon.
 * One trial = 1 full step + 2 half steps (12 field evaluations).
 * Local error estimate = |y_half2 - y_full|; accept when <= tol.
 */
export function integrateAdaptive(field, p0, opts = {}) {
  const tol = opts.tol ?? 1e-6;
  const hMin = opts.hMin ?? 1e-5;
  const hMax = opts.hMax ?? 0.5;
  const maxTime = opts.maxTime ?? 4;
  const maxTrials = opts.maxTrials ?? 200000;
  let h = opts.hInit ?? 0.05;
  let p = p0.slice();
  const points = [p.slice()];
  let t = 0;
  let accepted = 0;
  let rejected = 0;
  let evals = 0;
  let trials = 0;
  while (t < maxTime - 1e-12 && trials < maxTrials) {
    trials++;
    const hh = Math.min(h, maxTime - t);
    const full = rk4Step(field, p, hh);
    const mid = rk4Step(field, p, hh / 2);
    const half = rk4Step(field, mid, hh / 2);
    evals += 12;
    const err = Math.max(
      Math.abs(full[0] - half[0]),
      Math.abs(full[1] - half[1]),
      Math.abs(full[2] - half[2])
    );
    const last = hh >= maxTime - t - 1e-12;
    if (err <= tol || hh <= hMin || last) {
      t += hh;
      p = half;
      points.push(p.slice());
      accepted++;
      const grow = err < 1e-15 ? 4 : 0.9 * Math.pow(tol / err, 0.2);
      h = clamp(h * grow, hMin, hMax);
    } else {
      rejected++;
      h = clamp(hh * 0.9 * Math.pow(tol / err, 0.2), hMin, hMax);
    }
  }
  return { points, steps: accepted, rejected, evals, time: t, hFinal: h, tol };
}

/** Distance between the final points of two trajectories (same time horizon). */
export function endpointError(a, b) {
  const pa = a.points[a.points.length - 1];
  const pb = b.points[b.points.length - 1];
  return len(sub(pa, pb));
}

/** Polyline arc length. */
export function arcLength(points) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += len(sub(points[i], points[i - 1]));
  return s;
}

/** Resample a polyline at constant arc-length spacing ds. */
export function resampleByArcLength(points, ds = 0.01) {
  if (points.length < 2 || ds <= 0) return points.map((p) => p.slice());
  const total = arcLength(points);
  const count = Math.floor(total / ds) + 1;
  const out = [points[0].slice()];
  let seg = 0;
  let segStart = 0;
  let segLen = len(sub(points[1], points[0]));
  for (let k = 1; k < count; k++) {
    const target = k * ds;
    while (seg < points.length - 2 && segStart + segLen < target) {
      segStart += segLen;
      seg++;
      segLen = len(sub(points[seg + 1], points[seg]));
    }
    const t = segLen < 1e-15 ? 0 : clamp((target - segStart) / segLen, 0, 1);
    const a = points[seg];
    const b = points[seg + 1];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

/**
 * Compare two polylines after arc-length resampling.
 * Returns max/rms pointwise distance plus the arc-length difference.
 */
export function comparePolylines(a, b, ds = 0.02) {
  const ra = resampleByArcLength(a, ds);
  const rb = resampleByArcLength(b, ds);
  const n = Math.min(ra.length, rb.length);
  let max = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = len(sub(ra[i], rb[i]));
    if (d > max) max = d;
    sum += d * d;
  }
  return {
    samples: n,
    max,
    rms: n ? Math.sqrt(sum / n) : 0,
    arcA: arcLength(a),
    arcB: arcLength(b),
    arcDelta: Math.abs(arcLength(a) - arcLength(b)),
  };
}

/** Deterministic 32-bit LCG, identical in node and the browser. */
export function lcg(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Deterministic seeding inside a cube. */
export function makeSeeds(count = 48, seed = 20261031, extent = 1.1) {
  const rnd = lcg(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: i,
      p0: [
        (rnd() * 2 - 1) * extent,
        (rnd() * 2 - 1) * extent,
        (rnd() * 2 - 1) * extent,
      ],
    });
  }
  return out;
}

/** Parallel-transport tube tessellation around a polyline. */
export function tubeGeometry(points, opts = {}) {
  const radius = opts.radius ?? 0.02;
  const radial = opts.radial ?? 8;
  const n = points.length;
  const positions = new Array(n * radial * 3);
  const normals = new Array(n * radial * 3);
  const indices = [];
  let ref = [0, 0, 1];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    const t = norm(sub(b, a));
    if (Math.abs(dot(t, ref)) > 0.9) ref = [0, 1, 0];
    let nrm = sub(ref, mul(t, dot(ref, t)));
    if (len(nrm) < 1e-8) nrm = [1, 0, 0];
    nrm = norm(nrm);
    ref = nrm;
    const bin = cross(t, nrm);
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const dir = add(mul(nrm, Math.cos(th)), mul(bin, Math.sin(th)));
      const k = (i * radial + j) * 3;
      positions[k] = points[i][0] + dir[0] * radius;
      positions[k + 1] = points[i][1] + dir[1] * radius;
      positions[k + 2] = points[i][2] + dir[2] * radius;
      normals[k] = dir[0];
      normals[k + 1] = dir[1];
      normals[k + 2] = dir[2];
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      const a = i * radial + j;
      const b = i * radial + j2;
      const c = (i + 1) * radial + j;
      const d = (i + 1) * radial + j2;
      indices.push(a, b, c, b, d, c);
    }
  }
  return {
    positions,
    normals,
    indices,
    vertexCount: n * radial,
    triangleCount: (n - 1) * radial * 2,
    radius,
    radial,
  };
}

/** Mean speed along a polyline, used for colour mapping. */
export function meanSpeed(field, points) {
  if (!points.length) return 0;
  let s = 0;
  for (const p of points) s += len(field.at(p));
  return s / points.length;
}

/**
 * Minimal fixed-step count whose endpoint error versus `reference`
 * (same time horizon) stays under `target`. Exponential search + bisection.
 */
export function minFixedSteps(field, p0, reference, opts = {}) {
  const target = opts.target ?? 1e-4;
  const maxTime = opts.maxTime ?? 4;
  const cap = opts.cap ?? 32768;
  const errAt = (n) => {
    const r = integrateFixed(field, p0, { h: maxTime / n, maxTime });
    return endpointError(r, reference);
  };
  let hi = 8;
  while (hi < cap && errAt(hi) > target) hi *= 2;
  if (hi >= cap) return { steps: cap, error: errAt(cap), capped: true };
  let lo = Math.floor(hi / 2);
  for (let k = 0; k < 10; k++) {
    const mid = Math.floor((lo + hi) / 2);
    if (errAt(mid) <= target) hi = mid;
    else lo = mid;
  }
  return { steps: hi, error: errAt(hi), capped: false };
}
