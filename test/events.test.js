import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, INITIAL_DOCTORS, INTERRUPT_TYPES } from '../src/config.js';
import {
  EVENT_TYPES,
  createInitialState,
  eventReducer,
  reduceEvents,
  exportEventsToJSON,
  validateAndParseJSON
} from '../src/state.js';
import {
  forecastDoctor,
  evaluateInterruptImpact,
  calculateRecoveryFactor,
  calibrateDoctorPace
} from '../src/engine.js';

test('1. Event Reducer: Initial State & System Init', () => {
  const rootSeed = 'test-seed-123';
  const initialState = createInitialState(rootSeed, INITIAL_DOCTORS);

  assert.equal(initialState.rootSeed, rootSeed);
  assert.equal(initialState.doctors.length, INITIAL_DOCTORS.length);
  assert.equal(initialState.phone.length, 0);
  assert.equal(initialState.banner, null);
});

test('2. Replaying same events gives identical state (Determinism & Invariance)', () => {
  const rootSeed = 'replay-test-seed-2026';
  const baseTime = 1716300000000;

  // Step 1: Create a sequence of events simulating hospital operations
  const events = [];
  let seq = 1;

  // Event 1: Init system
  events.push({
    id: `evt_${seq}`,
    seq: seq++,
    timestamp: baseTime,
    type: EVENT_TYPES.SYSTEM_INIT,
    payload: {
      rootSeed,
      doctors: INITIAL_DOCTORS
    }
  });

  // Event 2: Register routine patient P1 for Dr. Joshi (d1)
  const patient1 = {
    id: 'p1_routine',
    token: '001',
    name: 'Sunita Patil',
    severity: 'routine',
    status: 'waiting',
    createdAt: baseTime,
    emergency: false,
    forecastEpoch: 1,
    promisedWindow: { p10: 5, p50: 8, p90: 12 }
  };
  events.push({
    id: `evt_${seq}`,
    seq: seq++,
    timestamp: baseTime + 1000,
    type: EVENT_TYPES.PATIENT_REGISTERED,
    payload: {
      doctorId: 'd1',
      patient: patient1,
      phoneMessages: [
        {
          id: 'sms_1',
          time: new Date(baseTime + 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: 'Token #001 registered for Dr. Meera Joshi. Expected window: 10:05 AM - 10:12 AM.'
        }
      ]
    }
  });

  // Event 3: Register urgent patient P2 for Dr. Joshi (d1)
  const patient2 = {
    id: 'p2_urgent',
    token: '002',
    name: 'Rajesh Sharma',
    severity: 'urgent',
    status: 'waiting',
    createdAt: baseTime + 2000,
    emergency: false,
    forecastEpoch: 1,
    promisedWindow: { p10: 12, p50: 16, p90: 22 }
  };
  events.push({
    id: `evt_${seq}`,
    seq: seq++,
    timestamp: baseTime + 2000,
    type: EVENT_TYPES.PATIENT_REGISTERED,
    payload: {
      doctorId: 'd1',
      patient: patient2,
      phoneMessages: [
        {
          id: 'sms_2',
          time: new Date(baseTime + 2000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: 'Token #002 registered for Dr. Meera Joshi. Expected window: 10:12 AM - 10:22 AM.'
        }
      ]
    }
  });

  // Event 4: Start consult for P1
  events.push({
    id: `evt_${seq}`,
    seq: seq++,
    timestamp: baseTime + 3000,
    type: EVENT_TYPES.CONSULT_STARTED,
    payload: {
      doctorId: 'd1',
      patientId: 'p1_routine',
      timestamp: baseTime + 3000
    }
  });

  // Event 5: Doctor Called to Ward for 15 minutes mid-consult
  events.push({
    id: `evt_${seq}`,
    seq: seq++,
    timestamp: baseTime + 5000,
    type: EVENT_TYPES.DOCTOR_CALLED_TO_WARD,
    payload: {
      doctorId: 'd1',
      minutes: 15,
      pauseUntil: baseTime + 5000 + 15 * 60000,
      banner: {
        type: INTERRUPT_TYPES.CALLED_TO_WARD,
        doctor: 'Dr. Meera Joshi',
        doctorId: 'd1',
        minutes: 15,
        pauseUntil: baseTime + 5000 + 15 * 60000,
        affectedCount: 1,
        summary: 'Dr. Meera Joshi called to ward, back in ~15 min'
      }
    }
  });

  // Event 6: Doctor Returns after ward call
  events.push({
    id: `evt_${seq}`,
    seq: seq++,
    timestamp: baseTime + 20000,
    type: EVENT_TYPES.DOCTOR_RETURNED,
    payload: {
      doctorId: 'd1',
      timestamp: baseTime + 20000
    }
  });

  // Event 7: Complete consult for P1 with actualDuration = 12.0 min
  const docJoshi = INITIAL_DOCTORS.find(d => d.id === 'd1');
  const recalibratedPace = calibrateDoctorPace(docJoshi, 12.0);
  events.push({
    id: `evt_${seq}`,
    seq: seq++,
    timestamp: baseTime + 25000,
    type: EVENT_TYPES.CONSULT_COMPLETED,
    payload: {
      doctorId: 'd1',
      patientId: 'p1_routine',
      actualDuration: 12.0,
      newPaceMultiplier: recalibratedPace,
      nextPatientId: 'p2_urgent',
      timestamp: baseTime + 25000
    }
  });

  // Event 8: Split queue with Doctor 2
  events.push({
    id: `evt_${seq}`,
    seq: seq++,
    timestamp: baseTime + 26000,
    type: EVENT_TYPES.QUEUE_SPLIT,
    payload: {
      sourceDoctorId: 'd1',
      targetDoctorId: 'd2',
      updatedSourceDoctor: {
        ...docJoshi,
        paceMultiplier: recalibratedPace,
        lastInterruptAt: baseTime + 20000,
        queue: [
          { ...patient1, status: 'done', completedAt: baseTime + 25000, actualDuration: 12.0 },
          { ...patient2, status: 'consult', consultStartedAt: baseTime + 25000 }
        ]
      },
      updatedTargetDoctor: {
        ...INITIAL_DOCTORS.find(d => d.id === 'd2'),
        queue: []
      },
      movedPatientIds: [],
      latestInterrupt: {
        type: INTERRUPT_TYPES.SECOND_DOCTOR_OPENS,
        doctorName: 'Dr. Meera Joshi',
        targetDoctorName: 'Dr. Arjun Rao',
        affectedCount: 0,
        injectedDelay: 0
      },
      banner: {
        type: INTERRUPT_TYPES.SECOND_DOCTOR_OPENS,
        doctor: 'Dr. Meera Joshi',
        targetDoctor: 'Dr. Arjun Rao',
        affectedCount: 0,
        summary: 'Queue split'
      }
    }
  });

  // --- Step 2: Incremental Reduction (live user session) ---
  let liveState = createInitialState(rootSeed, INITIAL_DOCTORS);
  for (const evt of events) {
    liveState = eventReducer(liveState, evt);
  }

  // --- Step 3: Replay Reduction from scratch (page refresh) ---
  const replayedState = reduceEvents(createInitialState(rootSeed, INITIAL_DOCTORS), events);

  // --- Step 4: Validate deep strict equality ---
  assert.deepStrictEqual(replayedState, liveState);

  // Validate critical domain invariants in replayed state:
  const replayedJoshi = replayedState.doctors.find(d => d.id === 'd1');
  assert.equal(replayedJoshi.queue.length, 2);
  assert.equal(replayedJoshi.queue[0].status, 'done');
  assert.equal(replayedJoshi.queue[1].status, 'consult');
  assert.equal(replayedJoshi.paceMultiplier, recalibratedPace);
  assert.equal(replayedJoshi.lastInterruptAt, baseTime + 20000);
});

test('3. JSON Export and Import Round-Trip Validation', () => {
  const events = [
    {
      id: 'evt_1',
      seq: 1,
      timestamp: 1000,
      type: EVENT_TYPES.SYSTEM_INIT,
      payload: { rootSeed: 'demo-seed', doctors: INITIAL_DOCTORS }
    },
    {
      id: 'evt_2',
      seq: 2,
      timestamp: 2000,
      type: EVENT_TYPES.DOCTOR_CALLED_TO_WARD,
      payload: {
        doctorId: 'd1',
        minutes: 15,
        pauseUntil: 2000 + 15 * 60000
      }
    }
  ];

  // Export to JSON string
  const jsonStr = exportEventsToJSON(events);
  assert.equal(typeof jsonStr, 'string');

  // Validate and parse back
  const parseResult = validateAndParseJSON(jsonStr);
  assert.equal(parseResult.valid, true);
  assert.deepStrictEqual(parseResult.events, events);

  // Validate state from parsed events
  const stateFromParsed = reduceEvents(createInitialState('demo-seed'), parseResult.events);
  const targetDoc = stateFromParsed.doctors.find(d => d.id === 'd1');
  assert.equal(targetDoc.availability, 'ward_call');
  assert.equal(targetDoc.pauseUntil, 2000 + 15 * 60000);
});

test('4. JSON Validation Error Handling', () => {
  const invalidJson = '{ bad: json }';
  const result1 = validateAndParseJSON(invalidJson);
  assert.equal(result1.valid, false);

  const missingFieldsJson = JSON.stringify([{ id: '1', type: 'SOME_TYPE' }]); // missing seq, payload
  const result2 = validateAndParseJSON(missingFieldsJson);
  assert.equal(result2.valid, false);
});

test('5. Reset Demo Data clears and re-initializes clean baseline', () => {
  let state = createInitialState('test-seed');
  state = eventReducer(state, {
    id: 'evt_1',
    seq: 1,
    timestamp: 1000,
    type: EVENT_TYPES.DOCTOR_ADDED,
    payload: {
      doctor: { id: 'd_new', name: 'Dr. New', specialty: 'Cardiology', baseAvgMin: 15, paceMultiplier: 1.0, queue: [] }
    }
  });
  assert.equal(state.doctors.length, INITIAL_DOCTORS.length + 1);

  // Apply DEMO_RESET
  const resetState = eventReducer(state, {
    id: 'evt_2',
    seq: 2,
    timestamp: 2000,
    type: EVENT_TYPES.DEMO_RESET,
    payload: {
      rootSeed: CONFIG.DEFAULT_ROOT_SEED,
      initialDoctors: INITIAL_DOCTORS
    }
  });

  assert.equal(resetState.doctors.length, INITIAL_DOCTORS.length);
  assert.equal(resetState.phone.length, 0);
  assert.equal(resetState.banner, null);
});
