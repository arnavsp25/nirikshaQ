/**
 * Lightweight Promise-based wrapper for IndexedDB event storage in NirikshaQ.
 * Zero external dependencies. Works in all modern browsers.
 */

const DB_NAME = 'nirikshaq_db';
const DB_VERSION = 1;
const STORE_NAME = 'events';

let dbInstance = null;

/**
 * Open or retrieve cached IndexedDB instance
 */
export function openDatabase() {
  if (typeof indexedDB === 'undefined') {
    // Non-browser or SSR / test fallback
    return Promise.resolve(null);
  }

  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'seq' });
        store.createIndex('id', 'id', { unique: true });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = event => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = event => {
      console.error('Failed to open IndexedDB:', event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Append an immutable event to IndexedDB
 * @param {Object} event { id, seq, timestamp, type, payload }
 */
export async function appendEvent(event) {
  const db = await openDatabase();
  if (!db) return event;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.add(event);

    request.onsuccess = () => resolve(event);
    request.onerror = e => {
      console.error('Failed to append event to IndexedDB:', e.target.error);
      reject(e.target.error);
    };
  });
}

/**
 * Retrieve all events from IndexedDB ordered by sequence number (seq)
 * @returns {Promise<Array<Object>>}
 */
export async function getAllEvents() {
  const db = await openDatabase();
  if (!db) return [];

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const results = request.result || [];
      // Ensure sorted by sequence number
      results.sort((a, b) => a.seq - b.seq);
      resolve(results);
    };

    request.onerror = e => {
      console.error('Failed to get events from IndexedDB:', e.target.error);
      reject(e.target.error);
    };
  });
}

/**
 * Clear all events from IndexedDB (for demo reset or import)
 */
export async function clearAllEvents() {
  const db = await openDatabase();
  if (!db) return;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = e => {
      console.error('Failed to clear IndexedDB store:', e.target.error);
      reject(e.target.error);
    };
  });
}

/**
 * Batch import an array of events into IndexedDB
 * @param {Array<Object>} events
 */
export async function importEvents(events) {
  const db = await openDatabase();
  if (!db) return;

  await clearAllEvents();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    transaction.oncomplete = () => resolve();
    transaction.onerror = e => reject(e.target.error);

    events.forEach(event => {
      store.add(event);
    });
  });
}
