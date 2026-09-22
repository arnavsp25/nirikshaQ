/**
 * NirikshaQ Configuration & Tunable Priors
 *
 * NOTE: All constants listed below are operational priors and baseline hypotheses,
 * NOT learned ground truth. In production OPD deployments, these values should be
 * calibrated against historical EHR data, departmental studies, or real-time telemetry.
 */

/**
 * Generalised Interrupt Types across NirikshaQ
 */
export const INTERRUPT_TYPES = {
  EMERGENCY_INSERT: 'EMERGENCY_INSERT',
  CALLED_TO_WARD: 'CALLED_TO_WARD',
  BREAK: 'BREAK',
  SECOND_DOCTOR_OPENS: 'SECOND_DOCTOR_OPENS',
  DOCTOR_RETURNS: 'DOCTOR_RETURNS'
};

export const CONFIG = {
  // ==========================================
  // Monte Carlo & Forecasting Engine Priors
  // ==========================================

  /** Number of Monte Carlo simulation trials run per doctor queue */
  TRIALS: 1200,

  /** Gamma distribution shape parameter (k). Shape k=4 reflects right-skewed OPD consult durations */
  GAMMA_SHAPE: 4,

  /** Minimum floor for estimated remaining consult minutes */
  MIN_REMAINING_MIN: 1.5,

  /** Lower bound factor for active consultation jitter */
  JITTER_BASE: 0.88,

  /** Span multiplier for active consultation jitter (range: JITTER_BASE to JITTER_BASE + JITTER_SPAN) */
  JITTER_SPAN: 0.24,

  // ==========================================
  // Post-Interrupt Recovery Factor Priors
  // ==========================================

  /** Post-interrupt disruption multiplier alpha (0.15 = +15% scale overhead immediately after interrupt) */
  RECOVERY_ALPHA: 0.15,

  /** Exponential decay timescale lambda in simulated minutes for recovery */
  RECOVERY_LAMBDA_MIN: 20,

  // ==========================================
  // Interrupt & Doctor Availability Priors
  // ==========================================

  /** Default duration in minutes when a doctor is called to ward */
  DEFAULT_WARD_CALL_MIN: 15,

  /** Default duration in minutes when a doctor takes a break */
  DEFAULT_BREAK_MIN: 10,

  /** Threshold in minutes for Leave-By time shift that triggers an explicit reason change note */
  LEAVE_BY_CHANGE_THRESHOLD_MIN: 5,

  /** Prior travel buffer in minutes used for Leave-By planner */
  TRAVEL_BUFFER_MIN: 20,

  // ==========================================
  // Emergency / Interrupt Impact Radius Priors
  // ==========================================

  /** Threshold for promise coverage (fraction of MC samples inside promised window). Below this, patient is affected */
  PROMISE_COVERAGE_THRESHOLD: 0.35,

  /** Maximum cap on downstream patients marked as affected and notified */
  MAX_AFFECTED_RADIUS: 15,

  // ==========================================
  // Doctor Pace EWMA & Normalization Priors
  // ==========================================

  /** Weight given to historical paceMultiplier during EWMA update */
  EWMA_OLD_WEIGHT: 0.60,

  /** Weight given to the most recent consult duration ratio (actual / predicted) */
  EWMA_NEW_WEIGHT: 0.40,

  /** Weight given to current EWMA when regularizing toward baseline */
  REGULARIZATION_CURRENT: 0.85,

  /** Weight given to default baseline 1.0 multiplier to prevent runaway divergence */
  REGULARIZATION_BASELINE: 0.15,

  /** Minimum permitted actual consult duration in minutes */
  MIN_CONSULT_DURATION_MIN: 0.5,

  /** Maximum permitted actual consult duration in minutes */
  MAX_CONSULT_DURATION_MIN: 240,

  // ==========================================
  // UI & Simulation Timers
  // ==========================================

  /** Duration for downstream patient row flash animation in milliseconds */
  FLASH_DURATION_MS: 2500,

  /** Duration for banner alert in milliseconds */
  BANNER_DURATION_MS: 6000,

  /** Maximum number of SMS messages retained in the phone simulator drawer */
  MAX_PHONE_MESSAGES: 50,

  // ==========================================
  // Event Store & Simulation Seed Priors
  // ==========================================

  /** Default root RNG seed for reproducible Monte Carlo forecasting and event log rehydration */
  DEFAULT_ROOT_SEED: 'nirikshaq-opd-seed-2026'
};

/**
 * Initial doctor departmental profiles (baseline priors)
 */
export const INITIAL_DOCTORS = [
  {
    id: 'd1',
    name: 'Dr. Meera Joshi',
    specialty: 'General Medicine',
    baseAvgMin: 8,
    paceMultiplier: 1.0,
    availability: 'available',
    pauseUntil: null,
    pauseTotalMin: null,
    pendingBreakMin: null,
    lastEmergencyAt: null,
    lastInterruptAt: null,
    queue: []
  },
  {
    id: 'd2',
    name: 'Dr. Arjun Rao',
    specialty: 'Paediatrics',
    baseAvgMin: 10,
    paceMultiplier: 1.0,
    availability: 'available',
    pauseUntil: null,
    pauseTotalMin: null,
    pendingBreakMin: null,
    lastEmergencyAt: null,
    lastInterruptAt: null,
    queue: []
  },
  {
    id: 'd3',
    name: 'Dr. Kavita Shah',
    specialty: 'Gynaecology',
    baseAvgMin: 12,
    paceMultiplier: 1.0,
    availability: 'available',
    pauseUntil: null,
    pauseTotalMin: null,
    pendingBreakMin: null,
    lastEmergencyAt: null,
    lastInterruptAt: null,
    queue: []
  }
];
