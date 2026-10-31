#!/usr/bin/env node
/**
 * Timing harness. Warmup 1, then 7 measured repetitions; cold start kept
 * separately. Writes bench/result.json. Workloads are deterministic.
 */
import { writeFileSync } from "node:fs";
import {
  createField, integrateFixed, integrateAdaptive, endpointError,
  makeSeeds, minFixedSteps,
} from "../src/core.mjs";

const SEEDS = 12;
const MAX_TIME = 4;
const TARGET = 1e-6;
const ADAPTIVE_TOL = 1e-7;
const REPS = 7;
const INNER = 3;

const field = createField("jet", { amp: 25, width: 0.15, drift: 0.4 });
const seeds = makeSeeds(SEEDS, 20261031, 1.1);

// Reference trajectories and the minimum fixed-step baseline per seed.
const refs = seeds.map((s) => integrateFixed(field, s.p0, { h: 1e-4, maxTime: MAX_TIME }));
const baselines = seeds.map((s, i) => {
  const b = minFixedSteps(field, s.p0, refs[i], { target: TARGET, maxTime: MAX_TIME });
  return { seed: s.id, steps: b.steps, evals: b.steps * 4, error: b.error, capped: b.capped };
});

const adaptiveSweep = () => {
  let steps = 0, evals = 0, rejected = 0, worst = 0;
  for (let i = 0; i < seeds.length; i++) {
    const r = integrateAdaptive(field, seeds[i].p0, { tol: ADAPTIVE_TOL, maxTime: MAX_TIME });
    steps += r.steps;
    evals += r.evals;
    rejected += r.rejected;
    worst = Math.max(worst, endpointError(r, refs[i]));
  }
  return { steps, evals, rejected, worst };
};

const baselineSweep = () => {
  let evals = 0;
  for (let i = 0; i < seeds.length; i++) {
    const r = integrateFixed(field, seeds[i].p0, { h: MAX_TIME / baselines[i].steps, maxTime: MAX_TIME });
    evals += r.evals;
  }
  return { evals };
};

const timeIt = (fn) => {
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < INNER; k++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / INNER;
};

const stats = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const p95 = sorted[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
  return {
    samples: n,
    min: +sorted[0].toFixed(4),
    median: +sorted[Math.floor(n / 2)].toFixed(4),
    p95: +p95.toFixed(4),
    max: +sorted[n - 1].toFixed(4),
    mean: +mean.toFixed(4),
    stddev: +Math.sqrt(variance).toFixed(4),
    rsd: +(Math.sqrt(variance) / mean).toFixed(4),
  };
};

// Cold start: very first adaptive sweep.
const coldAdaptive = timeIt(adaptiveSweep);
// Warmup, then measured runs (interleaved to spread thermal noise).
adaptiveSweep();
baselineSweep();
const adaptiveMs = [];
const baselineMs = [];
for (let r = 0; r < REPS; r++) {
  adaptiveMs.push(timeIt(adaptiveSweep));
  baselineMs.push(timeIt(baselineSweep));
}

const ad = adaptiveSweep();
const base = baselineSweep();
const ratio = base.evals / ad.evals;
const result = {
  generatedBy: "bench/bench.mjs",
  node: process.version,
  workload: {
    field: "jet(amp=25,width=0.15,drift=0.4)",
    seeds: SEEDS,
    maxTime: MAX_TIME,
    targetDeviation: TARGET,
    adaptiveTol: ADAPTIVE_TOL,
    innerReps: INNER,
  },
  accuracy: {
    maxAdaptiveEndpointError: +ad.worst.toExponential(3),
    maxBaselineEndpointError: +Math.max(...baselines.map((b) => b.error)).toExponential(3),
  },
  work: {
    adaptiveEvals: ad.evals,
    adaptiveSteps: ad.steps,
    adaptiveRejected: ad.rejected,
    baselineEvals: base.evals,
    baselineSteps: baselines.reduce((a, b) => a + b.steps, 0),
    evalRatio: +ratio.toFixed(2),
    evalsSavedPct: +(100 * (1 - ad.evals / base.evals)).toFixed(1),
  },
  coldStartMs: +coldAdaptive.toFixed(4),
  timing: {
    adaptive: stats(adaptiveMs),
    baseline: stats(baselineMs),
    speedupMedian: +(stats(baselineMs).median / stats(adaptiveMs).median).toFixed(2),
  },
};
writeFileSync(new URL("./result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
