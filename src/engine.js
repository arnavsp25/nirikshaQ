import { CONFIG, INTERRUPT_TYPES } from './config.js';

/**
 * Seedable 32-bit PRNG (Mulberry32)
 * Produces deterministic pseudo-random floats in [0, 1) given a 32-bit seed.
 *
 * @param {number|string} seed
 * @returns {() => number}
 */
export function createRNG(seed = 123456789) {
  let s = 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      s = (Math.imul(31, s) + seed.charCodeAt(i)) | 0;
    }
  } else {
    s = (typeof seed === 'number' ? seed : 123456789) >>> 0;
  }

  return function mulberry32() {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates standard normal random variate N(0, 1) via Box-Muller transform
 *
 * @param {() => number} [rng]
 * @returns {number}
 */
export function randn(rng = Math.random) {
  let u = 0;
  let v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Marsaglia–Tsang Gamma distribution sampler for shape >= 1
 *
 * @param {number} shape - Gamma shape parameter k (must be >= 1)
 * @param {number} scale - Gamma scale parameter theta
 * @param {() => number} [rng] - Injectable random generator
 * @returns {number}
 */
export function gammaSample(shape, scale, rng = Math.random) {
  if (shape < 1) throw new Error('gammaSample expects shape >= 1');
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    const x = randn(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * Math.pow(x, 4) || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v * scale;
    }
  }
}

/**
 * Calculates quantile with linear interpolation
 *
 * @param {number[]} arr
 * @param {number} p - Quantile in [0, 1]
 * @returns {number}
 */
export function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
}

/**
 * Calculates post-interrupt recovery factor
 * Formula: scaleMultiplier = 1 + alpha * exp(-dt / lambda)
 *
 * @param {number|null} lastInterruptAt - Timestamp of last interrupt or emergency
 * @param {number} now - Current simulated timestamp
 * @param {number} [alpha=CONFIG.RECOVERY_ALPHA] - Prior boost factor
 * @param {number} [lambda=CONFIG.RECOVERY_LAMBDA_MIN] - Prior decay timescale (minutes)
 * @returns {{ factor: number, boost: number, boostPercent: number, dtMin: number, active: boolean, decayRemainingMin: number }}
 */
export function calculateRecoveryFactor(
  lastInterruptAt,
  now,
  alpha = CONFIG.RECOVERY_ALPHA,
  lambda = CONFIG.RECOVERY_LAMBDA_MIN
) {
  if (!lastInterruptAt || now < lastInterruptAt) {
    return {
      factor: 1.0,
      boost: 0,
      boostPercent: 0,
      dtMin: 0,
      active: false,
      decayRemainingMin: 0
    };
  }

  const dtMin = Math.max(0, (now - lastInterruptAt) / 60000);
  const boost = alpha * Math.exp(-dtMin / lambda);
  const factor = 1 + boost;
  const boostPercent = Math.round(boost * 100);
  const active = boostPercent > 0;
  const decayRemainingMin = Math.max(1, Math.round(lambda - (dtMin % lambda)));

  return {
    factor,
    boost,
    boostPercent,
    dtMin,
    active,
    decayRemainingMin
  };
}

/**
 * Runs Monte Carlo simulation for a single doctor queue.
 * Correctly accounts for active consults, paused doctor availability (ward call / break),
 * scheduled pending breaks, and post-interrupt recovery factor.
 *
 * @param {object} doc - Doctor object { baseAvgMin, paceMultiplier, lastEmergencyAt, lastInterruptAt, pauseUntil, pendingBreakMin... }
 * @param {Array<object>} patients - Full patient queue
 * @param {number} now - Current timestamp (injected simulated clock)
 * @param {object} [options] - Options { seed, trials, includeSamples }
 * @returns {Record<string, { p10: number, p50: number, p90: number, at: Date, low: Date, high: Date, samples?: number[] }>}
 */
