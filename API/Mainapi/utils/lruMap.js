'use strict';

/**
 * LruMap — bounded Map with LRU eviction.
 *
 * Drop-in replacement for `new Map()` when entries hold expensive resources
 * (socket pools, large JSON, etc.) that would otherwise accumulate forever.
 *
 * Iteration order is insertion-order with LRU-touch on `get()`: the most
 * recently used entry is at the tail, the least recent at the head.
 *
 * @param {number}   options.max       Max entries before eviction. Required.
 * @param {Function} [options.onEvict] Optional `(value, key) => void` callback
 *                                     fired on eviction, explicit `delete()`,
 *                                     and `clear()`. Use it to call
 *                                     `agent.destroy()` and similar cleanup.
 */
class LruMap {
  constructor({ max, onEvict } = {}) {
    if (!Number.isInteger(max) || max <= 0) {
      throw new TypeError('LruMap: `max` must be a positive integer');
    }
    this.max = max;
    this.onEvict = typeof onEvict === 'function' ? onEvict : null;
    this._map = new Map();
  }

  has(key) {
    return this._map.has(key);
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this.max) {
      const oldestKey = this._map.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestValue = this._map.get(oldestKey);
        this._map.delete(oldestKey);
        this._invokeEvict(oldestValue, oldestKey);
      }
    }
    this._map.set(key, value);
    return this;
  }

  delete(key) {
    if (!this._map.has(key)) return false;
    const value = this._map.get(key);
    this._map.delete(key);
    this._invokeEvict(value, key);
    return true;
  }

  clear() {
    if (this.onEvict) {
      for (const [key, value] of this._map) {
        this._invokeEvict(value, key);
      }
    }
    this._map.clear();
  }

  get size() {
    return this._map.size;
  }

  keys() {
    return this._map.keys();
  }

  values() {
    return this._map.values();
  }

  entries() {
    return this._map.entries();
  }

  forEach(callback, thisArg) {
    this._map.forEach(callback, thisArg);
  }

  [Symbol.iterator]() {
    return this._map[Symbol.iterator]();
  }

  _invokeEvict(value, key) {
    if (!this.onEvict) return;
    try {
      this.onEvict(value, key);
    } catch (_) {
      // Eviction callbacks must never throw out of the map.
    }
  }
}

module.exports = { LruMap };
