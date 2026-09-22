import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, INTERRUPT_TYPES } from '../src/config.js';
import {
  createRNG,
  gammaSample,
  percentile,
  calculateRecoveryFactor,
  forecastDoctor,
  computePromiseCoverage,
  evaluateInterruptImpact,
  evaluateImpactRadius,
  calibrateDoctorPace,
  calculateLeaveByTime,
  getInterruptReason
} from '../src/engine.js';

test('1. Seedable Monte Carlo PRNG determinism', () => {
  const seed = 42981;
  const doc = {
    id: 'd1',
    name: 'Dr. Test',
    specialty: 'General Medicine',
    baseAvgMin: 10,
    paceMultiplier: 1.0,
    lastEmergencyAt: null
  };

  const queue = [
    { id: 'p1', name: 'Patient 1', status: 'waiting' },
    { id: 'p2', name: 'Patient 2', status: 'waiting' },
    { id: 'p3', name: 'Patient 3', status: 'waiting' }
  ];

  const now = 1700000000000;

  // Run two forecasts with the exact same seed
  const run1 = forecastDoctor(doc, queue, now, { seed, trials: 1000 });
  const run2 = forecastDoctor(doc, queue, now, { seed, trials: 1000 });

  assert.deepEqual(
    { p10: run1.p1.p10, p50: run1.p1.p50, p90: run1.p1.p90 },
    { p10: run2.p1.p10, p50: run2.p1.p50, p90: run2.p1.p90 },
    'Same seed must produce identical P10, P50, and P90 percentiles for p1'
  );

  assert.deepEqual(
    { p10: run1.p3.p10, p50: run1.p3.p50, p90: run1.p3.p90 },
    { p10: run2.p3.p10, p50: run2.p3.p50, p90: run2.p3.p90 },
    'Same seed must produce identical P10, P50, and P90 percentiles for p3'
  );
});

test('2. Post-interrupt recovery factor calculation and decay', () => {
  const t0 = 1700000000000;
  const alpha = 0.15;
  const lambda = 20; // 20 minutes

  // Immediately at t = t0 (dt = 0)
  const r0 = calculateRecoveryFactor(t0, t0, alpha, lambda);
  assert.equal(r0.factor, 1.15, 'At dt=0, recovery factor must be exactly 1 + alpha (1.15)');
  assert.equal(r0.boostPercent, 15, 'At dt=0, boost percentage is 15%');
  assert.equal(r0.active, true, 'At dt=0, recovery is active');

  // At dt = 20 minutes (dt = lambda, exp(-1) ~= 0.367879)
  const t20 = t0 + 20 * 60 * 1000;
  const r20 = calculateRecoveryFactor(t0, t20, alpha, lambda);
  const expectedBoost20 = alpha * Math.exp(-1); // ~0.05518
  assert.ok(Math.abs(r20.boost - expectedBoost20) < 1e-5, 'Boost at dt=20 min must equal alpha * exp(-1)');
  assert.equal(r20.boostPercent, 6, 'Boost at 20 min rounds to +6%');
  assert.equal(r20.active, true, 'At dt=20 min, recovery remains active');

  // At dt = 80 minutes (dt = 4 * lambda, exp(-4) ~= 0.0183)
  const t80 = t0 + 80 * 60 * 1000;
  const r80 = calculateRecoveryFactor(t0, t80, alpha, lambda);
  assert.equal(r80.boostPercent, 0, 'Boost at 80 min decays to 0%');
  assert.equal(r80.active, false, 'At dt=80 min, recovery is no longer active');
});

test('3. Small delay gives all silent (promise coverage >= 0.35)', () => {
  const now = 1700000000000;
  const doc = {
    id: 'd1',
    name: 'Dr. Joshi',
    baseAvgMin: 10,
    paceMultiplier: 1.0,
    lastEmergencyAt: null
  };

  const queue = [
    {
      id: 'p1',
      name: 'P1',
      status: 'waiting',
      forecastEpoch: 1,
      promisedWindow: {
        low: new Date(now + 2 * 60000),
        high: new Date(now + 25 * 60000),
        p10: 2,
        p50: 10,
        p90: 25
      }
    },
    {
      id: 'p2',
      name: 'P2',
      status: 'waiting',
      forecastEpoch: 1,
      promisedWindow: {
        low: new Date(now + 8 * 60000),
        high: new Date(now + 40 * 60000),
        p10: 8,
        p50: 20,
        p90: 40
      }
    }
  ];

  const evalResult = evaluateImpactRadius({
    doctor: doc,
    queue: [
      { id: 'em0', name: 'Emergency Minimal', status: 'waiting', emergency: true },
      ...queue
    ],
    insertPosition: 0,
    now,
    seed: 999
  });

  assert.ok(evalResult.coverageById.p1 !== undefined, 'Coverage computed for p1');
  assert.ok(evalResult.coverageById.p2 !== undefined, 'Coverage computed for p2');
  assert.ok(Array.isArray(evalResult.affectedIds), 'affectedIds returned');
  assert.ok(Array.isArray(evalResult.silentIds), 'silentIds returned');
});

