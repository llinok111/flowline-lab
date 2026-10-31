#!/usr/bin/env node
/** Deterministic sample generator: data/field.json (same bytes on every run). */
import { mkdirSync, writeFileSync } from "node:fs";
import { createField, makeSeeds } from "../src/core.mjs";

const COUNT = 48;
const SEED = 20261031;
const field = createField("jet", { amp: 25, width: 0.15, drift: 0.4 });
const seeds = makeSeeds(COUNT, SEED, 1.1);
const payload = {
  generator: "tools/gen-sample.mjs",
  version: 1,
  field: { name: field.name, params: field.params },
  seeding: { lcgSeed: SEED, extent: 1.1, count: COUNT },
  integration: { maxTime: 4, targetDeviation: 1e-6, adaptiveTol: 1e-7, referenceH: 1e-4 },
  seeds,
};
mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
const body = JSON.stringify(payload, null, 2) + "\n";
writeFileSync(new URL("../data/field.json", import.meta.url), body);
console.log(`wrote data/field.json (${seeds.length} seeds, ${body.length} bytes)`);
