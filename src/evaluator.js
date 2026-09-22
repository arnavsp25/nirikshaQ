/**
 * NirikshaQ Evaluation Lab — Synthetic OPD Day Simulator & Benchmarking Engine
 *
 * Compares two estimators on simulated OPD days:
 * 1. LINEAR BASELINE: wait = position * doctor.baseAvgMin, window = +/-20%, calculated once, never updated.
 * 2. NIRIKSHAQ ENGINE: Monte Carlo P10/P50/P90 windows, EIR promise coverage, post-interrupt recovery,
 *    and EWMA pace calibration, re-forecasting after every emergency interrupt.
 */

import { CONFIG } from './config.js';
import {
  createRNG,
  gammaSample,
  forecastDoctor,
  evaluateImpactRadius,
  calculateRecoveryFactor,
  calibrateDoctorPace
} from './engine.js';

/**
 * Runs a complete multi-day synthetic OPD benchmark.
 *
 * @param {Object} options
 * @param {number} [options.days=30] - Total synthetic days to simulate
 * @param {string|number} [options.seed='opd-eval-seed-42'] - Root PRNG seed
 * @param {Function} [options.onProgress] - Callback `(currentDay, totalDays, intermediateSummary) => void`
 * @returns {Promise<Object>} Aggregated comparison results
 */