export function forecastDoctor(doc, patients, now, options = {}) {
  const waiting = patients.filter(p => p.status === 'waiting');
  if (!waiting.length) return {};

  const trials = options.trials || CONFIG.TRIALS;
  const rng = options.seed !== undefined ? createRNG(options.seed) : options.rng || Math.random;
  const current = patients.find(p => p.status === 'consult');

  // Recovery factor (applied after emergency, ward call, or break ends)
  const recoveryTimestamp = doc.lastInterruptAt || doc.lastEmergencyAt;
  const recovery = calculateRecoveryFactor(
    recoveryTimestamp,
    now,
    CONFIG.RECOVERY_ALPHA,
    CONFIG.RECOVERY_LAMBDA_MIN
  );

  // Effective mean consultation duration combined with EWMA pace & recovery
  const mean = doc.baseAvgMin * doc.paceMultiplier * recovery.factor;

  const elapsed = current?.consultStartedAt ? Math.max(0, (now - current.consultStartedAt) / 60000) : 0;
  const predictedRemaining = Math.max(CONFIG.MIN_REMAINING_MIN, mean - elapsed);

  // Check if doctor is currently paused (Called to ward / On break)
  const remainingPauseMin = (doc.pauseUntil && now < doc.pauseUntil)
    ? Math.max(0, (doc.pauseUntil - now) / 60000)
    : 0;

  // Check if doctor has a pending break scheduled to start immediately after the active consult
  const pendingBreakMin = (!remainingPauseMin && doc.pendingBreakMin) ? doc.pendingBreakMin : 0;

  const result = {};
  const buckets = waiting.map(() => []);

  for (let t = 0; t < trials; t++) {
    // Initial wait accumulator includes remaining pause time + remaining consult jitter + pending break
    let cum = remainingPauseMin + (current ? predictedRemaining * (CONFIG.JITTER_BASE + rng() * CONFIG.JITTER_SPAN) + pendingBreakMin : 0);
    waiting.forEach((p, i) => {
      cum += gammaSample(CONFIG.GAMMA_SHAPE, mean / CONFIG.GAMMA_SHAPE, rng);
      buckets[i].push(cum);
    });
  }

  waiting.forEach((p, i) => {
    const vals = buckets[i];
    const p10 = percentile(vals, 0.1);
    const p50 = percentile(vals, 0.5);
    const p90 = percentile(vals, 0.9);

    result[p.id] = {
      p10,
      p50,
      p90,
      at: new Date(now + p50 * 60000),
      low: new Date(now + p10 * 60000),
      high: new Date(now + p90 * 60000),
      recovery,
      samples: options.includeSamples ? vals : undefined
    };
  });

  return result;
}

/**
 * Computes the promise coverage: fraction of new Monte Carlo samples that fall inside
 * the patient's existing promised window.
 *
 * @param {number[]} samples - Array of wait times in minutes from new forecast
 * @param {number} now - Current timestamp in ms
 * @param {{ low: Date|number, high: Date|number, p10?: number, p90?: number }} promisedWindow
 * @returns {number} Coverage in [0, 1]
 */
export function computePromiseCoverage(samples, now, promisedWindow) {
  if (!samples || !samples.length || !promisedWindow) return 0;

  // Convert promised low and high to absolute timestamps
  let lowMs = 0;
  let highMs = 0;

  if (promisedWindow.low instanceof Date) {
    lowMs = promisedWindow.low.getTime();
  } else if (typeof promisedWindow.low === 'number') {
    lowMs = promisedWindow.low < 1e11 ? now + promisedWindow.low * 60000 : promisedWindow.low;
  }

  if (promisedWindow.high instanceof Date) {
    highMs = promisedWindow.high.getTime();
  } else if (typeof promisedWindow.high === 'number') {
    highMs = promisedWindow.high < 1e11 ? now + promisedWindow.high * 60000 : promisedWindow.high;
  }

  if (!lowMs || !highMs || highMs <= lowMs) {
    return 0;
  }

  let inside = 0;
  for (let i = 0; i < samples.length; i++) {
    const sampleMs = now + samples[i] * 60000;
    if (sampleMs >= lowMs && sampleMs <= highMs) {
      inside++;
    }
  }

  return inside / samples.length;
}

/**
 * Generalised Interrupt Impact Evaluator.
 * Computes promise coverage for downstream patients, categorizing them into affected vs silent.
 * Supports EMERGENCY_INSERT, CALLED_TO_WARD, BREAK, SECOND_DOCTOR_OPENS, and DOCTOR_RETURNS.
 *
 * @param {object} params
 * @param {string} [params.type=INTERRUPT_TYPES.EMERGENCY_INSERT] - Interrupt type
 * @param {object} params.doctor - Doctor state
 * @param {Array<object>} params.queue - Updated doctor queue
 * @param {number|null} [params.insertPosition=null] - Index where emergency was inserted (if applicable)
 * @param {number} params.now - Current timestamp
 * @param {number|string} [params.seed] - Deterministic PRNG seed
 * @param {number|null} [params.injectedDelayMin=null] - Explicit injected delay in minutes
 * @returns {{
 *   type: string,
 *   doctorId: string,
 *   affectedIds: string[],
 *   silentIds: string[],
 *   coverageById: Record<string, number>,
 *   insertPosition: number|null,
 *   injectedDelay: number,
 *   newForecasts: Record<string, any>
 * }}
 */
