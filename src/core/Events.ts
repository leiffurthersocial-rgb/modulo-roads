/** Minimal typed event emitter. */
export class Emitter<T extends Record<string, unknown>> {
  private map = new Map<keyof T, Set<(v: never) => void>>();

  on<K extends keyof T>(type: K, fn: (v: T[K]) => void): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(fn as (v: never) => void);
    return () => set!.delete(fn as (v: never) => void);
  }

  emit<K extends keyof T>(type: K, value: T[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of set) (fn as (v: T[K]) => void)(value);
  }
}
