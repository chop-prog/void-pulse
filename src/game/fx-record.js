// Effect recording for co-op. The host simulates the world; the guest only renders snapshots.
// Explosions, sparks, sounds and warps are not part of the snapshot, so on the host every
// call to selected effect methods is also appended to `sink.list`, and the guest replays the
// same calls on its own particle system, grid and audio engine.

/**
 * Wrap `target` so calls to `methods` are recorded while `sink.active` is true. Everything
 * else passes straight through (methods are bound to the real object, so hot loops inside
 * them never go through the proxy). `proxy.raw` is the unwrapped target for local-only effects.
 */
export function recordable(target, methods, tag, sink) {
  const wrapped = Object.create(null);
  for (const m of methods) {
    wrapped[m] = (...args) => {
      if (sink.active) sink.list.push([tag, m, ...args]);
      return target[m](...args);
    };
  }
  const bound = new Map();
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'raw') return t;
      if (prop in wrapped) return wrapped[prop];
      const v = t[prop];
      if (typeof v !== 'function') return v;
      let b = bound.get(prop);
      if (!b) bound.set(prop, (b = v.bind(t)));
      return b;
    },
    set(t, prop, v) {
      t[prop] = v;
      return true;
    },
  });
}