export function evaluateInterruptImpact({
  type = INTERRUPT_TYPES.EMERGENCY_INSERT,
  doctor,
  queue,
  insertPosition = null,
  now,
  seed,
  injectedDelayMin = null,
  trials
}) {
  // Run re-forecast with Monte Carlo samples attached
  const newForecasts = forecastDoctor(doctor, queue, now, {
    seed: seed !== undefined ? seed : `impact-${doctor.id}-${now}`,
    includeSamples: true,
    trials
  });

  // Determine downstream patients based on interrupt type
  let downstreamPatients = [];
  if (type === INTERRUPT_TYPES.EMERGENCY_INSERT && insertPosition !== null) {
    downstreamPatients = queue
      .slice(insertPosition + 1)
      .filter(p => p.status === 'waiting' && !p.emergency);
  } else {
    downstreamPatients = queue.filter(p => p.status === 'waiting' && !p.emergency);
  }

  const affectedIds = [];
  const silentIds = [];
  const coverageById = {};

  // Compute injected delay
  let injectedDelay = 0;
  if (injectedDelayMin !== null) {
    injectedDelay = Math.round(injectedDelayMin * 10) / 10;
  } else if (type === INTERRUPT_TYPES.EMERGENCY_INSERT) {
    const recovery = calculateRecoveryFactor(doctor.lastEmergencyAt || doctor.lastInterruptAt || now, now);
    injectedDelay = Math.round(doctor.baseAvgMin * doctor.paceMultiplier * recovery.factor * 10) / 10;
  } else if (doctor.pauseUntil && now < doctor.pauseUntil) {
    injectedDelay = Math.round(((doctor.pauseUntil - now) / 60000) * 10) / 10;
  } else if (doctor.pendingBreakMin) {
    injectedDelay = doctor.pendingBreakMin;
  }

  downstreamPatients.forEach(p => {
    const f = newForecasts[p.id];
    if (!f || !f.samples) {
      silentIds.push(p.id);
      return;
    }

    const coverage = p.promisedWindow
      ? computePromiseCoverage(f.samples, now, p.promisedWindow)
      : 0;

    coverageById[p.id] = Number(coverage.toFixed(4));

    if (coverage < CONFIG.PROMISE_COVERAGE_THRESHOLD && affectedIds.length < CONFIG.MAX_AFFECTED_RADIUS) {
      affectedIds.push(p.id);
    } else {
      silentIds.push(p.id);
    }
  });

  return {
    type,
    doctorId: doctor.id,
    affectedIds,
    silentIds,
    coverageById,
    insertPosition,
    injectedDelay,
    newForecasts
  };
}

/**
 * Backward-compatible alias for Emergency Impact Radius evaluation
 */
export function evaluateImpactRadius(params) {
  return evaluateInterruptImpact({
    type: INTERRUPT_TYPES.EMERGENCY_INSERT,
    ...params
  });
}

/**
 * Computes the recommended Leave-By time for a patient based on P10 arrival window
 * Formula: leaveByTime = P10_arrival_time - travelBufferMin
 *
 * @param {object} forecast - Patient forecast { low, p10, at, p50, high, p90 }
 * @param {number} [travelBufferMin=CONFIG.TRAVEL_BUFFER_MIN]
 * @returns {Date|null}
 */
export function calculateLeaveByTime(forecast, travelBufferMin = CONFIG.TRAVEL_BUFFER_MIN) {
  if (!forecast || !forecast.low) return null;
  const lowMs = forecast.low instanceof Date ? forecast.low.getTime() : forecast.low;
  return new Date(lowMs - travelBufferMin * 60000);
}

/**
 * Returns human-readable explanation for an interrupt-induced wait/leave-by change
 *
 * @param {string} type - Interrupt type from INTERRUPT_TYPES
 * @param {object} [extra] - Contextual metadata
 * @returns {string}
 */
export function getInterruptReason(type, extra = {}) {
  switch (type) {
    case INTERRUPT_TYPES.CALLED_TO_WARD:
      return 'Doctor called to ward';
    case INTERRUPT_TYPES.BREAK:
      return 'Doctor on break';
    case INTERRUPT_TYPES.SECOND_DOCTOR_OPENS:
      return extra.targetDoctorName
        ? `Second doctor opened, you moved to ${extra.targetDoctorName}`
        : 'Queue split with second doctor';
    case INTERRUPT_TYPES.DOCTOR_RETURNS:
      return 'Doctor returned';
    case INTERRUPT_TYPES.EMERGENCY_INSERT:
    default:
      return 'Emergency inserted ahead';
  }
}

/**
 * Recalibrates doctor pace multiplier via EWMA and baseline regularization
 *
 * @param {object} doc - Doctor object
 * @param {number} actualDurationMin - Recorded consult duration
 * @returns {number} New paceMultiplier
 */
export function calibrateDoctorPace(doc, actualDurationMin) {
  const predicted = doc.baseAvgMin * doc.paceMultiplier;
  const ratio = actualDurationMin / predicted;
  const ewma = doc.paceMultiplier * CONFIG.EWMA_OLD_WEIGHT + ratio * CONFIG.EWMA_NEW_WEIGHT;
  const normalized = ewma * CONFIG.REGULARIZATION_CURRENT + 1.0 * CONFIG.REGULARIZATION_BASELINE;
  return normalized;
}

/**
 * Format Date to 12-hour hh:mm without leading zero
 */
export function fmtTime(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(/^0/, '');
}

/**
 * Format forecast or promisedWindow as range "hh:mm–hh:mm"
 */
export function fmtWindow(f) {
  if (!f || !f.low || !f.high) return '—';
  return `${fmtTime(f.low)}–${fmtTime(f.high)}`;
}

/**
 * Triage severity label
 */
export function severityLabel(s) {
  return s === 'emergency' ? 'Emergency' : s === 'urgent' ? 'Urgent' : 'Routine';
}

/**
 * Unique ID generator
 */
export function uid() {
  return Math.random().toString(36).slice(2, 9);
}
