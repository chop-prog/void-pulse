// localStorage wrapper that never throws (private mode, blocked storage, quota).

const PREFIX = 'void-pulse:';

export const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* storage unavailable — progress just isn't persisted */
    }
  },
};
