/**
 * Pure Event Sourcing State Engine for NirikshaQ.
 * Every state transition is modeled as an immutable event.
 * Replaying the event stream deterministically reconstructs the full application state.
 */

import { CONFIG, INITIAL_DOCTORS, INTERRUPT_TYPES } from './config.js';

export const EVENT_TYPES = {
  SYSTEM_INIT: 'SYSTEM_INIT',
  PATIENT_REGISTERED: 'PATIENT_REGISTERED',
  PATIENT_ESCALATED: 'PATIENT_ESCALATED',
  CONSULT_STARTED: 'CONSULT_STARTED',
  CONSULT_COMPLETED: 'CONSULT_COMPLETED',
  DOCTOR_ADDED: 'DOCTOR_ADDED',
  BANNER_DISMISSED: 'BANNER_DISMISSED',
  DEMO_RESET: 'DEMO_RESET',
  // Generalised Interrupt Events
  DOCTOR_CALLED_TO_WARD: 'DOCTOR_CALLED_TO_WARD',
  DOCTOR_BREAK_STARTED: 'DOCTOR_BREAK_STARTED',
  DOCTOR_RETURNED: 'DOCTOR_RETURNED',
  QUEUE_SPLIT: 'QUEUE_SPLIT'
};

/**
 * Creates the clean initial state baseline
 * @param {string} rootSeed
 * @param {Array<Object>} initialDoctors
 * @returns {Object}
 */
export function createInitialState(rootSeed = 'nirikshaq-demo-seed-2026', initialDoctors = INITIAL_DOCTORS) {
  // Deep clone initial doctors to prevent reference pollution
  const doctors = JSON.parse(JSON.stringify(initialDoctors));
  return {
    rootSeed,
    doctors,
    phone: [],
    latestInterrupt: null,
    flashes: {},
    banner: null
  };
}

/**
 * Pure reducer that applies a single event to state
 * @param {Object} state
 * @param {Object} event { id, seq, timestamp, type, payload }
 * @returns {Object} nextState
 */
