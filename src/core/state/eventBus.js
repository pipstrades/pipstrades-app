/**
 * Minimal pub/sub event bus.
 * Bots subscribe to events here instead of touching the WebSocket directly —
 * this is what lets multiple bots share one connection safely.
 */

const listeners = new Map(); // eventName -> Set of callbacks

/**
 * Subscribe to an event. Returns an unsubscribe function.
 * @param {string} eventName
 * @param {(payload: any) => void} callback
 * @returns {() => void}
 */
export function on(eventName, callback) {
  if (!listeners.has(eventName)) {
    listeners.set(eventName, new Set());
  }
  listeners.get(eventName).add(callback);

  return () => off(eventName, callback);
}

/**
 * Unsubscribe a specific callback from an event.
 */
export function off(eventName, callback) {
  listeners.get(eventName)?.delete(callback);
}

/**
 * Emit an event to all subscribers.
 * @param {string} eventName
 * @param {any} payload
 */
export function emit(eventName, payload) {
  listeners.get(eventName)?.forEach((callback) => {
    try {
      callback(payload);
    } catch (err) {
      console.error(`Error in listener for "${eventName}":`, err);
    }
  });
}

/**
 * Remove all listeners for an event, or every listener if no name is given.
 * Useful when tearing down a bot session.
 */
export function clear(eventName) {
  if (eventName) {
    listeners.delete(eventName);
  } else {
    listeners.clear();
  }
}