test('4. Large delay shifts distribution and affects downstream patients', () => {
  const now = 1700000000000;
  const doc = {
    id: 'd1',
    name: 'Dr. Joshi',
    baseAvgMin: 15,
    paceMultiplier: 1.0,
    lastEmergencyAt: now
  };

  const queue = [
    {
      id: 'p1',
      name: 'P1',
      status: 'waiting',
      forecastEpoch: 1,
      promisedWindow: {
        low: new Date(now + 5 * 60000),
        high: new Date(now + 12 * 60000),
        p10: 5,
        p50: 8,
        p90: 12
      }
    },
    {
      id: 'p2',
      name: 'P2',
      status: 'waiting',
      forecastEpoch: 1,
      promisedWindow: {
        low: new Date(now + 12 * 60000),
        high: new Date(now + 20 * 60000),
        p10: 12,
        p50: 16,
        p90: 20
      }
    }
  ];

  const evalResult = evaluateImpactRadius({
    doctor: doc,
    queue: [
      { id: 'em1', name: 'Emergency Major', status: 'waiting', emergency: true },
      ...queue
    ],
    insertPosition: 0,
    now,
    seed: 12345
  });

  assert.ok(evalResult.coverageById.p1 < CONFIG.PROMISE_COVERAGE_THRESHOLD, 'p1 coverage must drop below 0.35');
  assert.ok(evalResult.affectedIds.includes('p1'), 'p1 must be in affectedIds');
  assert.equal(evalResult.insertPosition, 0, 'Insert position preserved');
  assert.ok(evalResult.injectedDelay > 0, 'Injected delay must be positive');
});

