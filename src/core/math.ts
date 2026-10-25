/** Small scalar helpers. Kept allocation-free so they can be used per vertex. */

export const TAU = Math.PI * 2;

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function invLerp(a: number, b: number, v: number): number {
  return clamp01((v - a) / (b - a));
}
export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
/** Frame-rate independent exponential smoothing factor. */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}
/** Move `current` towards `target` with exponential damping. */
export function dampTo(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}
export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  return current + wrapAngle(target - current) * (1 - Math.exp(-rate * dt));
}
export function sign(v: number): number {
  return v < 0 ? -1 : 1;
}

/**
 * Critically damped spring (Game Programming Gems 4) – used for camera and
 * suspension so motion settles softly without overshoot.
 * Mutates and returns state [value, velocity].
 */
export function springStep(state: Float32Array | number[], target: number, omega: number, dt: number): void {
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = state[0] - target;
  const temp = (state[1] + omega * change) * dt;
  state[1] = (state[1] - omega * temp) * exp;
  state[0] = target + (change + temp) * exp;
}

/** Format seconds as h:mm:ss or m:ss. */
export function formatDuration(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}
