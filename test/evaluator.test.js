import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runOPDEvaluation,
  simulateSingleOPDDay,
  computeAggregateMetrics,
  format3LineSummary,
  formatCSVExport
} from '../src/evaluator.js';
import { createRNG } from '../src/engine.js';

test('1. Evaluation Determinism: Same seed yields identical evaluation metrics', async () => {
  const seed = 'determinism-seed-999';
  const days = 15;

  const run1 = await runOPDEvaluation({ days, seed });
  const run2 = await runOPDEvaluation({ days, seed });

  assert.equal(run1.totalDays, run2.totalDays);
  assert.equal(run1.totalPatients, run2.totalPatients);
  assert.equal(run1.behindEmergencyCount, run2.behindEmergencyCount);

  // Deep comparison of Linear metrics
  assert.deepStrictEqual(run1.linear, run2.linear);

  // Deep comparison of NirikshaQ metrics
  assert.deepStrictEqual(run1.nirikshaq, run2.nirikshaq);

  assert.equal(run1.headlineDelta, run2.headlineDelta);
  assert.equal(run1.headlinePercentImprovement, run2.headlinePercentImprovement);
});

test('2. Single Day Simulation sanity and structural invariants', () => {
  const rng = createRNG('single-day-test-seed');
  const dayResult = simulateSingleOPDDay({ dayIndex: 1, rng });

  assert.ok(dayResult.patients.length > 50, 'Should generate patients across doctors');

  dayResult.patients.forEach(p => {
    assert.ok(p.groundTruthCallTime >= 0, 'Ground truth call time must be >= 0');
    assert.ok(p.linearToldP50 >= 0, 'Linear told P50 must be >= 0');
    assert.ok(p.nirikshaqToldP50 >= 0, 'NirikshaQ told P50 must be >= 0');
    assert.ok(p.nirikshaqWindow.high >= p.nirikshaqWindow.low, 'P90 must be >= P10');
  });

  const aggregate = computeAggregateMetrics(dayResult.patients, 1);
  assert.ok(aggregate.linear.maeOverallMin >= 0);
  assert.ok(aggregate.nirikshaq.maeOverallMin >= 0);
});

test('3. Summary formatting and CSV export output format', async () => {
  const seed = 'summary-seed-111';
  const results = await runOPDEvaluation({ days: 5, seed });

  const summary = format3LineSummary(results);
  assert.equal(typeof summary, 'string');
  assert.equal(summary.split('\n').length, 3, 'Summary must be exactly 3 lines');
  assert.ok(summary.includes('Behind-Emergency MAE'));
  assert.ok(summary.includes('Calibration'));

  const csv = formatCSVExport(results);
  assert.equal(typeof csv, 'string');
  assert.ok(csv.includes('NirikshaQ Evaluation Lab — Benchmark Summary'));
  assert.ok(csv.includes('Behind-Emergency MAE'));
});
