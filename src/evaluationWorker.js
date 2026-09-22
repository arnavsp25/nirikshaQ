/**
 * Web Worker for running multi-day synthetic OPD benchmark asynchronously
 * keeps UI thread 100% responsive during intensive Monte Carlo simulations.
 */

import { runOPDEvaluation } from './evaluator.js';

self.onmessage = async function (e) {
  const { type, days = 30, seed = 'opd-eval-seed-42' } = e.data || {};

  if (type === 'START') {
    try {
      const results = await runOPDEvaluation({
        days,
        seed,
        onProgress: (currentDay, totalDays, intermediate) => {
          self.postMessage({
            type: 'PROGRESS',
            currentDay,
            totalDays,
            progressPercent: Math.round((currentDay / totalDays) * 100),
            intermediate
          });
        }
      });

      self.postMessage({
        type: 'DONE',
        results
      });
    } catch (err) {
      self.postMessage({
        type: 'ERROR',
        error: err.message || String(err)
      });
    }
  }
};