export async function runOPDEvaluation({
  days = 30,
  seed = 'opd-eval-seed-42',
  onProgress
} = {}) {
  const allPatients = [];
  const daySummaries = [];

  const reportStep = Math.max(1, Math.floor(days / 20));

  for (let d = 1; d <= days; d++) {
    const daySeed = `${seed}-day-${d}`;
    const dayRng = createRNG(daySeed);

    const dayResult = simulateSingleOPDDay({
      dayIndex: d,
      rng: dayRng
    });

    allPatients.push(...dayResult.patients);
    daySummaries.push(dayResult.summary);

    if (onProgress && (d % reportStep === 0 || d === days)) {
      const intermediate = computeAggregateMetrics(allPatients, d);
      onProgress(d, days, intermediate);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const finalMetrics = computeAggregateMetrics(allPatients, days);
  finalMetrics.daySummaries = daySummaries;
  finalMetrics.seed = seed;
  finalMetrics.totalDays = days;
  finalMetrics.totalPatients = allPatients.length;

  return finalMetrics;
}

/**
 * Simulates a single OPD day across 2-3 doctors with walk-in emergencies and consult durations.
 *
 * @param {Object} params
 * @param {number} params.dayIndex
 * @param {() => number} params.rng
 * @returns {{ patients: Array<Object>, summary: Object }}
 */
export function simulateSingleOPDDay({ dayIndex, rng }) {
  // 1. Setup 3 Doctor profiles with baseline consult priors
  const doctorsConfig = [
    { id: 'd1', name: 'Dr. Joshi', baseAvgMin: 8, trueSpeedFactor: 0.9 + rng() * 0.2 },
    { id: 'd2', name: 'Dr. Rao', baseAvgMin: 10, trueSpeedFactor: 0.9 + rng() * 0.2 },
    { id: 'd3', name: 'Dr. Shah', baseAvgMin: 12, trueSpeedFactor: 0.9 + rng() * 0.2 }
  ];

  const simulatedPatients = [];

  doctorsConfig.forEach(docCfg => {
    // 25 - 40 regular patients registered for this doctor
    const patientCount = 25 + Math.floor(rng() * 16);
    const doctorQueue = [];

    // Initialize doctor state for NirikshaQ engine
    let doctorState = {
      id: docCfg.id,
      name: docCfg.name,
      baseAvgMin: docCfg.baseAvgMin,
      paceMultiplier: 1.0,
      lastEmergencyAt: null,
      queue: []
    };

    // 1 to 3 walk-in emergencies scheduled at random consult indices
    const emergencyCount = 1 + Math.floor(rng() * 3);
    const emergencyIndices = new Set();
    while (emergencyIndices.size < emergencyCount) {
      const idx = 5 + Math.floor(rng() * Math.max(1, patientCount - 10));
      emergencyIndices.add(idx);
    }

    // Generate regular routine patients at t=0 (OPD opening)
    for (let i = 0; i < patientCount; i++) {
      const pId = `d${dayIndex}_${docCfg.id}_p${i + 1}`;
      const token = String(i + 1).padStart(3, '0');

      // Gamma-distributed true consultation duration: shape k=4, scale = trueMean/4
      const trueMean = docCfg.baseAvgMin * docCfg.trueSpeedFactor;
      const trueDuration = Math.max(
        1.5,
        gammaSample(CONFIG.GAMMA_SHAPE, trueMean / CONFIG.GAMMA_SHAPE, rng)
      );

      // --- 1. Linear Baseline initial calculation (relative to t=0) ---
      const linearWaitMin = i * docCfg.baseAvgMin;
      const linearP50 = linearWaitMin;
      // Stated window for linear: estimate +/- 20%
      const linearWindow = {
        low: Math.max(0, linearP50 * 0.8),
        high: linearP50 * 1.2
      };

      const patientRecord = {
        id: pId,
        doctorId: docCfg.id,
        token,
        emergency: false,
        severity: 'routine',
        status: 'waiting',
        initialPosition: i,
        trueDuration,
        groundTruthCallTime: 0,
        isBehindEmergency: false,

        // Linear Baseline tracking
        linearToldP50: linearP50,
        linearWindow,
        linearStale: false,

        // NirikshaQ tracking (absolute minutes from t=0)
        nirikshaqToldP50: 0,
        nirikshaqWindow: { low: 0, high: 0 },
        nirikshaqReforecasts: 0,
        forecastEpoch: 1
      };

      doctorQueue.push(patientRecord);
    }

    // --- 2. NirikshaQ Initial Monte Carlo Forecast for all patients at t=0 ---
    doctorState.queue = doctorQueue.map(p => ({
      id: p.id,
      token: p.token,
      status: 'waiting',
      severity: 'routine',
      emergency: false,
      forecastEpoch: 1,
      promisedWindow: null
    }));

    const initialForecast = forecastDoctor(doctorState, doctorState.queue, 0, {
      seed: `init-${dayIndex}-${docCfg.id}`,
      trials: 600
    });

    doctorQueue.forEach(p => {
      const f = initialForecast[p.id];
      if (f) {
        p.nirikshaqToldP50 = f.p50;
        p.nirikshaqWindow = { low: f.p10, high: f.p90 };
        const docPatient = doctorState.queue.find(q => q.id === p.id);
        if (docPatient) {
          docPatient.promisedWindow = f;
        }
      }
    });

    // --- 3. Discrete Event Timeline Simulation ---
    let currentSimTimeMin = 0;
    let completedCount = 0;
    let emergencySeq = 1;

    while (doctorQueue.some(p => p.status === 'waiting' || p.status === 'consult')) {
      let cur = doctorQueue.find(p => p.status === 'consult');

      if (!cur) {
        const nextWaiting = doctorQueue.find(p => p.status === 'waiting');
        if (!nextWaiting) break;
        cur = nextWaiting;
        cur.status = 'consult';
        cur.groundTruthCallTime = currentSimTimeMin;

        doctorState.queue = doctorState.queue.map(q =>
          q.id === cur.id ? { ...q, status: 'consult', consultStartedAt: currentSimTimeMin * 60000 } : q
        );
      }

      // Check if an emergency arrives during this patient's consultation
      if (emergencyIndices.has(completedCount)) {
        emergencyIndices.delete(completedCount);

        const emergId = `d${dayIndex}_${docCfg.id}_em_${emergencySeq++}`;
        const emergTrueMean = docCfg.baseAvgMin * 2.0 * docCfg.trueSpeedFactor; // Emergency consults take ~2x baseline
        const emergTrueDuration = Math.max(
          5.0,
          gammaSample(CONFIG.GAMMA_SHAPE, emergTrueMean / CONFIG.GAMMA_SHAPE, rng)
        );

        const currentConsultIdx = doctorQueue.findIndex(p => p.id === cur.id);
        const insertPosition = Math.max(currentConsultIdx + 1, 0);

        const emergPatient = {
          id: emergId,
          doctorId: docCfg.id,
          token: `E${emergencySeq}`,
          emergency: true,
          severity: 'emergency',
          status: 'waiting',
          initialPosition: insertPosition,
          trueDuration: emergTrueDuration,
          groundTruthCallTime: 0,
          isBehindEmergency: false,

          linearToldP50: 0,
          linearWindow: { low: 0, high: 0 },
          linearStale: false,

          nirikshaqToldP50: 0,
          nirikshaqWindow: { low: 0, high: 0 },
          nirikshaqReforecasts: 0,
          forecastEpoch: 1
        };

        // Insert into simulation queue
        doctorQueue.splice(insertPosition, 0, emergPatient);

        // Mark all downstream patients as behind emergency and linear as stale
        for (let j = insertPosition + 1; j < doctorQueue.length; j++) {
          if (!doctorQueue[j].emergency) {
            doctorQueue[j].isBehindEmergency = true;
            doctorQueue[j].linearStale = true;
          }
        }

        // --- NirikshaQ Engine: Emergency Impact Radius & Re-forecast ---
        const nowMs = currentSimTimeMin * 60000;
        doctorState.lastEmergencyAt = nowMs;

        const docQueueCopy = doctorState.queue.map(q => ({ ...q }));
        docQueueCopy.splice(insertPosition, 0, {
          id: emergId,
          token: emergPatient.token,
          status: 'waiting',
          severity: 'emergency',
          emergency: true,
          forecastEpoch: 1,
          promisedWindow: null
        });

        // Evaluate Impact Radius using real engine
        const impact = evaluateImpactRadius({
          doctor: doctorState,
          queue: docQueueCopy,
          insertPosition,
          now: nowMs,
          seed: `eval-impact-${emergId}`,
          trials: 600
        });

        // Update downstream patients who are affected (promise coverage < threshold)
        doctorQueue.slice(insertPosition + 1).forEach(p => {
          if (p.status !== 'waiting' || p.emergency) return;
          const f = impact.newForecasts[p.id];
          if (!f) return;

          const isAffected = impact.affectedIds.includes(p.id);
          const newAbsoluteP50 = currentSimTimeMin + f.p50;

          if (isAffected) {
            p.nirikshaqToldP50 = newAbsoluteP50;
            p.nirikshaqWindow = {
              low: currentSimTimeMin + f.p10,
              high: currentSimTimeMin + f.p90
            };
            p.nirikshaqReforecasts++;
            p.forecastEpoch++;

            const docQItem = docQueueCopy.find(q => q.id === p.id);
            if (docQItem) {
              docQItem.promisedWindow = f;
              docQItem.forecastEpoch = p.forecastEpoch;
            }
          }
        });

        doctorState.queue = docQueueCopy;
      }

      // Finish consultation for `cur`
      currentSimTimeMin += cur.trueDuration;
      cur.status = 'done';
      completedCount++;

      // Recalibrate doctor EWMA pace
      doctorState.paceMultiplier = calibrateDoctorPace(doctorState, cur.trueDuration);
      doctorState.queue = doctorState.queue.map(q =>
        q.id === cur.id ? { ...q, status: 'done', completedAt: currentSimTimeMin * 60000 } : q
      );
    }

    // Only collect regular routine patients for evaluation metrics (excluding walk-in emergencies themselves)
    const regularPatients = doctorQueue.filter(p => !p.emergency);
    simulatedPatients.push(...regularPatients);
  });

  return {
    patients: simulatedPatients,
    summary: {
      dayIndex,
      patientCount: simulatedPatients.length
    }
  };
}

/**
 * Computes comparative evaluation metrics from accumulated patient records.
 *
 * @param {Array<Object>} patients
 * @param {number} daysCount
 * @returns {Object} Comprehensive evaluation metrics
 */
export function computeAggregateMetrics(patients, daysCount) {
  if (!patients.length) {
    return {
      daysCount,
      totalPatients: 0,
      linear: getEmptyMethodMetrics(),
      nirikshaq: getEmptyMethodMetrics(),
      headlineDelta: 0
    };
  }

  const behindEmergencyPatients = patients.filter(p => p.isBehindEmergency);

  // --- LINEAR METRICS ---
  let linTotalAbsError = 0;
  let linBehindAbsError = 0;
  let linWindowHits = 0;
  let linSevereErrors = 0; // Error > 15 min
  let linStaleCount = 0;

  // --- NIRIKSHAQ METRICS ---
  let nqTotalAbsError = 0;
  let nqBehindAbsError = 0;
  let nqWindowHits = 0;
  let nqSevereErrors = 0; // Error > 15 min
  let nqTotalReforecasts = 0;

  patients.forEach(p => {
    const actual = p.groundTruthCallTime;

    // Linear error
    const linErr = Math.abs(p.linearToldP50 - actual);
    linTotalAbsError += linErr;
    if (actual >= p.linearWindow.low && actual <= p.linearWindow.high) {
      linWindowHits++;
    }
    if (linErr > 15) {
      linSevereErrors++;
    }
    if (p.linearStale) {
      linStaleCount++;
    }

    // NirikshaQ error
    const nqErr = Math.abs(p.nirikshaqToldP50 - actual);
    nqTotalAbsError += nqErr;
    if (actual >= p.nirikshaqWindow.low && actual <= p.nirikshaqWindow.high) {
      nqWindowHits++;
    }
    if (nqErr > 15) {
      nqSevereErrors++;
    }
    nqTotalReforecasts += p.nirikshaqReforecasts;

    // Behind emergency subsets
    if (p.isBehindEmergency) {
      linBehindAbsError += linErr;
      nqBehindAbsError += nqErr;
    }
  });

  const N = patients.length;
  const NBehind = Math.max(1, behindEmergencyPatients.length);

  const linearMetrics = {
    maeOverallMin: Number((linTotalAbsError / N).toFixed(2)),
    maeBehindEmergMin: Number((linBehindAbsError / NBehind).toFixed(2)),
    calibrationPercent: Number(((linWindowHits / N) * 100).toFixed(1)),
    severeErrorPercent: Number(((linSevereErrors / N) * 100).toFixed(1)),
    staleEstimatePercent: Number(((linStaleCount / N) * 100).toFixed(1))
  };

  const nirikshaqMetrics = {
    maeOverallMin: Number((nqTotalAbsError / N).toFixed(2)),
    maeBehindEmergMin: Number((nqBehindAbsError / NBehind).toFixed(2)),
    calibrationPercent: Number(((nqWindowHits / N) * 100).toFixed(1)),
    severeErrorPercent: Number(((nqSevereErrors / N) * 100).toFixed(1)),
    reforecastsPerPatient: Number((nqTotalReforecasts / N).toFixed(2)),
    staleEstimatePercent: 0.0
  };

  const headlineDelta = Number((linearMetrics.maeBehindEmergMin - nirikshaqMetrics.maeBehindEmergMin).toFixed(2));
  const headlinePercentImprovement = Number(
    (((linearMetrics.maeBehindEmergMin - nirikshaqMetrics.maeBehindEmergMin) / linearMetrics.maeBehindEmergMin) * 100).toFixed(1)
  );

  return {
    daysCount,
    totalPatients: N,
    behindEmergencyCount: behindEmergencyPatients.length,
    linear: linearMetrics,
    nirikshaq: nirikshaqMetrics,
    headlineDelta,
    headlinePercentImprovement
  };
}

function getEmptyMethodMetrics() {
  return {
    maeOverallMin: 0,
    maeBehindEmergMin: 0,
    calibrationPercent: 0,
    severeErrorPercent: 0,
    reforecastsPerPatient: 0,
    staleEstimatePercent: 0
  };
}

/**
 * Generates a 3-line plain text summary suitable for copying to clipboard
 * @param {Object} results
 * @returns {string}
 */
export function format3LineSummary(results) {
  const { totalDays, totalPatients, linear, nirikshaq, headlineDelta, headlinePercentImprovement } = results;
  return [
    `NirikshaQ OPD Evaluation (${totalDays} synthetic days, ${totalPatients?.toLocaleString()} patients):`,
    `Behind-Emergency MAE: Linear ${linear.maeBehindEmergMin}m vs NirikshaQ ${nirikshaq.maeBehindEmergMin}m (error reduced by ${headlineDelta}m / ${headlinePercentImprovement}%).`,
    `Calibration (in-window): Linear ${linear.calibrationPercent}% vs NirikshaQ ${nirikshaq.calibrationPercent}% | Severe errors (>15m): Linear ${linear.severeErrorPercent}% vs NirikshaQ ${nirikshaq.severeErrorPercent}%.`
  ].join('\n');
}

/**
 * Generates CSV string containing summary metrics and per-day results
 * @param {Object} results
 * @returns {string}
 */
export function formatCSVExport(results) {
  const lines = [];
  lines.push('NirikshaQ Evaluation Lab — Benchmark Summary');
  lines.push(`Total Synthetic Days,${results.totalDays}`);
  lines.push(`Total Patients,${results.totalPatients}`);
  lines.push(`Simulation Seed,${results.seed}`);
  lines.push('');
  lines.push('Metric,Linear Baseline (Pos x Avg),NirikshaQ Engine (Monte Carlo + EIR + Recovery),Improvement');
  lines.push(`Overall MAE (minutes),${results.linear.maeOverallMin},${results.nirikshaq.maeOverallMin},${(results.linear.maeOverallMin - results.nirikshaq.maeOverallMin).toFixed(2)}m`);
  lines.push(`Behind-Emergency MAE (headline),${results.linear.maeBehindEmergMin},${results.nirikshaq.maeBehindEmergMin},${results.headlineDelta}m (${results.headlinePercentImprovement}%)`);
  lines.push(`Calibration (% inside stated window),${results.linear.calibrationPercent}%,${results.nirikshaq.calibrationPercent}%,+${(results.nirikshaq.calibrationPercent - results.linear.calibrationPercent).toFixed(1)}%`);
  lines.push(`Severe Errors (% >15 min error),${results.linear.severeErrorPercent}%,${results.nirikshaq.severeErrorPercent}%,-${(results.linear.severeErrorPercent - results.nirikshaq.severeErrorPercent).toFixed(1)}%`);
  lines.push(`Patients Left with Stale Estimates (%),${results.linear.staleEstimatePercent}%,0.0%,-${results.linear.staleEstimatePercent}%`);
  return lines.join('\n');
}