export function eventReducer(state, event) {
  if (!event || !event.type) return state;

  switch (event.type) {
    case EVENT_TYPES.SYSTEM_INIT: {
      const { rootSeed, doctors } = event.payload || {};
      return createInitialState(
        rootSeed || state.rootSeed,
        doctors || state.doctors
      );
    }

    case EVENT_TYPES.PATIENT_REGISTERED: {
      const {
        doctorId,
        patient,
        updatedDoctor,
        latestInterrupt,
        banner,
        flashes,
        phoneMessages
      } = event.payload;

      let nextDoctors;
      if (updatedDoctor) {
        nextDoctors = state.doctors.map(d => (d.id === doctorId ? updatedDoctor : d));
      } else if (patient) {
        nextDoctors = state.doctors.map(d => {
          if (d.id !== doctorId) return d;
          return {
            ...d,
            queue: [...d.queue, patient]
          };
        });
      } else {
        nextDoctors = state.doctors;
      }

      const nextPhone = phoneMessages
        ? [...phoneMessages, ...(state.phone || [])].slice(0, CONFIG.MAX_PHONE_MESSAGES)
        : state.phone || [];

      return {
        ...state,
        doctors: nextDoctors,
        phone: nextPhone,
        flashes: flashes ? { ...(state.flashes || {}), ...flashes } : state.flashes || {},
        latestInterrupt: latestInterrupt !== undefined ? latestInterrupt : state.latestInterrupt,
        banner: banner !== undefined ? banner : state.banner
      };
    }

    case EVENT_TYPES.PATIENT_ESCALATED: {
      const {
        doctorId,
        updatedDoctor,
        latestInterrupt,
        banner,
        flashes,
        phoneMessages
      } = event.payload;

      const nextDoctors = state.doctors.map(d =>
        d.id === doctorId ? updatedDoctor : d
      );

      const nextPhone = phoneMessages
        ? [...phoneMessages, ...(state.phone || [])].slice(0, CONFIG.MAX_PHONE_MESSAGES)
        : state.phone || [];

      return {
        ...state,
        doctors: nextDoctors,
        phone: nextPhone,
        flashes: flashes ? { ...(state.flashes || {}), ...flashes } : state.flashes || {},
        latestInterrupt: latestInterrupt !== undefined ? latestInterrupt : state.latestInterrupt,
        banner: banner !== undefined ? banner : state.banner
      };
    }

    case EVENT_TYPES.DOCTOR_CALLED_TO_WARD: {
      const {
        doctorId,
        minutes,
        pauseUntil,
        updatedDoctor,
        latestInterrupt,
        banner,
        flashes,
        phoneMessages
      } = event.payload;

      const pauseDurationMin = minutes || CONFIG.DEFAULT_WARD_CALL_MIN;
      const until = pauseUntil || (event.timestamp + pauseDurationMin * 60000);

      const nextDoctors = state.doctors.map(d => {
        if (d.id !== doctorId) return d;
        if (updatedDoctor) return updatedDoctor;
        return {
          ...d,
          availability: 'ward_call',
          pauseUntil: until,
          pauseTotalMin: pauseDurationMin,
          pausedAt: event.timestamp
        };
      });

      const nextPhone = phoneMessages
        ? [...phoneMessages, ...(state.phone || [])].slice(0, CONFIG.MAX_PHONE_MESSAGES)
        : state.phone || [];

      return {
        ...state,
        doctors: nextDoctors,
        phone: nextPhone,
        flashes: flashes ? { ...(state.flashes || {}), ...flashes } : state.flashes || {},
        latestInterrupt: latestInterrupt !== undefined ? latestInterrupt : state.latestInterrupt,
        banner: banner !== undefined ? banner : state.banner
      };
    }

    case EVENT_TYPES.DOCTOR_BREAK_STARTED: {
      const {
        doctorId,
        minutes,
        pauseUntil,
        isPending,
        updatedDoctor,
        latestInterrupt,
        banner,
        flashes,
        phoneMessages
      } = event.payload;

      const breakDurationMin = minutes || CONFIG.DEFAULT_BREAK_MIN;
      const until = pauseUntil || (event.timestamp + breakDurationMin * 60000);

      const nextDoctors = state.doctors.map(d => {
        if (d.id !== doctorId) return d;
        if (updatedDoctor) return updatedDoctor;
        if (isPending) {
          return {
            ...d,
            pendingBreakMin: breakDurationMin
          };
        }
        return {
          ...d,
          availability: 'break',
          pauseUntil: until,
          pauseTotalMin: breakDurationMin,
          pausedAt: event.timestamp
        };
      });

      const nextPhone = phoneMessages
        ? [...phoneMessages, ...(state.phone || [])].slice(0, CONFIG.MAX_PHONE_MESSAGES)
        : state.phone || [];

      return {
        ...state,
        doctors: nextDoctors,
        phone: nextPhone,
        flashes: flashes ? { ...(state.flashes || {}), ...flashes } : state.flashes || {},
        latestInterrupt: latestInterrupt !== undefined ? latestInterrupt : state.latestInterrupt,
        banner: banner !== undefined ? banner : state.banner
      };
    }

    case EVENT_TYPES.DOCTOR_RETURNED: {
      const {
        doctorId,
        updatedDoctor,
        latestInterrupt,
        banner,
        flashes,
        phoneMessages
      } = event.payload;

      const finishTime = event.payload.timestamp || event.timestamp;
      const nextDoctors = state.doctors.map(d => {
        if (d.id !== doctorId) return d;
        if (updatedDoctor) return updatedDoctor;
        return {
          ...d,
          availability: 'available',
          pauseUntil: null,
          pauseTotalMin: null,
          pendingBreakMin: null,
          lastInterruptAt: finishTime
        };
      });

      const nextPhone = phoneMessages
        ? [...phoneMessages, ...(state.phone || [])].slice(0, CONFIG.MAX_PHONE_MESSAGES)
        : state.phone || [];

      // Clear banner if banner belonged to this doctor's pause
      const nextBanner =
        banner !== undefined
          ? banner
          : state.banner && state.banner.doctorId === doctorId && state.banner.type !== INTERRUPT_TYPES.EMERGENCY_INSERT
          ? null
          : state.banner;

      return {
        ...state,
        doctors: nextDoctors,
        phone: nextPhone,
        flashes: flashes ? { ...(state.flashes || {}), ...flashes } : state.flashes || {},
        latestInterrupt: latestInterrupt !== undefined ? latestInterrupt : state.latestInterrupt,
        banner: nextBanner
      };
    }

    case EVENT_TYPES.QUEUE_SPLIT: {
      const {
        sourceDoctorId,
        targetDoctorId,
        updatedSourceDoctor,
        updatedTargetDoctor,
        latestInterrupt,
        banner,
        flashes,
        phoneMessages
      } = event.payload;

      const nextDoctors = state.doctors.map(d => {
        if (d.id === sourceDoctorId) return updatedSourceDoctor;
        if (d.id === targetDoctorId) return updatedTargetDoctor;
        return d;
      });

      const nextPhone = phoneMessages
        ? [...phoneMessages, ...(state.phone || [])].slice(0, CONFIG.MAX_PHONE_MESSAGES)
        : state.phone || [];

      return {
        ...state,
        doctors: nextDoctors,
        phone: nextPhone,
        flashes: flashes ? { ...(state.flashes || {}), ...flashes } : state.flashes || {},
        latestInterrupt: latestInterrupt !== undefined ? latestInterrupt : state.latestInterrupt,
        banner: banner !== undefined ? banner : state.banner
      };
    }

    case EVENT_TYPES.CONSULT_STARTED: {
      const { doctorId, patientId, timestamp } = event.payload;
      const nextDoctors = state.doctors.map(d => {
        if (d.id !== doctorId) return d;
        return {
          ...d,
          availability: 'in_consult',
          queue: d.queue.map(p =>
            p.id === patientId
              ? { ...p, status: 'consult', consultStartedAt: timestamp || event.timestamp }
              : p
          )
        };
      });

      return {
        ...state,
        doctors: nextDoctors
      };
    }

    case EVENT_TYPES.CONSULT_COMPLETED: {
      const {
        doctorId,
        patientId,
        actualDuration,
        newPaceMultiplier,
        nextPatientId,
        timestamp,
        pendingBreakMin
      } = event.payload;

      const finishTime = timestamp || event.timestamp;
      let triggeredBreakBanner = null;

      const nextDoctors = state.doctors.map(d => {
        if (d.id !== doctorId) return d;
        const breakDuration = pendingBreakMin !== undefined ? pendingBreakMin : d.pendingBreakMin;

        const updatedQueue = d.queue.map(p => {
          if (p.id === patientId) {
            return {
              ...p,
              status: 'done',
              completedAt: finishTime,
              actualDuration
            };
          }
          if (nextPatientId && p.id === nextPatientId && !breakDuration) {
            return {
              ...p,
              status: 'consult',
              consultStartedAt: finishTime
            };
          }
          return p;
        });

        if (breakDuration) {
          triggeredBreakBanner = {
            type: INTERRUPT_TYPES.BREAK,
            doctor: d.name,
            doctorId: d.id,
            minutes: breakDuration,
            pauseUntil: finishTime + breakDuration * 60000,
            summary: `${d.name} on break for ${breakDuration} min`
          };

          return {
            ...d,
            paceMultiplier: newPaceMultiplier,
            availability: 'break',
            pauseUntil: finishTime + breakDuration * 60000,
            pauseTotalMin: breakDuration,
            pausedAt: finishTime,
            pendingBreakMin: null,
            queue: updatedQueue
          };
        }

        return {
          ...d,
          paceMultiplier: newPaceMultiplier,
          availability: nextPatientId ? 'in_consult' : 'available',
          queue: updatedQueue
        };
      });

      // Clear emergency banner if this patient was the active emergency
      let nextBanner = state.banner;
      if (state.banner && state.banner.patientId === patientId) {
        nextBanner = null;
      }
      if (triggeredBreakBanner) {
        nextBanner = triggeredBreakBanner;
      }

      return {
        ...state,
        doctors: nextDoctors,
        banner: nextBanner
      };
    }

    case EVENT_TYPES.DOCTOR_ADDED: {
      const { doctor } = event.payload;
      return {
        ...state,
        doctors: [...state.doctors, doctor]
      };
    }

    case EVENT_TYPES.BANNER_DISMISSED: {
      return {
        ...state,
        banner: null
      };
    }

    case EVENT_TYPES.DEMO_RESET: {
      const { rootSeed, initialDoctors } = event.payload || {};
      return createInitialState(
        rootSeed || state.rootSeed,
        initialDoctors || INITIAL_DOCTORS
      );
    }

    // Safely ignore legacy or unknown event types
    default:
      return state;
  }
}