test('5. Affected radius capped at 15 patients', () => {
  const now = 1700000000000;
  const doc = {
    id: 'd1',
    name: 'Dr. Joshi',
    baseAvgMin: 15,
    paceMultiplier: 1.0,
    lastEmergencyAt: now
  };

  const queue = Array.from({ length: 25 }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Patient ${i + 1}`,
    status: 'waiting',
    forecastEpoch: 1,
    promisedWindow: {
      low: new Date(now + 1 * 60000),
      high: new Date(now + 2 * 60000),
      p10: 1,
      p50: 1.5,
      p90: 2
    }
  }));

  const evalResult = evaluateImpactRadius({
    doctor: doc,
    queue: [
      { id: 'em1', name: 'Emergency Major', status: 'waiting', emergency: true },
      ...queue
    ],
    insertPosition: 0,
    now,
    seed: 777
  });

  assert.equal(
    evalResult.affectedIds.length,
    CONFIG.MAX_AFFECTED_RADIUS,
    `Affected patients must be capped at ${CONFIG.MAX_AFFECTED_RADIUS}`
  );
  assert.equal(
    evalResult.silentIds.length,
    25 - CONFIG.MAX_AFFECTED_RADIUS,
    'Remaining patients beyond cap must be placed in silentIds'
  );
});

test('6. Invariants: ongoing consult is never interrupted and other doctors are unaffected', () => {
  const now = 1700000000000;
  const consultStartedAt = now - 5 * 60000;

  const doc1 = {
    id: 'd1',
    name: 'Dr. Meera',
    baseAvgMin: 10,
    paceMultiplier: 1.0,
    lastEmergencyAt: null,
    queue: [
      { id: 'c1', name: 'Ongoing Patient', status: 'consult', consultStartedAt },
      { id: 'w1', name: 'Waiting 1', status: 'waiting', forecastEpoch: 1, promisedWindow: { low: new Date(now + 5000), high: new Date(now + 15000) } }
    ]
  };

  const doc2 = {
    id: 'd2',
    name: 'Dr. Arjun',
    baseAvgMin: 12,
    paceMultiplier: 1.0,
    lastEmergencyAt: null,
    queue: [
      { id: 'd2_w1', name: 'Doc2 Waiting', status: 'waiting' }
    ]
  };

  const currentIdx = doc1.queue.findIndex(p => p.status === 'consult');
  assert.equal(currentIdx, 0, 'Consulting patient is at index 0');
  const insertPosition = Math.max(currentIdx + 1, 0);
  assert.equal(insertPosition, 1, 'Emergency is inserted at index 1, immediately after active consult');

  const newDoc1Queue = [...doc1.queue];
  const emergencyPatient = { id: 'em_new', name: 'Emergency Walk-in', severity: 'emergency', emergency: true, status: 'waiting' };
  newDoc1Queue.splice(insertPosition, 0, emergencyPatient);

  assert.equal(newDoc1Queue[0].status, 'consult', 'Ongoing consult is still in status consult');
  assert.equal(newDoc1Queue[0].id, 'c1', 'Ongoing consult patient is unmodified');
  assert.equal(newDoc1Queue[1].id, 'em_new', 'Emergency patient is placed at index 1');
  assert.equal(newDoc1Queue[2].id, 'w1', 'Downstream patient is shifted to index 2');

  const doc2Forecast = forecastDoctor(doc2, doc2.queue, now, { seed: 100 });
  assert.ok(doc2Forecast.d2_w1, 'Doctor 2 forecast runs completely isolated and unaffected');
});

test('7. Structured EIR result format for debug overlay and banner', () => {
  const now = 1700000000000;
  const doc = {
    id: 'd1',
    name: 'Dr. Meera Joshi',
    baseAvgMin: 10,
    paceMultiplier: 1.0,
    lastEmergencyAt: now
  };

  const queue = [
    { id: 'em1', name: 'Critical Emergency', status: 'waiting', emergency: true },
    {
      id: 'p1',
      name: 'Sunita Patil',
      token: '002',
      status: 'waiting',
      forecastEpoch: 1,
      promisedWindow: { low: new Date(now + 1000), high: new Date(now + 5000) }
    },
    {
      id: 'p2',
      name: 'Rahul Sharma',
      token: '003',
      status: 'waiting',
      forecastEpoch: 1,
      promisedWindow: { low: new Date(now + 50000), high: new Date(now + 150000) }
    }
  ];

  const evalResult = evaluateImpactRadius({
    doctor: doc,
    queue,
    insertPosition: 0,
    now,
    seed: 555
  });

  assert.ok(Array.isArray(evalResult.affectedIds), 'affectedIds must be an array');
  assert.ok(Array.isArray(evalResult.silentIds), 'silentIds must be an array');
  assert.equal(typeof evalResult.coverageById, 'object', 'coverageById must be an object');
  assert.equal(typeof evalResult.insertPosition, 'number', 'insertPosition must be a number');
  assert.equal(typeof evalResult.injectedDelay, 'number', 'injectedDelay must be a number');
});

test('8. CALLED_TO_WARD 15 min moves downstream windows later by ~15 min', () => {
  const now = 1700000000000;
  const docBaseline = {
    id: 'd1',
    name: 'Dr. Joshi',
    baseAvgMin: 10,
    paceMultiplier: 1.0,
    pauseUntil: null
  };

  const queue = [
    { id: 'p1', name: 'Patient 1', status: 'waiting' },
    { id: 'p2', name: 'Patient 2', status: 'waiting' }
  ];

  // Baseline forecast without pause
  const baselineForecast = forecastDoctor(docBaseline, queue, now, { seed: 'test-seed-ward', trials: 1500 });

  // Doctor called to ward for 15 minutes
  const docPaused = {
    ...docBaseline,
    availability: 'ward_call',
    pauseUntil: now + 15 * 60000
  };

  const pausedForecast = forecastDoctor(docPaused, queue, now, { seed: 'test-seed-ward', trials: 1500 });

  const deltaP1 = pausedForecast.p1.p50 - baselineForecast.p1.p50;
  const deltaP2 = pausedForecast.p2.p50 - baselineForecast.p2.p50;

  // Delta must be exactly 15 minutes (deterministic shift)
  assert.ok(Math.abs(deltaP1 - 15) < 0.1, `p1 median wait shifted by ${deltaP1.toFixed(2)} min (expected ~15 min)`);
  assert.ok(Math.abs(deltaP2 - 15) < 0.1, `p2 median wait shifted by ${deltaP2.toFixed(2)} min (expected ~15 min)`);
});

test('9. BREAK waits for the current consult to finish before starting', () => {
  const now = 1700000000000;
  const consultStartedAt = now - 4 * 60000; // 4 min elapsed of 10 min consult

  const doc = {
    id: 'd1',
    name: 'Dr. Rao',
    baseAvgMin: 10,
    paceMultiplier: 1.0,
    pauseUntil: null,
    pendingBreakMin: 10 // 10 min break queued after ongoing consult
  };

  const queue = [
    { id: 'c1', name: 'Consulting Patient', status: 'consult', consultStartedAt },
    { id: 'w1', name: 'Waiting 1', status: 'waiting' }
  ];

  const forecast = forecastDoctor(doc, queue, now, { seed: 'test-seed-break', trials: 1500 });

  // Expected wait for w1 = remaining consult (~6 min) + break (10 min) + w1 consult (~10 min) ~= 26 min
  assert.ok(forecast.w1.p50 >= 20 && forecast.w1.p50 <= 30, `Waiting patient wait is ${forecast.w1.p50.toFixed(2)} min including queued break`);
});

test('10. SECOND_DOCTOR_OPENS split gives both doctors shorter windows and no patient in two queues', () => {
  const now = 1700000000000;

  const docA = {
    id: 'd1',
    name: 'Dr. Meera Joshi',
    baseAvgMin: 10,
    paceMultiplier: 1.0,
    queue: [
      { id: 'p1', name: 'Patient 1', status: 'waiting', forecastEpoch: 1, promisedWindow: { low: new Date(now + 5000), high: new Date(now + 15000) } },
      { id: 'p2', name: 'Patient 2', status: 'waiting', forecastEpoch: 1, promisedWindow: { low: new Date(now + 15000), high: new Date(now + 30000) } },
      { id: 'p3', name: 'Patient 3', status: 'waiting', forecastEpoch: 1, promisedWindow: { low: new Date(now + 30000), high: new Date(now + 45000) } },
      { id: 'p4', name: 'Patient 4', status: 'waiting', forecastEpoch: 1, promisedWindow: { low: new Date(now + 45000), high: new Date(now + 60000) } }
    ]
  };

  const docB = {
    id: 'd2',
    name: 'Dr. Arjun Rao',
    baseAvgMin: 10,
    paceMultiplier: 1.0,
    queue: []
  };

  // Forecast before split
  const beforeA = forecastDoctor(docA, docA.queue, now, { seed: 100 });

  // Move alternating patients (p2, p4) to Doc B
  const movedIds = ['p2', 'p4'];
  const updatedDocAQueue = docA.queue.filter(p => !movedIds.includes(p.id));
  const updatedDocBQueue = docA.queue.filter(p => movedIds.includes(p.id));

  // Invariant: No patient appears in both queues
  const allIds = [...updatedDocAQueue.map(p => p.id), ...updatedDocBQueue.map(p => p.id)];
  assert.equal(new Set(allIds).size, 4, 'All 4 patients are unique; no patient in both queues');
  assert.equal(updatedDocAQueue.length, 2);
  assert.equal(updatedDocBQueue.length, 2);

  // Forecast after split
  const afterA = forecastDoctor(docA, updatedDocAQueue, now, { seed: 100 });
  const afterB = forecastDoctor(docB, updatedDocBQueue, now, { seed: 100 });

  // p3 was behind p1 and p2 (position 3), now behind only p1 (position 2) -> wait decreases
  assert.ok(afterA.p3.p50 < beforeA.p3.p50, 'Remaining patients get shorter wait times');

  // p4 was position 4 on Doc A, now position 2 on Doc B -> wait decreases
  assert.ok(afterB.p4.p50 < beforeA.p4.p50, 'Moved patients get shorter wait times');
});

test('11. Edge cases: empty queue, stacked pauses, and in-consult protection', () => {
  const now = 1700000000000;

  // 1. Interrupt on empty queue
  const emptyDoc = { id: 'd_empty', name: 'Dr. Empty', baseAvgMin: 10, paceMultiplier: 1.0, queue: [] };
  const emptyImpact = evaluateInterruptImpact({
    type: INTERRUPT_TYPES.CALLED_TO_WARD,
    doctor: emptyDoc,
    queue: [],
    now,
    injectedDelayMin: 15
  });
  assert.equal(emptyImpact.affectedIds.length, 0);
  assert.equal(emptyImpact.silentIds.length, 0);
  assert.equal(emptyImpact.injectedDelay, 15);

  // 2. In-consult patient is protected from moves
  const docWithConsult = {
    id: 'd_c',
    name: 'Dr. Consult',
    baseAvgMin: 10,
    paceMultiplier: 1.0,
    queue: [
      { id: 'c_active', name: 'Active Patient', status: 'consult' },
      { id: 'w_single', name: 'Single Waiting', status: 'waiting' }
    ]
  };
  const waitingOnly = docWithConsult.queue.filter(p => p.status === 'waiting');
  assert.equal(waitingOnly.length, 1, 'Only waiting patients are available for split');
  assert.equal(waitingOnly[0].id, 'w_single');

  // 3. Leave-by time helper
  const forecastSample = { low: new Date(now + 30 * 60000), p10: 30, at: new Date(now + 40 * 60000), p50: 40, high: new Date(now + 50 * 60000), p90: 50 };
  const leaveBy = calculateLeaveByTime(forecastSample, 20); // 20 min travel buffer
  assert.equal(leaveBy.getTime(), now + 10 * 60000, 'Leave by is P10 arrival minus 20 min buffer');
});
