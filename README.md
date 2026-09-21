# NirikshaQ

A fully client-side React + Vite prototype for live government hospital OPD queue forecasting.

## Run
```bash
npm install
npm run dev
```

## Algorithm implemented
- Gamma(shape=4, scale=(baseAvgMin * paceMultiplier)/4) consultation model.
- Marsaglia–Tsang Gamma sampler using Box–Muller normal sampling.
- 1,200 Monte Carlo trials per doctor's waiting queue.
- P10/P50/P90 arrival windows with a probability band + median marker.
- Emergency insertion immediately after the current consult; only the affected doctor's forecast is recalculated.
- Recalculated downstream patients receive simulated SMS messages and row flash feedback.
- Pace calibration: `old*0.6 + (actual/predicted)*0.4`, followed by 85% current + 15% baseline normalization.
- Doctor completion immediately starts the next patient and re-forecasts.
- Local light/dark preference persists in localStorage.

All state is React state; there are no external APIs or backend dependencies.