/**
 * Replays an entire array of events from start to finish
 * @param {Object} initialState
 * @param {Array<Object>} events
 * @returns {Object} reduced state
 */
export function reduceEvents(initialState, events = []) {
  if (!events || !events.length) return initialState;
  // Sort events by sequence number before reducing
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  return sorted.reduce((currState, evt) => eventReducer(currState, evt), initialState);
}

/**
 * Export an event log array to a formatted JSON string
 * @param {Array<Object>} events
 * @returns {string}
 */
export function exportEventsToJSON(events) {
  const exportPayload = {
    app: 'NirikshaQ',
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    eventCount: events.length,
    events
  };
  return JSON.stringify(exportPayload, null, 2);
}

/**
 * Validates and parses imported JSON event log data
 * @param {string} jsonString
 * @returns {{ valid: boolean, events?: Array<Object>, error?: string }}
 */
export function validateAndParseJSON(jsonString) {
  try {
    const data = JSON.parse(jsonString);
    let eventsList = null;

    if (Array.isArray(data)) {
      eventsList = data;
    } else if (data && Array.isArray(data.events)) {
      eventsList = data.events;
    } else {
      return { valid: false, error: 'JSON does not contain an array of events.' };
    }

    // Validate event structures
    for (let i = 0; i < eventsList.length; i++) {
      const evt = eventsList[i];
      if (!evt.id || typeof evt.seq !== 'number' || !evt.type || !evt.payload) {
        return {
          valid: false,
          error: `Event at index ${i} is missing required fields (id, seq, type, payload).`
        };
      }
    }

    // Sort by sequence number
    eventsList.sort((a, b) => a.seq - b.seq);

    return { valid: true, events: eventsList };
  } catch (err) {
    return { valid: false, error: `Invalid JSON syntax: ${err.message}` };
  }
}
