/**
 * Uniform-grid spatial hash for broad-phase collision queries.
 *
 * Objects are any `{ x, y, r }`. The hash is rebuilt every tick (clear + insert),
 * which is cheaper than incremental updates for hundreds of fast-moving entities.
 * Cell arrays are pooled so steady-state rebuilding allocates nothing.
 */
export class SpatialHash {
  constructor(cellSize = 64) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
    this.cells = new Map();
    this.pool = [];
    this.stamp = 0;
  }

  static key(cx, cy) {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  clear() {
    for (const cell of this.cells.values()) {
      cell.length = 0;
      this.pool.push(cell);
    }
    this.cells.clear();
  }

  insert(obj) {
    const inv = this.inv;
    const x0 = Math.floor((obj.x - obj.r) * inv);
    const x1 = Math.floor((obj.x + obj.r) * inv);
    const y0 = Math.floor((obj.y - obj.r) * inv);
    const y1 = Math.floor((obj.y + obj.r) * inv);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = SpatialHash.key(cx, cy);
        let cell = this.cells.get(k);
        if (!cell) {
          cell = this.pool.pop() || [];
          this.cells.set(k, cell);
        }
        cell.push(obj);
      }
    }
  }

  /**
   * Collects every object whose cell overlaps the query circle's bounding box.
   * Results are de-duplicated via a per-query stamp. Narrow-phase is up to the caller.
   */
  query(x, y, r, out = []) {
    const stamp = ++this.stamp;
    const inv = this.inv;
    const x0 = Math.floor((x - r) * inv);
    const x1 = Math.floor((x + r) * inv);
    const y0 = Math.floor((y - r) * inv);
    const y1 = Math.floor((y + r) * inv);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(SpatialHash.key(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const o = cell[i];
          if (o._qs !== stamp) {
            o._qs = stamp;
            out.push(o);
          }
        }
      }
    }
    return out;
  }

  get cellCount() {
    return this.cells.size;
  }
}
