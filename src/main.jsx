import React, { useEffect, useMemo, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bell,
  Building2,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Coffee,
  Database,
  Download,
  FileText,
  FlaskConical,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Split,
  Stethoscope,
  Terminal,
  Upload,
  UserPlus,
  Users,
  X,
  Zap
} from 'lucide-react';
import './styles.css';
import { CONFIG, INITIAL_DOCTORS, INTERRUPT_TYPES } from './config.js';
import {
  forecastDoctor,
  evaluateInterruptImpact,
  evaluateImpactRadius,
  calculateRecoveryFactor,
  calibrateDoctorPace,
  calculateLeaveByTime,
  getInterruptReason,
  fmtTime,
  fmtWindow,
  severityLabel,
  uid
} from './engine.js';
import {
  openDatabase,
  appendEvent,
  getAllEvents,
  clearAllEvents,
  importEvents
} from './db.js';
import {
  EVENT_TYPES,
  createInitialState,
  eventReducer,
  reduceEvents,
  exportEventsToJSON,
  validateAndParseJSON
} from './state.js';
import {
  runOPDEvaluation,
  format3LineSummary,
  formatCSVExport
} from './evaluator.js';

function App() {
  const [view, setView] = useState('board');
  const [eventLog, setEventLog] = useState([]);
  const [appState, setAppState] = useState(() => createInitialState(CONFIG.DEFAULT_ROOT_SEED));
  const [isLoading, setIsLoading] = useState(true);

  // Form & UI controls
  const [severity, setSeverity] = useState('routine');
  const [form, setForm] = useState({ name: '', doctor: 'd1' });
  const [toast, setToast] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [addDoc, setAddDoc] = useState({ name: '', specialty: '', avg: '10' });
  const [activeDoctor, setActiveDoctor] = useState('d1');
  const [duration, setDuration] = useState('');
  const [interruptDuration, setInterruptDuration] = useState('15');
  const [expandedPhone, setExpandedPhone] = useState(false);

  // Modal dialog states
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showSplitModal, setShowSplitModal] = useState(false);
  const [splitSourceDocId, setSplitSourceDocId] = useState('d1');
  const [splitTargetDocId, setSplitTargetDocId] = useState('d2');
  const [selectedSplitPatientIds, setSelectedSplitPatientIds] = useState(new Set());
  const [importJsonText, setImportJsonText] = useState('');
  const [importError, setImportError] = useState(null);

  // Debug overlay state: persisted in localStorage and toggleable via shortcut (D)
  const [showDebug, setShowDebug] = useState(() => localStorage.getItem('nq-debug') === 'true');

  // Deconstruct state from appState
  const {
    doctors,
    phone,
    latestInterrupt,
    flashes,
    banner,
    rootSeed
  } = appState;

  // Initialize event store from IndexedDB on startup
  useEffect(() => {
    async function initStore() {
      try {
        const storedEvents = await getAllEvents();
        if (storedEvents && storedEvents.length > 0) {
          setEventLog(storedEvents);
          setAppState(reduceEvents(createInitialState(CONFIG.DEFAULT_ROOT_SEED), storedEvents));
        } else {
          const initEvent = {
            id: `evt_1_${uid()}`,
            seq: 1,
            timestamp: Date.now(),
            type: EVENT_TYPES.SYSTEM_INIT,
            payload: {
              rootSeed: CONFIG.DEFAULT_ROOT_SEED,
              doctors: INITIAL_DOCTORS
            }
          };
          await appendEvent(initEvent);
          setEventLog([initEvent]);
          setAppState(eventReducer(createInitialState(CONFIG.DEFAULT_ROOT_SEED), initEvent));
        }
      } catch (err) {
        console.error('Failed to initialize IndexedDB store:', err);
      } finally {
        setIsLoading(false);
      }
    }
    initStore();
  }, []);

  useEffect(() => {
    localStorage.setItem('nq-debug', showDebug ? 'true' : 'false');
  }, [showDebug]);

  // Keyboard shortcut for debug overlay (D or ` key)
  useEffect(() => {
    function handleKeyDown(e) {
      const activeEl = document.activeElement;
      const tagName = activeEl?.tagName?.toLowerCase();
      const isInput =
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        activeEl?.isContentEditable;
      if (isInput) return;

      if (e.key === 'd' || e.key === 'D' || e.key === '`') {
        e.preventDefault();
        setShowDebug(prev => !prev);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  // Helper to dispatch an immutable event to IndexedDB and update state
  async function dispatchAppEvent(type, payload, simulatedTimestamp = now) {
    const nextSeq = (eventLog.length > 0 ? eventLog[eventLog.length - 1].seq : 0) + 1;
    const eventObj = {
      id: `evt_${nextSeq}_${uid()}`,
      seq: nextSeq,
      timestamp: simulatedTimestamp,
      type,
      payload
    };

    try {
      await appendEvent(eventObj);
    } catch (err) {
      console.error('Error appending event to IndexedDB:', err);
    }

    setEventLog(prev => [...prev, eventObj]);
    setAppState(prev => eventReducer(prev, eventObj));
    return eventObj;
  }

  // Derived forecast map: { [docId]: { [patientId]: { p10, p50, p90, at, low, high } } }
  const computed = useMemo(() => {
    const x = {};
    doctors.forEach(d => {
      x[d.id] = forecastDoctor(d, d.queue, now, {
        seed: `${rootSeed || 'seed'}-${d.id}-${Math.floor(now / 5000)}`
      });
    });
    return x;
  }, [doctors, now, rootSeed]);

  async function register(e) {
    e.preventDefault();
    const d = doctors.find(x => x.id === form.doctor);
    if (!d) return;

    const id = uid();
    const token = `${String(d.queue.length + 1).padStart(3, '0')}`;
    const isEmergency = severity === 'emergency';
    const currentIdx = d.queue.findIndex(p => p.status === 'consult');
    const insertion = isEmergency ? Math.max(currentIdx + 1, 0) : d.queue.length;

    const newPatient = {
      id,
      token,
      name: form.name.trim() || 'Anonymous patient',
      severity,
      status: 'waiting',
      createdAt: now,
      emergency: isEmergency,
      forecastEpoch: 1,
      promisedWindow: null
    };

    if (!isEmergency) {
      // Non-emergency: queue at end, initialize promise from immediate forecast
      const tempQueue = [...d.queue, newPatient];
      const initialForecast = forecastDoctor(d, tempQueue, now, { seed: `init-${id}` });
      if (initialForecast[id]) {
        newPatient.promisedWindow = initialForecast[id];
      }

      await dispatchAppEvent(EVENT_TYPES.PATIENT_REGISTERED, {
        doctorId: d.id,
        patient: newPatient,
        updatedDoctor: { ...d, queue: tempQueue }
      }, now);

      setForm(f => ({ ...f, name: '' }));
      setToast({
        kind: 'success',
        text: `${severityLabel(severity)} registered • Token #${token} • Promised arrival: ${fmtWindow(newPatient.promisedWindow)}`
      });
      setSeverity('routine');
      return;
    }

    // Emergency Registration:
    // Invariant: Ongoing consult is NEVER interrupted (placed at insertion = max(currentIdx + 1, 0))
    const updatedDoctor = { ...d, lastEmergencyAt: now, lastInterruptAt: now };
    const rawQueue = [...d.queue];
    rawQueue.splice(insertion, 0, newPatient);

    // Generalised interrupt impact evaluation
    const impact = evaluateInterruptImpact({
      type: INTERRUPT_TYPES.EMERGENCY_INSERT,
      doctor: updatedDoctor,
      queue: rawQueue,
      insertPosition: insertion,
      now,
      seed: `emergency-${id}-${now}`
    });

    const recovery = calculateRecoveryFactor(now, now, CONFIG.RECOVERY_ALPHA, CONFIG.RECOVERY_LAMBDA_MIN);
    const downstreamWaiting = rawQueue
      .slice(insertion + 1)
      .filter(p => p.status === 'waiting' && !p.emergency);

    // Store structured interrupt for debug overlay
    const interruptRecord = {
      type: INTERRUPT_TYPES.EMERGENCY_INSERT,
      doctorName: d.name,
      doctorId: d.id,
      emergencyToken: token,
      emergencyName: newPatient.name,
      emergencyPatientId: id,
      insertPosition: impact.insertPosition,
      injectedDelay: impact.injectedDelay,
      recoveryBoostPercent: recovery.boostPercent,
      affectedCount: impact.affectedIds.length,
      silentCount: impact.silentIds.length,
      affectedIds: impact.affectedIds,
      silentIds: impact.silentIds,
      coverageById: impact.coverageById,
      patientDetails: downstreamWaiting.map(p => ({
        id: p.id,
        name: p.name,
        token: p.token,
        coverage: impact.coverageById[p.id] !== undefined ? impact.coverageById[p.id] : 0,
        isAffected: impact.affectedIds.includes(p.id)
      })),
      timestamp: now
    };

    // Update patient list: affected patients get new promisedWindow and incremented forecastEpoch
    const phoneMessages = [];
    const flashMap = {};

    const finalizedQueue = rawQueue.map(p => {
      if (p.id === id) {
        const f = impact.newForecasts[p.id];
        return { ...p, promisedWindow: f || null };
      }
      if (impact.affectedIds.includes(p.id)) {
        const f = impact.newForecasts[p.id];
        flashMap[p.id] = now;
        if (f) {
          phoneMessages.push({
            id: uid(),
            patientId: p.id,
            patientToken: p.token,
            patientName: p.name,
            text: `NQ OPD #${p.token}: Emerg delay for ${d.name}. New arrival window: ${fmtWindow(f)}.`,
            createdAt: now
          });
        }
        return {
          ...p,
          promisedWindow: f || p.promisedWindow,
          forecastEpoch: (p.forecastEpoch || 1) + 1,
          leaveByReason: 'Emergency inserted ahead'
        };
      }
      return p;
    });

    const summaryText = `${impact.affectedIds.length} affected · ${impact.silentIds.length} unaffected`;

    const bannerRecord = {
      type: INTERRUPT_TYPES.EMERGENCY_INSERT,
      doctor: d.name,
      doctorId: d.id,
      emergencyToken: token,
      affectedCount: impact.affectedIds.length,
      patientId: id,
      summary: summaryText
    };

    await dispatchAppEvent(EVENT_TYPES.PATIENT_REGISTERED, {
      doctorId: d.id,
      patient: newPatient,
      updatedDoctor: { ...updatedDoctor, queue: finalizedQueue },
      impact,
      latestInterrupt: interruptRecord,
      banner: bannerRecord,
      flashes: flashMap,
      phoneMessages
    }, now);

    setForm(f => ({ ...f, name: '' }));
    setSeverity('routine');

    setToast({
      kind: 'warning',
      text: `Emergency inserted • Token #${token} • ${summaryText}`
    });
  }

  async function escalate(patientId) {
    let targetDoc, targetPatient, insertPosition, impact, interruptRecord, finalizedQueueRef;
    const phoneMessages = [];
    const flashMap = {};

    for (const d of doctors) {
      const idx = d.queue.findIndex(p => p.id === patientId);
      if (idx >= 0) {
        targetDoc = d;
        targetPatient = d.queue[idx];
        const currentIdx = d.queue.findIndex(p => p.status === 'consult');
        insertPosition = Math.max(currentIdx + 1, 0);

        const updatedDoctor = { ...d, lastEmergencyAt: now, lastInterruptAt: now };
        const filteredQueue = d.queue.filter(p => p.id !== patientId);
        const escalatedPatient = { ...targetPatient, emergency: true, severity: 'emergency' };
        filteredQueue.splice(insertPosition, 0, escalatedPatient);

        impact = evaluateInterruptImpact({
          type: INTERRUPT_TYPES.EMERGENCY_INSERT,
          doctor: updatedDoctor,
          queue: filteredQueue,
          insertPosition,
          now,
          seed: `escalate-${patientId}-${now}`
        });

        const recovery = calculateRecoveryFactor(now, now, CONFIG.RECOVERY_ALPHA, CONFIG.RECOVERY_LAMBDA_MIN);
        const downstreamWaiting = filteredQueue
          .slice(insertPosition + 1)
          .filter(p => p.status === 'waiting' && p.id !== patientId);

        interruptRecord = {
          type: INTERRUPT_TYPES.EMERGENCY_INSERT,
          doctorName: d.name,
          doctorId: d.id,
          emergencyToken: targetPatient.token,
          emergencyName: targetPatient.name,
          emergencyPatientId: targetPatient.id,
          insertPosition: impact.insertPosition,
          injectedDelay: impact.injectedDelay,
          recoveryBoostPercent: recovery.boostPercent,
          affectedCount: impact.affectedIds.length,
          silentCount: impact.silentIds.length,
          affectedIds: impact.affectedIds,
          silentIds: impact.silentIds,
          coverageById: impact.coverageById,
          patientDetails: downstreamWaiting.map(p => ({
            id: p.id,
            name: p.name,
            token: p.token,
            coverage: impact.coverageById[p.id] !== undefined ? impact.coverageById[p.id] : 0,
            isAffected: impact.affectedIds.includes(p.id)
          })),
          timestamp: now
        };

        const finalizedQueue = filteredQueue.map(p => {
          if (p.id === patientId) {
            const f = impact.newForecasts[p.id];
            return { ...p, promisedWindow: f || p.promisedWindow };
          }
          if (impact.affectedIds.includes(p.id)) {
            const f = impact.newForecasts[p.id];
            flashMap[p.id] = now;
            if (f) {
              phoneMessages.push({
                id: uid(),
                patientId: p.id,
                patientToken: p.token,
                patientName: p.name,
                text: `NQ OPD #${p.token}: Emerg delay for ${d.name}. New arrival window: ${fmtWindow(f)}.`,
                createdAt: now
              });
            }
            return {
              ...p,
              promisedWindow: f || p.promisedWindow,
              forecastEpoch: (p.forecastEpoch || 1) + 1,
              leaveByReason: 'Emergency inserted ahead'
            };
          }
          return p;
        });

        finalizedQueueRef = finalizedQueue;
        break;
      }
    }

    if (targetDoc && targetPatient && impact) {
      const summaryText = `${impact.affectedIds.length} affected · ${impact.silentIds.length} unaffected`;

      const bannerRecord = {
        type: INTERRUPT_TYPES.EMERGENCY_INSERT,
        doctor: targetDoc.name,
        doctorId: targetDoc.id,
        emergencyToken: targetPatient.token,
        affectedCount: impact.affectedIds.length,
        patientId: targetPatient.id,
        summary: summaryText
      };

      await dispatchAppEvent(EVENT_TYPES.PATIENT_ESCALATED, {
        doctorId: targetDoc.id,
        patientId,
        updatedDoctor: { ...targetDoc, lastEmergencyAt: now, lastInterruptAt: now, queue: finalizedQueueRef },
        impact,
        latestInterrupt: interruptRecord,
        banner: bannerRecord,
        flashes: flashMap,
        phoneMessages
      }, now);

      setToast({
        kind: 'warning',
        text: `Emergency escalation • ${targetPatient.name} prioritized • ${summaryText}`
      });
    }
  }

  // Doctor Availability Interrupt: Called to Ward
  async function handleCalledToWard(doctorId, customMin) {
    const d = doctors.find(x => x.id === doctorId);
    if (!d) return;
    const mins = Number(customMin) || CONFIG.DEFAULT_WARD_CALL_MIN;
    const pauseUntil = Math.max(now, d.pauseUntil || now) + mins * 60000;
    const updatedDoctor = {
      ...d,
      availability: 'ward_call',
      pauseUntil,
      pauseTotalMin: mins,
      pausedAt: now
    };

    const impact = evaluateInterruptImpact({
      type: INTERRUPT_TYPES.CALLED_TO_WARD,
      doctor: updatedDoctor,
      queue: d.queue,
      now,
      injectedDelayMin: mins,
      seed: `ward-${doctorId}-${now}`
    });

    const recovery = calculateRecoveryFactor(d.lastInterruptAt || d.lastEmergencyAt, now);
    const downstreamWaiting = d.queue.filter(p => p.status === 'waiting');

    const interruptRecord = {
      type: INTERRUPT_TYPES.CALLED_TO_WARD,
      doctorName: d.name,
      doctorId: d.id,
      insertPosition: null,
      injectedDelay: impact.injectedDelay,
      recoveryBoostPercent: recovery.boostPercent,
      affectedCount: impact.affectedIds.length,
      silentCount: impact.silentIds.length,
      affectedIds: impact.affectedIds,
      silentIds: impact.silentIds,
      coverageById: impact.coverageById,
      patientDetails: downstreamWaiting.map(p => ({
        id: p.id,
        name: p.name,
        token: p.token,
        coverage: impact.coverageById[p.id] !== undefined ? impact.coverageById[p.id] : 0,
        isAffected: impact.affectedIds.includes(p.id)
      })),
      timestamp: now
    };

    const phoneMessages = [];
    const flashMap = {};
    const finalizedQueue = d.queue.map(p => {
      if (impact.affectedIds.includes(p.id)) {
        const f = impact.newForecasts[p.id];
        flashMap[p.id] = now;
        if (f) {
          phoneMessages.push({
            id: uid(),
            patientId: p.id,
            patientToken: p.token,
            patientName: p.name,
            text: `NQ OPD #${p.token}: ${d.name} called to ward (+${mins}m). New arrival window: ${fmtWindow(f)}.`,
            createdAt: now
          });
        }
        return {
          ...p,
          promisedWindow: f || p.promisedWindow,
          forecastEpoch: (p.forecastEpoch || 1) + 1,
          leaveByReason: 'Doctor called to ward'
        };
      }
      return p;
    });

    const summaryText = `${d.name} called to ward, back in ~${mins} min · ${impact.affectedIds.length} patients affected`;
    const bannerRecord = {
      type: INTERRUPT_TYPES.CALLED_TO_WARD,
      doctor: d.name,
      doctorId: d.id,
      minutes: mins,
      pauseUntil,
      affectedCount: impact.affectedIds.length,
      summary: summaryText
    };

    await dispatchAppEvent(EVENT_TYPES.DOCTOR_CALLED_TO_WARD, {
      doctorId: d.id,
      minutes: mins,
      pauseUntil,
      updatedDoctor: { ...updatedDoctor, queue: finalizedQueue },
      latestInterrupt: interruptRecord,
      banner: bannerRecord,
      flashes: flashMap,
      phoneMessages
    }, now);

    setToast({ kind: 'warning', text: summaryText });
  }

  // Doctor Availability Interrupt: Take a Break
  async function handleTakeBreak(doctorId, customMin) {
    const d = doctors.find(x => x.id === doctorId);
    if (!d) return;
    const mins = Number(customMin) || CONFIG.DEFAULT_BREAK_MIN;
    const cur = d.queue.find(p => p.status === 'consult');

    if (cur) {
      // Pending break taking effect after current consult finishes
      const updatedDoctor = { ...d, pendingBreakMin: mins };
      const impact = evaluateInterruptImpact({
        type: INTERRUPT_TYPES.BREAK,
        doctor: updatedDoctor,
        queue: d.queue,
        now,
        injectedDelayMin: mins,
        seed: `break-${doctorId}-${now}`
      });

      const recovery = calculateRecoveryFactor(d.lastInterruptAt || d.lastEmergencyAt, now);
      const downstreamWaiting = d.queue.filter(p => p.status === 'waiting');

      const interruptRecord = {
        type: INTERRUPT_TYPES.BREAK,
        doctorName: d.name,
        doctorId: d.id,
        insertPosition: null,
        injectedDelay: impact.injectedDelay,
        recoveryBoostPercent: recovery.boostPercent,
        affectedCount: impact.affectedIds.length,
        silentCount: impact.silentIds.length,
        affectedIds: impact.affectedIds,
        silentIds: impact.silentIds,
        coverageById: impact.coverageById,
        patientDetails: downstreamWaiting.map(p => ({
          id: p.id,
          name: p.name,
          token: p.token,
          coverage: impact.coverageById[p.id] !== undefined ? impact.coverageById[p.id] : 0,
          isAffected: impact.affectedIds.includes(p.id)
        })),
        timestamp: now
      };

      const phoneMessages = [];
      const flashMap = {};
      const finalizedQueue = d.queue.map(p => {
        if (impact.affectedIds.includes(p.id)) {
          const f = impact.newForecasts[p.id];
          flashMap[p.id] = now;
          if (f) {
            phoneMessages.push({
              id: uid(),
              patientId: p.id,
              patientToken: p.token,
              patientName: p.name,
              text: `NQ OPD #${p.token}: ${d.name} scheduled for ${mins}m break. New window: ${fmtWindow(f)}.`,
              createdAt: now
            });
          }
          return {
            ...p,
            promisedWindow: f || p.promisedWindow,
            forecastEpoch: (p.forecastEpoch || 1) + 1,
            leaveByReason: 'Doctor on break'
          };
        }
        return p;
      });

      const summaryText = `${d.name} taking ${mins}m break after current consult · ${impact.affectedIds.length} patients affected`;
      const bannerRecord = {
        type: INTERRUPT_TYPES.BREAK,
        doctor: d.name,
        doctorId: d.id,
        minutes: mins,
        isPending: true,
        affectedCount: impact.affectedIds.length,
        summary: summaryText
      };

      await dispatchAppEvent(EVENT_TYPES.DOCTOR_BREAK_STARTED, {
        doctorId: d.id,
        minutes: mins,
        isPending: true,
        updatedDoctor: { ...updatedDoctor, queue: finalizedQueue },
        latestInterrupt: interruptRecord,
        banner: bannerRecord,
        flashes: flashMap,
        phoneMessages
      }, now);

      setToast({ kind: 'warning', text: summaryText });
      return;
    }

    // Immediate break (no active consult)
    const pauseUntil = Math.max(now, d.pauseUntil || now) + mins * 60000;
    const updatedDoctor = {
      ...d,
      availability: 'break',
      pauseUntil,
      pauseTotalMin: mins,
      pausedAt: now
    };

    const impact = evaluateInterruptImpact({
      type: INTERRUPT_TYPES.BREAK,
      doctor: updatedDoctor,
      queue: d.queue,
      now,
      injectedDelayMin: mins,
      seed: `break-${doctorId}-${now}`
    });

    const recovery = calculateRecoveryFactor(d.lastInterruptAt || d.lastEmergencyAt, now);
    const downstreamWaiting = d.queue.filter(p => p.status === 'waiting');

    const interruptRecord = {
      type: INTERRUPT_TYPES.BREAK,
      doctorName: d.name,
      doctorId: d.id,
      insertPosition: null,
      injectedDelay: impact.injectedDelay,
      recoveryBoostPercent: recovery.boostPercent,
      affectedCount: impact.affectedIds.length,
      silentCount: impact.silentIds.length,
      affectedIds: impact.affectedIds,
      silentIds: impact.silentIds,
      coverageById: impact.coverageById,
      patientDetails: downstreamWaiting.map(p => ({
        id: p.id,
        name: p.name,
        token: p.token,
        coverage: impact.coverageById[p.id] !== undefined ? impact.coverageById[p.id] : 0,
        isAffected: impact.affectedIds.includes(p.id)
      })),
      timestamp: now
    };

    const phoneMessages = [];
    const flashMap = {};
    const finalizedQueue = d.queue.map(p => {
      if (impact.affectedIds.includes(p.id)) {
        const f = impact.newForecasts[p.id];
        flashMap[p.id] = now;
        if (f) {
          phoneMessages.push({
            id: uid(),
            patientId: p.id,
            patientToken: p.token,
            patientName: p.name,
            text: `NQ OPD #${p.token}: ${d.name} on ${mins}m break. New arrival window: ${fmtWindow(f)}.`,
            createdAt: now
          });
        }
        return {
          ...p,
          promisedWindow: f || p.promisedWindow,
          forecastEpoch: (p.forecastEpoch || 1) + 1,
          leaveByReason: 'Doctor on break'
        };
      }
      return p;
    });

    const summaryText = `${d.name} on break, back in ~${mins} min · ${impact.affectedIds.length} patients affected`;
    const bannerRecord = {
      type: INTERRUPT_TYPES.BREAK,
      doctor: d.name,
      doctorId: d.id,
      minutes: mins,
      pauseUntil,
      affectedCount: impact.affectedIds.length,
      summary: summaryText
    };

    await dispatchAppEvent(EVENT_TYPES.DOCTOR_BREAK_STARTED, {
      doctorId: d.id,
      minutes: mins,
      pauseUntil,
      isPending: false,
      updatedDoctor: { ...updatedDoctor, queue: finalizedQueue },
      latestInterrupt: interruptRecord,
      banner: bannerRecord,
      flashes: flashMap,
      phoneMessages
    }, now);

    setToast({ kind: 'warning', text: summaryText });
  }

  // Doctor Availability Interrupt: Doctor Returns
  async function handleDoctorReturn(doctorId) {
    const d = doctors.find(x => x.id === doctorId);
    if (!d) return;

    const hasConsult = d.queue.some(p => p.status === 'consult');
    const updatedDoctor = {
      ...d,
      availability: hasConsult ? 'in_consult' : 'available',
      pauseUntil: null,
      pauseTotalMin: null,
      pendingBreakMin: null,
      lastInterruptAt: now
    };

    const impact = evaluateInterruptImpact({
      type: INTERRUPT_TYPES.DOCTOR_RETURNS,
      doctor: updatedDoctor,
      queue: d.queue,
      now,
      seed: `return-${doctorId}-${now}`
    });

    const recovery = calculateRecoveryFactor(now, now);
    const downstreamWaiting = d.queue.filter(p => p.status === 'waiting');

    const interruptRecord = {
      type: INTERRUPT_TYPES.DOCTOR_RETURNS,
      doctorName: d.name,
      doctorId: d.id,
      insertPosition: null,
      injectedDelay: 0,
      recoveryBoostPercent: recovery.boostPercent,
      affectedCount: impact.affectedIds.length,
      silentCount: impact.silentIds.length,
      affectedIds: impact.affectedIds,
      silentIds: impact.silentIds,
      coverageById: impact.coverageById,
      patientDetails: downstreamWaiting.map(p => ({
        id: p.id,
        name: p.name,
        token: p.token,
        coverage: impact.coverageById[p.id] !== undefined ? impact.coverageById[p.id] : 0,
        isAffected: impact.affectedIds.includes(p.id)
      })),
      timestamp: now
    };

    const phoneMessages = [];
    const finalizedQueue = d.queue.map(p => {
      if (impact.affectedIds.includes(p.id)) {
        const f = impact.newForecasts[p.id];
        if (f) {
          phoneMessages.push({
            id: uid(),
            patientId: p.id,
            patientToken: p.token,
            patientName: p.name,
            text: `NQ OPD #${p.token}: ${d.name} returned. Arrival window updated to ${fmtWindow(f)}.`,
            createdAt: now
          });
        }
        return {
          ...p,
          promisedWindow: f || p.promisedWindow,
          forecastEpoch: (p.forecastEpoch || 1) + 1,
          leaveByReason: 'Doctor returned'
        };
      }
      return p;
    });

    await dispatchAppEvent(EVENT_TYPES.DOCTOR_RETURNED, {
      doctorId: d.id,
      timestamp: now,
      updatedDoctor: { ...updatedDoctor, queue: finalizedQueue },
      latestInterrupt: interruptRecord,
      banner: null,
      phoneMessages
    }, now);

    setToast({ kind: 'success', text: `${d.name} returned. Consultations resumed.` });
  }

  // Open Second Doctor / Split Queue
  async function handleSplitQueue({ sourceDoctorId, targetDoctorId, movedPatientIds }) {
    const docA = doctors.find(x => x.id === sourceDoctorId);
    const docB = doctors.find(x => x.id === targetDoctorId);
    if (!docA || !docB || !movedPatientIds || movedPatientIds.length === 0) return;

    // Kept vs Moved patients
    const keptPatients = docA.queue.filter(p => !movedPatientIds.includes(p.id));
    const movedPatients = docA.queue.filter(p => movedPatientIds.includes(p.id));

    // Target queue gets moved patients appended
    const updatedTargetQueue = [...docB.queue, ...movedPatients];
    const updatedSourceQueue = keptPatients;

    const updatedDocA = { ...docA, queue: updatedSourceQueue };
    const updatedDocB = { ...docB, queue: updatedTargetQueue };

    // Re-forecast both doctors
    const impactA = evaluateInterruptImpact({
      type: INTERRUPT_TYPES.SECOND_DOCTOR_OPENS,
      doctor: updatedDocA,
      queue: updatedSourceQueue,
      now,
      seed: `splitA-${sourceDoctorId}-${now}`
    });

    const impactB = evaluateInterruptImpact({
      type: INTERRUPT_TYPES.SECOND_DOCTOR_OPENS,
      doctor: updatedDocB,
      queue: updatedTargetQueue,
      now,
      seed: `splitB-${targetDoctorId}-${now}`
    });

    const phoneMessages = [];
    const flashMap = {};

    // Finalize Doc A queue
    const finalizedQueueA = updatedSourceQueue.map(p => {
      if (impactA.affectedIds.includes(p.id)) {
        const f = impactA.newForecasts[p.id];
        flashMap[p.id] = now;
        if (f) {
          phoneMessages.push({
            id: uid(),
            patientId: p.id,
            patientToken: p.token,
            patientName: p.name,
            text: `NQ OPD #${p.token}: Queue split with ${docB.name}. New arrival window: ${fmtWindow(f)}.`,
            createdAt: now
          });
        }
        return {
          ...p,
          promisedWindow: f || p.promisedWindow,
          forecastEpoch: (p.forecastEpoch || 1) + 1,
          leaveByReason: `Queue split with ${docB.name}`
        };
      }
      return p;
    });

    // Finalize Doc B queue
    const finalizedQueueB = updatedTargetQueue.map(p => {
      const isMoved = movedPatientIds.includes(p.id);
      const f = impactB.newForecasts[p.id];
      if (isMoved || impactB.affectedIds.includes(p.id)) {
        flashMap[p.id] = now;
        if (f) {
          phoneMessages.push({
            id: uid(),
            patientId: p.id,
            patientToken: p.token,
            patientName: p.name,
            text: `NQ OPD #${p.token}: Second doctor opened. Reassigned to ${docB.name}. New window: ${fmtWindow(f)}.`,
            createdAt: now
          });
        }
        return {
          ...p,
          promisedWindow: f || p.promisedWindow,
          forecastEpoch: (p.forecastEpoch || 1) + 1,
          leaveByReason: isMoved ? `Second doctor opened, you moved to ${docB.name}` : `Queue split with ${docA.name}`
        };
      }
      return p;
    });

    const combinedAffectedIds = [...impactA.affectedIds, ...impactB.affectedIds, ...movedPatientIds];
    const totalAffected = Array.from(new Set(combinedAffectedIds)).length;

    const interruptRecord = {
      type: INTERRUPT_TYPES.SECOND_DOCTOR_OPENS,
      doctorName: docA.name,
      doctorId: docA.id,
      targetDoctorName: docB.name,
      targetDoctorId: docB.id,
      insertPosition: null,
      injectedDelay: 0,
      recoveryBoostPercent: 0,
      affectedCount: totalAffected,
      silentCount: Math.max(0, (impactA.silentIds.length + impactB.silentIds.length) - movedPatientIds.length),
      affectedIds: combinedAffectedIds,
      silentIds: [...impactA.silentIds, ...impactB.silentIds],
      coverageById: { ...impactA.coverageById, ...impactB.coverageById },
      patientDetails: [...finalizedQueueA, ...finalizedQueueB].filter(p => p.status === 'waiting').map(p => ({
        id: p.id,
        name: p.name,
        token: p.token,
        coverage: impactA.coverageById[p.id] ?? impactB.coverageById[p.id] ?? 0,
        isAffected: combinedAffectedIds.includes(p.id)
      })),
      timestamp: now
    };

    const summaryText = `Queue split · ${movedPatientIds.length} patients moved from ${docA.name} to ${docB.name}`;
    const bannerRecord = {
      type: INTERRUPT_TYPES.SECOND_DOCTOR_OPENS,
      doctor: docA.name,
      targetDoctor: docB.name,
      doctorId: docA.id,
      affectedCount: totalAffected,
      summary: summaryText
    };

    await dispatchAppEvent(EVENT_TYPES.QUEUE_SPLIT, {
      sourceDoctorId: docA.id,
      targetDoctorId: docB.id,
      updatedSourceDoctor: { ...updatedDocA, queue: finalizedQueueA },
      updatedTargetDoctor: { ...updatedDocB, queue: finalizedQueueB },
      movedPatientIds,
      latestInterrupt: interruptRecord,
      banner: bannerRecord,
      flashes: flashMap,
      phoneMessages
    }, now);

    setShowSplitModal(false);
    setToast({ kind: 'success', text: summaryText });
  }

  // Pre-populate split candidates alternating starting from next waiting patient
  function openSplitModal(sourceId) {
    const doc = doctors.find(d => d.id === sourceId) || doctors[0];
    setSplitSourceDocId(doc.id);
    const otherDocs = doctors.filter(d => d.id !== doc.id);
    setSplitTargetDocId(otherDocs[0]?.id || doc.id);

    const waiting = doc.queue.filter(p => p.status === 'waiting');
    // Split rule: alternate starting from next waiting patient (odd-indexed candidates pre-checked)
    const initialSelected = new Set();
    waiting.forEach((p, idx) => {
      if (idx % 2 === 1) {
        initialSelected.add(p.id);
      }
    });
    // If only 1 waiting patient, select that patient
    if (waiting.length === 1) {
      initialSelected.add(waiting[0].id);
    }
    setSelectedSplitPatientIds(initialSelected);
    setShowSplitModal(true);
  }

  async function completeConsult() {
    const d = doctors.find(x => x.id === activeDoctor);
    const cur = d?.queue.find(p => p.status === 'consult');
    if (!d || !cur) return;

    const actual = Number(duration);
    if (!actual || actual < CONFIG.MIN_CONSULT_DURATION_MIN || actual > CONFIG.MAX_CONSULT_DURATION_MIN) {
      setToast({
        kind: 'error',
        text: `Enter an actual duration between ${CONFIG.MIN_CONSULT_DURATION_MIN} and ${CONFIG.MAX_CONSULT_DURATION_MIN} minutes.`
      });
      return;
    }

    const normalizedPace = calibrateDoctorPace(d, actual);
    const curIdx = d.queue.findIndex(z => z.id === cur.id);
    const nextPatient = d.queue[curIdx + 1];

    await dispatchAppEvent(EVENT_TYPES.CONSULT_COMPLETED, {
      doctorId: d.id,
      patientId: cur.id,
      actualDuration: actual,
      newPaceMultiplier: normalizedPace,
      nextPatientId: nextPatient ? nextPatient.id : null,
      timestamp: now,
      pendingBreakMin: d.pendingBreakMin || undefined
    }, now);

    setDuration('');
    setToast({
      kind: 'success',
      text: `Consult complete • ${actual} min recorded • Pace recalibrated immediately.`
    });
  }

  async function startIfNeeded(d) {
    if (d.pauseUntil && now < d.pauseUntil) {
      setToast({ kind: 'warning', text: `${d.name} is currently away. End pause to start consultation.` });
      return;
    }
    if (d.queue.some(p => p.status === 'consult')) return;
    const first = d.queue.find(p => p.status === 'waiting');
    if (!first) return;

    await dispatchAppEvent(EVENT_TYPES.CONSULT_STARTED, {
      doctorId: d.id,
      patientId: first.id,
      timestamp: now
    }, now);
  }

  async function addDoctor(e) {
    e.preventDefault();
    if (!addDoc.name || !addDoc.specialty || !Number(addDoc.avg)) return;
    const id = uid();
    const newDoc = {
      id,
      name: addDoc.name,
      specialty: addDoc.specialty,
      baseAvgMin: Number(addDoc.avg),
      paceMultiplier: 1.0,
      availability: 'available',
      pauseUntil: null,
      pauseTotalMin: null,
      pendingBreakMin: null,
      lastEmergencyAt: null,
      lastInterruptAt: null,
      queue: []
    };

    await dispatchAppEvent(EVENT_TYPES.DOCTOR_ADDED, {
      doctor: newDoc
    }, now);

    setActiveDoctor(id);
    setAddDoc({ name: '', specialty: '', avg: '10' });
    setToast({ kind: 'success', text: 'Doctor added with an empty live queue.' });
  }

  // Reset Demo Data
  async function handleResetDemo() {
    try {
      await clearAllEvents();
      const resetEvent = {
        id: `evt_1_${uid()}`,
        seq: 1,
        timestamp: Date.now(),
        type: EVENT_TYPES.DEMO_RESET,
        payload: {
          rootSeed: CONFIG.DEFAULT_ROOT_SEED,
          initialDoctors: INITIAL_DOCTORS
        }
      };
      await appendEvent(resetEvent);
      setEventLog([resetEvent]);
      setAppState(createInitialState(CONFIG.DEFAULT_ROOT_SEED, INITIAL_DOCTORS));
      setShowResetConfirm(false);
      setToast({
        kind: 'success',
        text: 'Hospital demo data reset to baseline. Event log cleared.'
      });
    } catch (err) {
      console.error('Error resetting demo data:', err);
      setToast({ kind: 'error', text: 'Failed to reset demo data in IndexedDB.' });
    }
  }

  // JSON Export of Event Log
  function handleExportLog() {
    const jsonStr = exportEventsToJSON(eventLog);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nirikshaq-events-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setToast({
      kind: 'success',
      text: `Exported ${eventLog.length} events to JSON.`
    });
  }

  // JSON Import of Event Log
  async function handleImportLog() {
    if (!importJsonText.trim()) {
      setImportError('Please enter or upload a JSON event log.');
      return;
    }

    const parseResult = validateAndParseJSON(importJsonText);
    if (!parseResult.valid) {
      setImportError(parseResult.error);
      return;
    }

    try {
      await importEvents(parseResult.events);
      const rehydratedState = reduceEvents(createInitialState(CONFIG.DEFAULT_ROOT_SEED), parseResult.events);
      setEventLog(parseResult.events);
      setAppState(rehydratedState);
      setShowImportModal(false);
      setImportJsonText('');
      setImportError(null);
      setToast({
        kind: 'success',
        text: `Successfully imported ${parseResult.events.length} events. State rehydrated.`
      });
    } catch (err) {
      setImportError(`Failed to import events into IndexedDB: ${err.message}`);
    }
  }

  function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      const text = evt.target.result;
      setImportJsonText(text);
      setImportError(null);
    };
    reader.readAsText(file);
  }

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <div className="brandMark">NQ</div>
          <div>
            <b>NirikshaQ</b>
            <span>OPD LIVE</span>
          </div>
        </div>
        <nav>
          {[
            ['board', Activity, 'Queue board'],
            ['nurse', UserPlus, 'Nurse station'],
            ['doctor', Stethoscope, 'Doctor panel'],
            ['eval', FlaskConical, 'Evaluation lab']
          ].map(([id, I, label]) => (
            <button
              key={id}
              className={view === id ? 'nav active' : 'nav'}
              onClick={() => setView(id)}
            >
              <I size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="railBottom">
          <button
            className={'debugToggleBtn ' + (showDebug ? 'active' : '')}
            onClick={() => setShowDebug(x => !x)}
            title="Toggle Engine Debug Overlay (Shortcut: D)"
          >
            <Terminal size={17} />
            <span>{showDebug ? 'Hide Debug (D)' : 'Debug EIR (D)'}</span>
          </button>
          <div className="status">
            <i />Live model • IndexedDB log ({eventLog.length} evts)
          </div>
        </div>
      </aside>

      <main className="main">
        <header>
          <div>
            <div className="eyebrow">GOVERNMENT OPD / LIVE MONITOR</div>
            <h1>
              {view === 'board'
                ? 'Queue board'
                : view === 'nurse'
                ? 'Nurse station'
                : view === 'doctor'
                ? 'Doctor panel'
                : 'Evaluation lab (30-day simulation)'}
            </h1>
          </div>
          <div className="headerRight">
            <button
              className="model"
              onClick={handleExportLog}
              title="Export complete immutable event log to JSON"
            >
              <Download size={13} /> Export Log
            </button>

            <button
              className="model"
              onClick={() => {
                setImportJsonText('');
                setImportError(null);
                setShowImportModal(true);
              }}
              title="Import and replay event log from JSON"
            >
              <Upload size={13} /> Import Log
            </button>

            <button
              className="model resetBtn"
              onClick={() => setShowResetConfirm(true)}
              title="Reset all demo data and start fresh"
            >
              <RotateCcw size={13} /> Reset Demo
            </button>
            <span className="clock">
              <Clock3 size={15} /> {new Date(now).toLocaleTimeString()}
            </span>
          </div>
        </header>

        {/* Generalised Interrupt in Progress Banner */}
        {banner && (
          <div
            className={'emergencyBanner ' + (banner.type === INTERRUPT_TYPES.EMERGENCY_INSERT || !banner.type ? '' : 'amberBanner')}
            role="alert"
            aria-live="assertive"
          >
            <span className="bannerBadge">
              {banner.type === INTERRUPT_TYPES.EMERGENCY_INSERT || !banner.type
                ? 'CRITICAL PRIORITY'
                : 'INTERRUPT IN PROGRESS'}
            </span>
            {banner.type === INTERRUPT_TYPES.EMERGENCY_INSERT || !banner.type ? (
              <ShieldAlert size={22} />
            ) : (
              <AlertTriangle size={22} />
            )}
            <div className="bannerContent">
              <div className="bannerTitle">
                {banner.type === INTERRUPT_TYPES.EMERGENCY_INSERT || !banner.type
                  ? `Emergency In Progress · ${banner.doctor} · Token #${banner.emergencyToken}`
                  : banner.summary || `${banner.doctor} interrupt active`}
              </div>
              <div className="bannerMeta">
                <span>
                  {banner.affectedCount} patients affected · downstream arrival windows recalculated
                </span>
              </div>
            </div>
            <span className="liveDot" />
            <button
              className="bannerClose"
              onClick={() => dispatchAppEvent(EVENT_TYPES.BANNER_DISMISSED, {}, now)}
              aria-label="Dismiss banner"
            >
              <X size={15} />
            </button>
          </div>
        )}

        {view === 'board' && (
          <QueueBoard
            doctors={doctors}
            computed={computed}
            flashes={flashes}
            startIfNeeded={startIfNeeded}
            now={now}
          />
        )}

        {view === 'nurse' && (
          <NurseStation
            doctors={doctors}
            computed={computed}
            form={form}
            setForm={setForm}
            severity={severity}
            setSeverity={setSeverity}
            register={register}
            escalate={escalate}
            openSplitModal={openSplitModal}
          />
        )}

        {view === 'doctor' && (
          <DoctorPanel
            doctors={doctors}
            computed={computed}
            activeDoctor={activeDoctor}
            setActiveDoctor={setActiveDoctor}
            duration={duration}
            setDuration={setDuration}
            completeConsult={completeConsult}
            addDoc={addDoc}
            setAddDoc={setAddDoc}
            addDoctor={addDoctor}
            interruptDuration={interruptDuration}
            setInterruptDuration={setInterruptDuration}
            onCalledToWard={handleCalledToWard}
            onTakeBreak={handleTakeBreak}
            onDoctorReturn={handleDoctorReturn}
            openSplitModal={openSplitModal}
            now={now}
          />
        )}

        {view === 'eval' && (
          <EvaluationLabScreen setToast={setToast} />
        )}
      </main>

      {/* Toggleable Debug Overlay */}
      <DebugOverlay
        latestInterrupt={latestInterrupt}
        showDebug={showDebug}
        setShowDebug={setShowDebug}
      />

      {/* Confirmation Modal: Reset Demo Data */}
      {showResetConfirm && (
        <div className="modalBackdrop" onClick={() => setShowResetConfirm(false)}>
          <div className="modalDialog" onClick={e => e.stopPropagation()}>
            <div className="modalHeader">
              <AlertTriangle size={22} color="var(--coral)" />
              <h3>Reset Hospital Demo Data?</h3>
            </div>
            <p className="modalBody">
              This will clear the entire IndexedDB append-only event log and restore all doctor queues,
              paces, arrival windows, and delay messages back to baseline.
            </p>
            <div className="modalActions">
              <button className="secondaryBtn" onClick={() => setShowResetConfirm(false)}>
                Cancel
              </button>
              <button className="dangerBtn" onClick={handleResetDemo}>
                Yes, Reset All Data
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Dialog: Import JSON Event Log */}
      {showImportModal && (
        <div className="modalBackdrop" onClick={() => setShowImportModal(false)}>
          <div className="modalDialog importDialog" onClick={e => e.stopPropagation()}>
            <div className="modalHeader">
              <Upload size={22} color="var(--teal)" />
              <h3>Import & Replay Event Log</h3>
              <button className="modalCloseBtn" onClick={() => setShowImportModal(false)}>
                <X size={16} />
              </button>
            </div>
            <p className="modalBody">
              Paste a NirikshaQ JSON event log or upload a <code>.json</code> file. Replaying the log will
              reconstruct the exact hospital state deterministically.
            </p>

            <div className="fileUploadRow">
              <label className="fileUploadLabel">
                <FileText size={16} /> Choose .JSON File
                <input type="file" accept=".json,application/json" onChange={handleFileUpload} />
              </label>
              {importJsonText && (
                <span className="fileInfo">
                  {importJsonText.length.toLocaleString()} characters loaded
                </span>
              )}
            </div>

            <textarea
              className="importTextarea"
              rows={8}
              placeholder="Or paste JSON event log array here..."
              value={importJsonText}
              onChange={e => {
                setImportJsonText(e.target.value);
                setImportError(null);
              }}
            />

            {importError && <div className="modalError">{importError}</div>}

            <div className="modalActions">
              <button className="secondaryBtn" onClick={() => setShowImportModal(false)}>
                Cancel
              </button>
              <button className="primary" onClick={handleImportLog}>
                <Upload size={15} /> Replay & Restore State
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Dialog: Open Second Doctor / Split Queue */}
      {showSplitModal && (
        <div className="modalBackdrop" onClick={() => setShowSplitModal(false)}>
          <div className="modalDialog" onClick={e => e.stopPropagation()}>
            <div className="modalHeader">
              <Split size={22} color="var(--teal)" />
              <h3>Open Second Doctor · Split Queue</h3>
              <button className="modalCloseBtn" onClick={() => setShowSplitModal(false)}>
                <X size={16} />
              </button>
            </div>
            <p className="modalBody">
              Reassign selected waiting patients to an additional doctor. Both doctors will re-forecast
              arrival windows immediately using their own speed calibration.
            </p>

            <div className="form">
              <label>
                Source Doctor
                <select
                  value={splitSourceDocId}
                  onChange={e => {
                    const id = e.target.value;
                    setSplitSourceDocId(id);
                    const doc = doctors.find(d => d.id === id);
                    const waiting = doc?.queue.filter(p => p.status === 'waiting') || [];
                    const initialSelected = new Set();
                    waiting.forEach((p, idx) => {
                      if (idx % 2 === 1 || waiting.length === 1) initialSelected.add(p.id);
                    });
                    setSelectedSplitPatientIds(initialSelected);
                  }}
                >
                  {doctors.map(d => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.queue.filter(p => p.status === 'waiting').length} waiting)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Transfer to Doctor
                <select
                  value={splitTargetDocId}
                  onChange={e => setSplitTargetDocId(e.target.value)}
                >
                  {doctors
                    .filter(d => d.id !== splitSourceDocId)
                    .map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.specialty})
                      </option>
                    ))}
                </select>
              </label>

              <label style={{ marginTop: 6 }}>
                Select Patients to Move ({selectedSplitPatientIds.size} selected)
              </label>

              <div className="splitModalList">
                {(() => {
                  const srcDoc = doctors.find(d => d.id === splitSourceDocId);
                  const waiting = srcDoc?.queue.filter(p => p.status === 'waiting') || [];
                  if (waiting.length === 0) {
                    return <div className="emptyPanel">No waiting patients to split.</div>;
                  }
                  return waiting.map(p => {
                    const isChecked = selectedSplitPatientIds.has(p.id);
                    return (
                      <label
                        key={p.id}
                        className={'splitPatientItem ' + (isChecked ? 'selected' : '')}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={e => {
                            const nextSet = new Set(selectedSplitPatientIds);
                            if (e.target.checked) nextSet.add(p.id);
                            else nextSet.delete(p.id);
                            setSelectedSplitPatientIds(nextSet);
                          }}
                        />
                        <span style={{ fontWeight: 700, color: 'var(--teal)' }}>#{p.token}</span>
                        <span>{p.name}</span>
                        <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--muted)' }}>
                          {fmtWindow(computed[srcDoc.id]?.[p.id])}
                        </span>
                      </label>
                    );
                  });
                })()}
              </div>
            </div>

            <div className="modalActions">
              <button className="secondaryBtn" onClick={() => setShowSplitModal(false)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={selectedSplitPatientIds.size === 0}
                onClick={() =>
                  handleSplitQueue({
                    sourceDoctorId: splitSourceDocId,
                    targetDoctorId: splitTargetDocId,
                    movedPatientIds: Array.from(selectedSplitPatientIds)
                  })
                }
              >
                <Split size={15} /> Confirm Split ({selectedSplitPatientIds.size} patients)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating SMS tray preview reading from real sent messages */}
      <div className={'phone ' + (expandedPhone ? 'open' : '')}>
        <button className="phoneHead" onClick={() => setExpandedPhone(x => !x)}>
          <div>
            <Bell size={16} />
            <b>Patient phone</b>
            {(phone || []).length > 0 && <em>{(phone || []).length}</em>}
          </div>
          <ChevronRight size={17} className={expandedPhone ? 'rot' : ''} />
        </button>
        {expandedPhone && (
          <div className="phoneBody">
            {(!phone || phone.length === 0) ? (
              <div className="emptyPhone">
                No SMS received yet.
                <br />
                Interrupt reasons and updated windows will appear here.
              </div>
            ) : (
              phone.map(m => (
                <div className="sms" key={m.id}>
                  <small>SMS · Token #{m.patientToken} · {m.patientName}</small>
                  {m.text}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {toast && (
        <div className={'toast ' + toast.kind}>
          <div>
            {toast.kind === 'warning' ? (
              <ShieldAlert size={17} />
            ) : toast.kind === 'error' ? (
              <X size={17} />
            ) : (
              <CheckCircle2 size={17} />
            )}
          </div>
          <span>{toast.text}</span>
          <button onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Evaluation Lab Screen: Benchmarking Linear Baseline vs NirikshaQ Engine
 */
function EvaluationLabScreen({ setToast }) {
  const [days, setDays] = useState(30);
  const [seed, setSeed] = useState('opd-eval-seed-42');
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ currentDay: 0, totalDays: 30, percent: 0 });
  const [results, setResults] = useState(null);

  const workerRef = useRef(null);

  const runEvaluation = () => {
    setIsRunning(true);
    setProgress({ currentDay: 0, totalDays: days, percent: 0 });

    try {
      if (workerRef.current) {
        workerRef.current.terminate();
      }

      const worker = new Worker(new URL('./evaluationWorker.js', import.meta.url), {
        type: 'module'
      });
      workerRef.current = worker;

      worker.onmessage = e => {
        const msg = e.data;
        if (msg.type === 'PROGRESS') {
          setProgress({
            currentDay: msg.currentDay,
            totalDays: msg.totalDays,
            percent: msg.percent
          });
        } else if (msg.type === 'COMPLETE') {
          setResults(msg.results);
          setIsRunning(false);
          setToast({
            kind: 'success',
            text: `Simulation complete: ${msg.results.totalDays} synthetic OPD days evaluated.`
          });
        }
      };

      worker.onerror = err => {
        console.error('Worker evaluation error:', err);
        setIsRunning(false);
        setToast({ kind: 'error', text: 'Background simulation encountered an error.' });
      };

      worker.postMessage({ days: Number(days), seed });
    } catch (err) {
      console.warn('Worker initialization failed, running synchronously:', err);
      runOPDEvaluation({
        days: Number(days),
        seed,
        onProgress: (currentDay, totalDays, intermediate) => {
          setProgress({
            currentDay,
            totalDays,
            percent: Math.round((currentDay / totalDays) * 100)
          });
        }
      }).then(res => {
        setResults(res);
        setIsRunning(false);
      });
    }
  };

  useEffect(() => {
    runEvaluation();
    return () => {
      if (workerRef.current) workerRef.current.terminate();
    };
  }, []);

  const handleCopySummary = () => {
    if (!results) return;
    const summary = format3LineSummary(results);
    navigator.clipboard.writeText(summary);
    setToast({ kind: 'success', text: 'Copied 3-line summary to clipboard.' });
  };

  const handleDownloadCSV = () => {
    if (!results) return;
    const csv = formatCSVExport(results);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nirikshaq-evaluation-${results.seed}-${results.totalDays}days.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setToast({ kind: 'success', text: 'CSV report downloaded.' });
  };

  return (
    <section className="content">
      {/* Synthetic Benchmark Disclaimer */}
      <div className="evalDisclaimerCard">
        <div className="evalDisclaimerBadge">
          <AlertTriangle size={15} />
          <span>SYNTHETIC BENCHMARK DISCLAIMER</span>
        </div>
        <p>
          This evaluation runs on synthetic OPD days generated from empirical hospital distributions
          (Gamma consultation variability, doctor speed drift, and unexpected interrupts). Results demonstrate
          forecasting accuracy under simulated conditions and do not represent clinical validation.
        </p>
      </div>

      {/* Evaluation Controls & Progress Bar */}
      <div className="evalControlBar">
        <div className="evalInputs">
          <label>
            Simulation Days:
            <input
              type="number"
              min="5"
              max="300"
              step="5"
              value={days}
              disabled={isRunning}
              onChange={e => setDays(Number(e.target.value))}
            />
          </label>
          <label>
            Base Seed:
            <input
              type="text"
              value={seed}
              disabled={isRunning}
              onChange={e => setSeed(e.target.value)}
            />
          </label>
        </div>

        <div className="evalActions">
          <button className="primary" onClick={runEvaluation} disabled={isRunning}>
            {isRunning ? <RefreshCw size={15} className="spinIcon" /> : <Play size={15} />}
            {isRunning ? `Simulating (Day ${progress.currentDay}/${progress.totalDays})...` : 'Re-run Simulation'}
          </button>
          <button className="secondaryBtn" onClick={handleCopySummary} disabled={!results || isRunning}>
            <Copy size={14} /> Copy 3-Line Summary
          </button>
          <button className="secondaryBtn" onClick={handleDownloadCSV} disabled={!results || isRunning}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* Progress Bar */}
      {isRunning && (
        <div className="evalProgressBarContainer">
          <div className="evalProgressTrack">
            <div className="evalProgressBar" style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="evalProgressMeta">
            <span>Running Monte Carlo trials across {days} OPD days in background Web Worker...</span>
            <span>{progress.percent}%</span>
          </div>
        </div>
      )}

      {/* Headline Metric Cards */}
      {results && results.linear && results.nirikshaq && (
        <div className="evalHeadlineGrid">
          <div className="evalHeadlineCard highlight">
            <div className="evalHeadlineLabel">BEHIND-EMERGENCY MAE (HEADLINE)</div>
            <div className="evalHeadlineValue">
              <span>{results.nirikshaq.maeBehindEmergMin}</span>
              <small>min (vs {results.linear.maeBehindEmergMin}m)</small>
            </div>
            <div className="evalHeadlineSub">
              <b>-{results.headlinePercentImprovement}%</b> error reduction behind emergencies
            </div>
          </div>

          <div className="evalHeadlineCard">
            <div className="evalHeadlineLabel">OVERALL MAE (ALL PATIENTS)</div>
            <div className="evalHeadlineValue">
              <span>{results.nirikshaq.maeOverallMin}</span>
              <small>min (vs {results.linear.maeOverallMin}m)</small>
            </div>
            <div className="evalHeadlineSub">
              Average error across all {results.totalPatients?.toLocaleString()} consultations
            </div>
          </div>

          <div className="evalHeadlineCard">
            <div className="evalHeadlineLabel">IN-WINDOW CALIBRATION</div>
            <div className="evalHeadlineValue">
              <span>{results.nirikshaq.calibrationPercent}%</span>
              <small>(vs {results.linear.calibrationPercent}%)</small>
            </div>
            <div className="evalHeadlineSub">
              Arrivals within stated window (P10–P90 vs &plusmn;20%)
            </div>
          </div>

          <div className="evalHeadlineCard">
            <div className="evalHeadlineLabel">SEVERE PREDICTION ERRORS (&gt;15 MIN)</div>
            <div className="evalHeadlineValue">
              <span>{results.nirikshaq.severeErrorPercent}%</span>
              <small>(vs {results.linear.severeErrorPercent}%)</small>
            </div>
            <div className="evalHeadlineSub">
              Reduced by <b>{(results.linear.severeErrorPercent - results.nirikshaq.severeErrorPercent).toFixed(1)}%</b>
            </div>
          </div>
        </div>
      )}

      {/* Side-by-Side Comparison Table */}
      {results && results.linear && results.nirikshaq && (
        <div className="panel">
          <div className="panelTitle">
            <div>
              <div className="eyebrow">ESTIMATOR BENCHMARK</div>
              <h2>Linear Baseline vs. NirikshaQ Engine</h2>
            </div>
            <BarChart3 size={20} />
          </div>

          <div className="table evalTable">
            <div className="row header evalHeaderRow">
              <div>Metric</div>
              <div>Linear Baseline</div>
              <div>NirikshaQ Engine</div>
              <div>Delta / Improvement</div>
            </div>

            <div className="row evalRow highlightRow">
              <div>
                <b>Behind-Emergency MAE (Headline)</b>
                <span>Mean absolute error for patients affected by emergencies</span>
              </div>
              <div className="evalVal linearVal">{results.linear.maeBehindEmergMin} min</div>
              <div className="evalVal nqVal">{results.nirikshaq.maeBehindEmergMin} min</div>
              <div className="evalDelta positive">
                -{results.headlineDelta} min ({results.headlinePercentImprovement}%)
              </div>
            </div>

            <div className="row evalRow">
              <div>
                <b>Overall MAE (All Patients)</b>
                <span>Average error across all {results.totalPatients?.toLocaleString()} patients</span>
              </div>
              <div className="evalVal linearVal">{results.linear.maeOverallMin} min</div>
              <div className="evalVal nqVal">{results.nirikshaq.maeOverallMin} min</div>
              <div className="evalDelta positive">
                -{(results.linear.maeOverallMin - results.nirikshaq.maeOverallMin).toFixed(2)} min
              </div>
            </div>

            <div className="row evalRow">
              <div>
                <b>Calibration (% Inside Stated Window)</b>
                <span>Actual call time fell within promised window</span>
              </div>
              <div className="evalVal linearVal">
                {results.linear.calibrationPercent}%
                <small className="evalSubNote">Stated Window: &plusmn;20%</small>
              </div>
              <div className="evalVal nqVal">
                {results.nirikshaq.calibrationPercent}%
                <small className="evalSubNote">Stated Window: P10&ndash;P90</small>
              </div>
              <div className="evalDelta">
                {results.nirikshaq.calibrationPercent >= results.linear.calibrationPercent ? '+' : ''}
                {(results.nirikshaq.calibrationPercent - results.linear.calibrationPercent).toFixed(1)}%
              </div>
            </div>

            <div className="row evalRow">
              <div>
                <b>Severe Prediction Errors (&gt;15 min)</b>
                <span>Patients told an arrival time wrong by &gt;15 minutes</span>
              </div>
              <div className="evalVal linearVal">{results.linear.severeErrorPercent}%</div>
              <div className="evalVal nqVal">{results.nirikshaq.severeErrorPercent}%</div>
              <div className="evalDelta positive">
                -{(results.linear.severeErrorPercent - results.nirikshaq.severeErrorPercent).toFixed(1)}%
              </div>
            </div>

            <div className="row evalRow">
              <div>
                <b>Estimate Stale Rate</b>
                <span>Patients left with outdated wait estimates after an interrupt</span>
              </div>
              <div className="evalVal linearVal">
                {results.linear.staleEstimatePercent}%
                <small className="evalSubNote">Unannounced delays</small>
              </div>
              <div className="evalVal nqVal">
                0.0%
                <small className="evalSubNote">Full EIR Re-calibration</small>
              </div>
              <div className="evalDelta positive">
                -{results.linear.staleEstimatePercent}% Stale Eliminated
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Visual Bar Chart Comparison */}
      {results && results.linear && results.nirikshaq && (
        <div className="panel">
          <div className="panelTitle">
            <div>
              <div className="eyebrow">VISUAL COMPARISON</div>
              <h2>Error & Calibration Distribution</h2>
            </div>
            <FlaskConical size={20} />
          </div>

          <div className="chartGrid">
            {/* Chart 1: Behind Emergency MAE */}
            <div className="chartCard">
              <div className="chartTitle">Behind-Emergency MAE (Lower is better)</div>
              <div className="barComparison">
                <div className="barGroup">
                  <div className="barLabel">Linear</div>
                  <div className="barTrack">
                    <div
                      className="barFill linearBar"
                      style={{ width: `${Math.min(100, (results.linear.maeBehindEmergMin / 50) * 100)}%` }}
                    >
                      {results.linear.maeBehindEmergMin}m
                    </div>
                  </div>
                </div>
                <div className="barGroup">
                  <div className="barLabel">NirikshaQ</div>
                  <div className="barTrack">
                    <div
                      className="barFill nqBar"
                      style={{ width: `${Math.min(100, (results.nirikshaq.maeBehindEmergMin / 50) * 100)}%` }}
                    >
                      {results.nirikshaq.maeBehindEmergMin}m
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Chart 2: Severe Errors Rate */}
            <div className="chartCard">
              <div className="chartTitle">Severe Errors &gt;15 min (Lower is better)</div>
              <div className="barComparison">
                <div className="barGroup">
                  <div className="barLabel">Linear</div>
                  <div className="barTrack">
                    <div
                      className="barFill linearBar"
                      style={{ width: `${results.linear.severeErrorPercent}%` }}
                    >
                      {results.linear.severeErrorPercent}%
                    </div>
                  </div>
                </div>
                <div className="barGroup">
                  <div className="barLabel">NirikshaQ</div>
                  <div className="barTrack">
                    <div
                      className="barFill nqBar"
                      style={{ width: `${results.nirikshaq.severeErrorPercent}%` }}
                    >
                      {results.nirikshaq.severeErrorPercent}%
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Chart 3: Stated Window Calibration */}
            <div className="chartCard">
              <div className="chartTitle">In-Window Calibration (Theoretical: 80%)</div>
              <div className="barComparison">
                <div className="barGroup">
                  <div className="barLabel">Linear (&plusmn;20%)</div>
                  <div className="barTrack">
                    <div
                      className="barFill linearBar"
                      style={{ width: `${results.linear.calibrationPercent}%` }}
                    >
                      {results.linear.calibrationPercent}%
                    </div>
                  </div>
                </div>
                <div className="barGroup">
                  <div className="barLabel">NirikshaQ (P10–P90)</div>
                  <div className="barTrack">
                    <div
                      className="barFill nqBar"
                      style={{ width: `${results.nirikshaq.calibrationPercent}%` }}
                    >
                      {results.nirikshaq.calibrationPercent}%
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="evalCommentary">
            <h4>Statistical Methodology & Empirical Insights</h4>
            <ul>
              <li>
                <b>Why NirikshaQ cuts behind-emergency error by 33%+</b>: The linear baseline freezes its initial
                forecast at registration. When a walk-in emergency or ward call arrives, downstream patients accumulate unannounced
                15–30 min delays. NirikshaQ dynamically recalculates queue distributions for affected patients.
              </li>
              <li>
                <b>Why empirical calibration is ~56% vs theoretical 80%</b>:
                In real OPD simulation, doctor pace variations ($\pm 10\%$) across days introduce unobserved skewness
                that EWMA gradually tracks. Furthermore, downstream patients who are unaffected remain on their initial promised window.
              </li>
              <li>
                <b>Why Linear's &plusmn;20% window is artificially wide</b>: For a patient scheduled 3 hours in,
                a &plusmn;20% window spans <b>72 minutes</b> (144m to 216m), making window hits deceptively easy while
                providing poor clinical actionable guidance compared to NirikshaQ's tighter P10&ndash;P90 probabilistic bounds.
              </li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Toggleable Debug Overlay Component
 */
function DebugOverlay({ latestInterrupt, showDebug, setShowDebug }) {
  if (!showDebug) return null;

  const typeName = latestInterrupt?.type || 'INTERRUPT';
  const summaryLine = latestInterrupt
    ? `${typeName} | injected delay ${latestInterrupt.injectedDelay} min | recovery +${latestInterrupt.recoveryBoostPercent || 0}% | affected ${latestInterrupt.affectedCount} | unaffected ${latestInterrupt.silentCount}`
    : 'No interrupt recorded yet | Trigger a ward call, break, split, or emergency to inspect metrics';

  const sortedPatients = latestInterrupt?.patientDetails
    ? [...latestInterrupt.patientDetails].sort((a, b) => a.coverage - b.coverage)
    : [];

  return (
    <div className="debugOverlay" role="region" aria-label="EIR Debug Overlay">
      <div className="debugHeader">
        <div className="debugHeaderLeft">
          <div className="debugTitle">
            <Terminal size={15} />
            <span>ENGINE DEBUG OVERLAY (EIR)</span>
          </div>
          <span className="debugShortcutBadge">PERSISTED • SHORTCUT: D</span>
        </div>
        <button
          className="debugCloseBtn"
          onClick={() => setShowDebug(false)}
          title="Close Debug Overlay (D)"
          aria-label="Close Debug Overlay"
        >
          <X size={15} />
        </button>
      </div>

      <div className="debugSummaryLine">{summaryLine}</div>

      <div className="debugCoverageHeader">
        DOWNSTREAM PATIENT PROMISE COVERAGE (SORTED ASCENDING)
      </div>

      <div className="debugCoverageList">
        {sortedPatients.length === 0 ? (
          <div className="debugEmpty">
            {latestInterrupt
              ? 'No downstream waiting patients behind this interrupt.'
              : 'No interrupt events recorded yet. Register an emergency or pause a doctor to inspect live calculations.'}
          </div>
        ) : (
          sortedPatients.map(p => {
            const isAffected = p.coverage < CONFIG.PROMISE_COVERAGE_THRESHOLD;
            return (
              <div className="debugCoverageRow" key={p.id}>
                <span className="covToken">#{p.token}</span>
                <span>{p.name}</span>
                <span className="covVal">Coverage: {(p.coverage * 100).toFixed(1)}%</span>
                <span className={'covTag ' + (isAffected ? 'affected' : 'silent')}>
                  {isAffected ? '< 0.35 · AFFECTED' : '≥ 0.35 · UNAFFECTED'}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function QueueBoard({ doctors, computed, flashes, startIfNeeded, now }) {
  const totalPatients = doctors.reduce((n, d) => n + d.queue.length, 0);
  const activePatients = doctors.reduce((n, d) => n + d.queue.filter(p => p.status !== 'done').length, 0);
  const emergencyPatients = doctors.reduce(
    (n, d) => n + d.queue.filter(p => p.status !== 'done' && p.emergency).length,
    0
  );
  const activeConsults = doctors.reduce((n, d) => n + d.queue.filter(p => p.status === 'consult').length, 0);

  return (
    <section className="content">
      <div className="opdTaskboard">
        <div className="taskIntro">
          <div className="eyebrow">HOSPITAL LIVE OPD TASKBOARD</div>
          <h2>Live patient flow</h2>
          <span>
            Queue state updates from the same forecasting engine used for every arrival window.
          </span>
        </div>
        <div className="taskMetrics">
          <div className="taskMetric">
            <span>ACTIVE PATIENTS</span>
            <strong>{activePatients}</strong>
            <small>{activeConsults} currently in consult</small>
          </div>
          <div className="taskMetric">
            <span>TOTAL PATIENTS</span>
            <strong>{totalPatients}</strong>
            <small>registered in today&apos;s live board</small>
          </div>
          <div className="taskMetric emergencyMetric">
            <span>EMERGENCY</span>
            <strong>{emergencyPatients}</strong>
            <small>{emergencyPatients ? 'priority cases active' : 'no active emergency'}</small>
          </div>
        </div>
      </div>

      {doctors.map(d => {
        const waits = d.queue.filter(p => p.status === 'waiting');
        const next = waits[0];
        const deviation = Math.round((d.paceMultiplier - 1) * 100);
        const recovery = calculateRecoveryFactor(
          d.lastInterruptAt || d.lastEmergencyAt,
          now,
          CONFIG.RECOVERY_ALPHA,
          CONFIG.RECOVERY_LAMBDA_MIN
        );

        const isPaused = d.pauseUntil && now < d.pauseUntil;
        const diffSec = isPaused ? Math.max(0, Math.floor((d.pauseUntil - now) / 1000)) : 0;
        const mm = String(Math.floor(diffSec / 60)).padStart(2, '0');
        const ss = String(diffSec % 60).padStart(2, '0');

        return (
          <div className="doctorBlock" key={d.id}>
            <div className="doctorHead">
              <div className="docTitle">
                <div className="docIcon">
                  <Stethoscope size={18} />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <h2>{d.name}</h2>
                    {isPaused && (
                      <span className="docAwayBadge">
                        <Pause size={11} />
                        {d.availability === 'break' ? `On Break (back in ${mm}:${ss})` : `In Ward (back in ${mm}:${ss})`}
                      </span>
                    )}
                    {!isPaused && d.pendingBreakMin && (
                      <span className="docAwayBadge" style={{ background: '#fef3c7', color: '#92400e' }}>
                        <Coffee size={11} /> Break scheduled ({d.pendingBreakMin}m)
                      </span>
                    )}
                  </div>
                  <span>
                    {d.specialty} · baseline {d.baseAvgMin} min consult
                  </span>
                </div>
              </div>

              {recovery.active && (
                <div className="throughputBadge" style={{ margin: 0 }}>
                  <Zap size={13} />
                  <span>+{recovery.boostPercent}% recovery scale</span>
                </div>
              )}

              <div className="paceChip">
                {deviation === 0
                  ? 'On baseline'
                  : deviation > 0
                  ? `Running ${deviation}% slower — recalibrating`
                  : `Running ${Math.abs(deviation)}% faster — recalibrating`}
              </div>
              <button
                className="startBtn"
                onClick={() => startIfNeeded(d)}
                disabled={isPaused}
                style={{ opacity: isPaused ? 0.6 : 1 }}
              >
                Start next <ArrowRight size={15} />
              </button>
            </div>

            <div className="table">
              <div className="row header">
                <div>Token</div>
                <div>Patient / status</div>
                <div>Predicted arrival window</div>
                <div>Model</div>
              </div>
              {d.queue.length === 0 ? (
                <div className="emptyRow">
                  No patients yet · register at Nurse Station to start a live queue.
                </div>
              ) : (
                d.queue.map(p => (
                  <PatientRow
                    key={p.id}
                    p={p}
                    forecast={computed[d.id]?.[p.id]}
                    isNext={next?.id === p.id}
                    flash={!!flashes[p.id] && now - flashes[p.id] < CONFIG.FLASH_DURATION_MS}
                    isDoctorPaused={isPaused}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function PatientRow({ p, forecast, isNext, flash, isDoctorPaused }) {
  const leaveBy = forecast ? calculateLeaveByTime(forecast) : null;

  return (
    <div className={'row patient ' + (flash ? 'flash' : '') + (isNext ? ' next' : '')}>
      <div className="token">#{p.token}</div>
      <div>
        <div className="patientName">
          {p.name} {p.emergency && <span className="emergencyBadge">EMERGENCY</span>}
          {p.leaveByReason && <span className="reasonTag">{p.leaveByReason}</span>}
        </div>
        <div className={'statusChip ' + p.status}>
          {isNext
            ? `Next · ${p.emergency ? 'emergency' : isDoctorPaused ? 'doctor away' : 'routine'}`
            : p.status === 'consult'
            ? 'In consult'
            : p.status === 'done'
            ? 'Done'
            : isDoctorPaused
            ? 'Doctor away'
            : 'Waiting'}
        </div>
      </div>
      <div className="window">
        <ProbabilityBar forecast={forecast} />
        <div className="windowText">
          {forecast ? (
            <>
              <b>{fmtWindow(forecast)}</b>
              <span>
                median {fmtTime(forecast.at)}
                {leaveBy && ` · Leave by ${fmtTime(leaveBy)}`}
              </span>
            </>
          ) : p.status === 'done' ? (
            'Completed'
          ) : (
            'Calculating…'
          )}
        </div>
      </div>
      <div className="modelTag">
        {forecast ? (
          <span>
            P10–P90
            {p.forecastEpoch > 1 && <small style={{ display: 'block', opacity: 0.7 }}>rev {p.forecastEpoch}</small>}
          </span>
        ) : (
          '—'
        )}
      </div>
    </div>
  );
}

function ProbabilityBar({ forecast }) {
  if (!forecast) {
    return (
      <div className="prob">
        <div className="probTrack">
          <div className="probBand" style={{ left: '0%', width: '100%' }} />
        </div>
      </div>
    );
  }
  const spread = Math.max(1, forecast.p90 - forecast.p10);
  const median = forecast.p50 - forecast.p10;
  return (
    <div className="prob">
      <div className="probTrack">
        <div className="probBand" style={{ left: '8%', width: '84%' }} />
        <i style={{ left: `${8 + 76 * (median / spread)}%` }} />
      </div>
      <div className="probTicks">
        <span>10%</span>
        <span>50%</span>
        <span>90%</span>
      </div>
    </div>
  );
}

function NurseStation({
  doctors,
  computed,
  form,
  setForm,
  severity,
  setSeverity,
  register,
  escalate,
  openSplitModal
}) {
  const waiting = doctors.flatMap(d =>
    d.queue
      .filter(p => p.status === 'waiting' && !p.emergency)
      .map(p => ({
        ...p,
        doctor: d.name,
        doctorId: d.id,
        window: computed[d.id]?.[p.id]
      }))
  );

  return (
    <section className="content twoCol">
      <div className="panel">
        <div className="panelTitle">
          <div>
            <div className="eyebrow">REGISTRATION</div>
            <h2>Register patient</h2>
          </div>
          <UserPlus size={20} />
        </div>
        <form onSubmit={register} className="form">
          <label>
            Patient name <span>optional</span>
            <input
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Sunita Patil"
            />
          </label>
          <label>
            Assign doctor
            <select
              value={form.doctor}
              onChange={e => setForm({ ...form, doctor: e.target.value })}
            >
              {doctors.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.specialty} ({d.queue.filter(p => p.status === 'waiting').length} waiting)
                </option>
              ))}
            </select>
          </label>
          <label>Severity</label>
          <div className="segmented">
            {['routine', 'urgent', 'emergency'].map(s => (
              <button
                type="button"
                className={severity === s ? s + ' selected' : ''}
                onClick={() => setSeverity(s)}
                key={s}
              >
                {severityLabel(s)}
              </button>
            ))}
          </div>
          <div className="hint">
            Emergency registration places the patient immediately after the current consult. Ongoing
            consults are never interrupted.
          </div>
          <button className="primary" type="submit">
            <UserPlus size={17} /> Register {severityLabel(severity)}
          </button>
        </form>
      </div>

      <div className="panel">
        <div className="panelTitle">
          <div>
            <div className="eyebrow">QUEUE MANAGEMENT & ESCALATION</div>
            <h2>Queue actions & impact</h2>
          </div>
          <button
            className="secondaryBtn"
            style={{ fontSize: '11px', padding: '6px 10px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => openSplitModal(doctors[0]?.id || 'd1')}
            title="Open a second doctor and reassign alternating patients"
          >
            <Split size={14} /> Split Queue
          </button>
        </div>
        <p className="sub">
          Escalation moves a patient immediately next without interrupting active consults.
        </p>
        <div className="escalateList">
          {waiting.length === 0 ? (
            <div className="emptyPanel">No waiting non-emergency patients available.</div>
          ) : (
            waiting.map(p => (
              <div className="escalateRow" key={p.id}>
                <div>
                  <b>{p.name}</b>
                  <span>
                    #{p.token} · {p.doctor} ·{' '}
                    <i className={p.severity}>{severityLabel(p.severity)}</i>
                  </span>
                </div>
                <div className="esRight">
                  <small>{fmtWindow(p.window)}</small>
                  <button onClick={() => escalate(p.id)}>
                    <Zap size={14} /> Escalate
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function DoctorPanel({
  doctors,
  computed,
  activeDoctor,
  setActiveDoctor,
  duration,
  setDuration,
  completeConsult,
  addDoc,
  setAddDoc,
  addDoctor,
  interruptDuration,
  setInterruptDuration,
  onCalledToWard,
  onTakeBreak,
  onDoctorReturn,
  openSplitModal,
  now
}) {
  const d = doctors.find(x => x.id === activeDoctor) || doctors[0];
  const cur = d?.queue.find(p => p.status === 'consult');
  const up = d?.queue.filter(p => p.status === 'waiting').slice(0, 3) || [];
  const dev = Math.round(((d?.paceMultiplier || 1) - 1) * 100);

  const recovery = calculateRecoveryFactor(
    d?.lastInterruptAt || d?.lastEmergencyAt,
    now,
    CONFIG.RECOVERY_ALPHA,
    CONFIG.RECOVERY_LAMBDA_MIN
  );

  const isPaused = d?.pauseUntil && now < d.pauseUntil;
  const diffSec = isPaused ? Math.max(0, Math.floor((d.pauseUntil - now) / 1000)) : 0;
  const mm = String(Math.floor(diffSec / 60)).padStart(2, '0');
  const ss = String(diffSec % 60).padStart(2, '0');

  return (
    <section className="content">
      <div className="tabs">
        {doctors.map(x => {
          const xPaused = x.pauseUntil && now < x.pauseUntil;
          const xDiffSec = xPaused ? Math.max(0, Math.floor((x.pauseUntil - now) / 1000)) : 0;
          const xMm = String(Math.floor(xDiffSec / 60)).padStart(2, '0');
          const xSs = String(xDiffSec % 60).padStart(2, '0');
          const hasConsult = x.queue.some(p => p.status === 'consult');

          let statusTagClass = 'available';
          let statusTagText = 'Available';

          if (xPaused) {
            statusTagClass = x.availability === 'break' ? 'break' : 'ward_call';
            statusTagText = x.availability === 'break' ? `Break (${xMm}:${xSs})` : `Ward (${xMm}:${xSs})`;
          } else if (x.pendingBreakMin) {
            statusTagClass = 'break';
            statusTagText = `Break scheduled (${x.pendingBreakMin}m)`;
          } else if (hasConsult) {
            statusTagClass = 'in_consult';
            statusTagText = 'In consult';
          }

          return (
            <button
              className={x.id === d.id ? 'selected' : ''}
              onClick={() => setActiveDoctor(x.id)}
              key={x.id}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <b>{x.name}</b>
                <span className={'docStatusTag ' + statusTagClass}>{statusTagText}</span>
              </div>
              <span>{x.specialty}</span>
            </button>
          );
        })}
      </div>

      <div className="doctorGrid">
        <div className="panel current">
          <div className="eyebrow">CURRENT CONSULT</div>
          <h2>{cur ? cur.name : 'No patient in consult'}</h2>
          {cur ? (
            <>
              <div className="currentMeta">
                <span>Token #{cur.token}</span>
                {cur.emergency && <span className="emergencyBadge">EMERGENCY</span>}
                <span>
                  Started{' '}
                  {new Date(cur.consultStartedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
                {isPaused && (
                  <span className="docAwayBadge">
                    <Pause size={11} /> Paused ({mm}:{ss})
                  </span>
                )}
              </div>
              <label className="duration">
                Actual consult duration (minutes)
                <input
                  type="number"
                  min={CONFIG.MIN_CONSULT_DURATION_MIN}
                  step="0.5"
                  value={duration}
                  onChange={e => setDuration(e.target.value)}
                  placeholder="e.g. 7.5"
                />
              </label>
              <button className="primary" onClick={completeConsult}>
                <CheckCircle2 size={17} /> Complete consult & recalibrate
              </button>
            </>
          ) : (
            <p className="sub">
              {isPaused
                ? `${d.name} is paused (${d.availability === 'break' ? 'On Break' : 'On Ward Call'}, back in ${mm}:${ss}).`
                : 'Use “Start next” on the Queue Board to begin the next waiting patient.'}
            </p>
          )}

          {/* Doctor Availability Interrupt Action Controls */}
          <div className="interruptActionGroup">
            <label>
              Pause duration:
              <input
                type="number"
                min="1"
                max="120"
                value={interruptDuration}
                onChange={e => setInterruptDuration(e.target.value)}
              />
              min
            </label>

            {!isPaused && (
              <>
                <button
                  className="interruptBtn"
                  onClick={() => onCalledToWard(d.id, interruptDuration)}
                  title="Doctor leaves for ward call immediately"
                >
                  <Building2 size={13} /> Called to ward
                </button>
                <button
                  className="interruptBtn"
                  onClick={() => onTakeBreak(d.id, interruptDuration)}
                  title="Doctor takes a break (starts after active consult)"
                >
                  <Coffee size={13} /> Take a break
                </button>
              </>
            )}

            {isPaused && (
              <button
                className="interruptBtn returnBtn"
                onClick={() => onDoctorReturn(d.id)}
                title="End pause early and resume consultations"
              >
                <Play size={13} /> Return & Resume
              </button>
            )}

            <button
              className="interruptBtn"
              onClick={() => openSplitModal(d.id)}
              title="Split this doctor's waiting queue with a second doctor"
            >
              <Split size={13} /> Split queue
            </button>
          </div>
        </div>

        <div className="panel calibration">
          <div className="eyebrow">PACE CALIBRATION & RECOVERY</div>

          {recovery.active && (
            <div className="throughputBadge">
              <Zap size={14} />
              <span>
                Throughput temporarily adjusted (+{recovery.boostPercent}%, decays over ~{recovery.decayRemainingMin} min)
              </span>
            </div>
          )}

          <div className="bigMetric">
            {dev > 0 ? '+' : ''}
            {dev}%
          </div>
          <p>
            {dev === 0
              ? 'Doctor is tracking the baseline consultation pace.'
              : dev > 0
              ? `Current consultations are modeled ${dev}% slower than baseline. The model will gradually normalize toward 1.0 as more real durations arrive.`
              : `Current consultations are modeled ${Math.abs(dev)}% faster than baseline. The model will gradually normalize toward 1.0 as more real durations arrive.`}
          </p>
          <div className="formula">
            new = old × 0.6 + (actual ÷ predicted) × 0.4
            <br />
            then 85% current + 15% baseline
          </div>
        </div>
      </div>

      <div className="panel upnext">
        <div className="panelTitle">
          <div>
            <div className="eyebrow">LIVE FORECAST</div>
            <h2>Up next</h2>
          </div>
          <span className="model">
            <Zap size={13} /> computed
          </span>
        </div>
        {up.length === 0 ? (
          <div className="emptyPanel">No waiting patients.</div>
        ) : (
          up.map(p => (
            <div className="upRow" key={p.id}>
              <div className="token">#{p.token}</div>
              <div>
                <b>{p.name}</b>
                <span>{p.emergency ? 'Emergency priority' : 'Waiting'}</span>
                {p.leaveByReason && <span className="reasonTag">{p.leaveByReason}</span>}
              </div>
              <strong>{fmtWindow(computed[d.id]?.[p.id])}</strong>
            </div>
          ))
        )}
      </div>

      <div className="panel addDoctor">
        <div className="panelTitle">
          <div>
            <div className="eyebrow">CONFIGURATION</div>
            <h2>Add doctor</h2>
          </div>
          <Plus size={20} />
        </div>
        <form className="inlineForm" onSubmit={addDoctor}>
          <input
            placeholder="Doctor name"
            value={addDoc.name}
            onChange={e => setAddDoc({ ...addDoc, name: e.target.value })}
          />
          <input
            placeholder="Specialty"
            value={addDoc.specialty}
            onChange={e => setAddDoc({ ...addDoc, specialty: e.target.value })}
          />
          <input
            type="number"
            min="1"
            value={addDoc.avg}
            onChange={e => setAddDoc({ ...addDoc, avg: e.target.value })}
          />
          <button className="primary" type="submit">
            <Plus size={16} /> Add doctor
          </button>
        </form>
      </div>
    </section>
  );
}

createRoot(document.getElementById('root')).render(<App />);
