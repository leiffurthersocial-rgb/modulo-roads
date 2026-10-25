/**
 * Procedural radio. Two stations, both generated live with Web Audio:
 *
 *  "Radio Lucerne Lo-Fi" – swung 74–82 bpm beats, jazzy 7th/9th chord
 *     progressions on a soft electric-piano voice, round bass, vinyl crackle
 *     and the occasional pentatonic melody.
 *  "Alpenglühn Ambient" – slow evolving pads in modal keys, alphorn calls
 *     on the natural harmonic series, distant bell plinks and cowbells.
 *
 * Notes are scheduled ~0.2 s ahead with a look-ahead timer so timing stays
 * tight even when frames are slow. Nothing here is sampled or copyrighted.
 */
import type { AudioEngine } from './AudioEngine';
import { RNG } from '../core/rng';

type Station = 'off' | 'lofi' | 'alpine';

const LOFI_TITLES = ['Seeufer', 'Nebelmeer', 'Föhn', 'Rösti Sunday', 'Late Tram', 'Limmat Lights', 'Kaffee Crème', 'Rainy Gotthard', 'Pilatus Dusk', 'Brienz Blue'];
const ALPINE_TITLES = ['Alpenglühn', 'Gletscherwind', 'Morgentau', 'Bergsee', 'Arvenwald', 'Silser Licht', 'Hohe Wiese', 'Edelweiss', 'Sternenpass', 'Wolkenmeer'];

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Radio {
  station: Station = 'off';
  title = '';
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private rng = new RNG(Date.now() & 0xffffffff);
  private out: GainNode | null = null;
  private wet: GainNode | null = null;
  private crackle: AudioBufferSourceNode | null = null;
  private chordIdx = 0;
  private key = 0;
  private bpm = 78;
  private prog: number[][] = [];
  private padVoices: { osc: OscillatorNode[]; gain: GainNode }[] = [];
  onTitle: ((title: string, station: Station) => void) | null = null;

  constructor(private engine: AudioEngine) {}

  setStation(st: Station): void {
    if (st === this.station) return;
    this.stop();
    this.station = st;
    if (st !== 'off') this.start();
  }

  private get ctx(): AudioContext | null {
    return this.engine.ctx;
  }

  /** Called when the audio context becomes available. */
  ensureRunning(): void {
    if (this.station !== 'off' && this.timer === null) this.start();
  }

  private start(): void {
    const ctx = this.ctx;
    const bus = this.engine.musicBus;
    if (!ctx || !bus) return;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(1, ctx.currentTime, 1.2);
    this.out.connect(bus);
    // music reverb send
    this.wet = ctx.createGain();
    this.wet.gain.value = this.station === 'alpine' ? 0.55 : 0.18;
    const rv = this.engine.reverbInput;
    if (rv && !this.engine.lowPower) this.out.connect(this.wet).connect(rv);
    this.nextTime = ctx.currentTime + 0.1;
    this.step = 0;
    this.bar = 0;
    this.newSong();
    if (this.station === 'lofi') this.startCrackle();
    this.timer = window.setInterval(() => this.schedule(), 40);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const ctx = this.ctx;
    if (ctx && this.out) {
      const o = this.out;
      o.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
      setTimeout(() => o.disconnect(), 1500);
    }
    if (this.crackle) {
      try {
        this.crackle.stop();
      } catch {
        /* already stopped */
      }
      this.crackle = null;
    }
    for (const v of this.padVoices) for (const o of v.osc) o.stop(ctx ? ctx.currentTime + 2 : 0);
    this.padVoices = [];
    this.out = null;
  }

  private newSong(): void {
    const r = this.rng;
    if (this.station === 'lofi') {
      this.bpm = r.int(72, 84);
      this.key = r.int(0, 11);
      const progs = [
        [[2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11], [9, 12, 16, 19]], // ii V I vi (with 7ths)
        [[0, 4, 7, 11], [9, 12, 16, 19], [5, 9, 12, 16], [7, 11, 14, 17]], // I vi IV V
        [[5, 9, 12, 16], [4, 7, 11, 14], [2, 5, 9, 12], [0, 4, 7, 14]], // IV iii ii I(add9)
        [[9, 12, 16, 19], [5, 9, 12, 16], [0, 4, 7, 11], [7, 11, 14, 17]], // vi IV I V
      ];
      this.prog = r.pick(progs);
      this.title = r.pick(LOFI_TITLES);
    } else {
      this.bpm = 60;
      this.key = r.pick([2, 5, 7, 9, 10]);
      const progs = [
        [[0, 7, 14, 16], [5, 12, 16, 19], [9, 16, 19, 23], [7, 14, 18, 21]],
        [[0, 7, 11, 16], [2, 9, 14, 17], [5, 12, 16, 21], [0, 7, 14, 19]],
        [[0, 4, 7, 14], [-3, 4, 9, 12], [5, 9, 12, 16], [7, 11, 14, 19]],
      ];
      this.prog = r.pick(progs);
      this.title = r.pick(ALPINE_TITLES);
    }
    this.chordIdx = 0;
    this.onTitle?.(this.title, this.station);
  }

  private startCrackle(): void {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * 0.012;
      if (Math.random() < 0.0004) d[i] = (Math.random() * 2 - 1) * 0.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2500;
    f.Q.value = 0.4;
    const g = ctx.createGain();
    g.gain.value = 0.5;
    src.connect(f).connect(g).connect(this.out!);
    src.start();
    this.crackle = src;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== 'running') return;
    const ahead = 0.25;
    while (this.nextTime < ctx.currentTime + ahead) {
      if (this.station === 'lofi') this.lofiStep(this.nextTime);
      else this.alpineStep(this.nextTime);
      const sixteenth = 60 / this.bpm / 4;
      // swing: long-short pairs
      const swing = this.station === 'lofi' ? (this.step % 2 === 0 ? 1.18 : 0.82) : 1;
      this.nextTime += sixteenth * swing;
      this.step++;
      if (this.step % 16 === 0) {
        this.bar++;
        this.chordIdx = (this.chordIdx + 1) % this.prog.length;
        if (this.bar % 32 === 0) this.newSong();
      }
    }
  }

  // --------------------------------------------------------------- lo-fi
  private lofiStep(t: number): void {
    const s = this.step % 16;
    const r = this.rng;
    const lowPower = this.engine.lowPower;
    // drums
    if (s === 0 || s === 10 || (s === 7 && r.chance(0.3))) this.kick(t, s === 0 ? 0.9 : 0.6);
    if (s === 4 || s === 12) this.snare(t, 0.35);
    if (s % 2 === 0 && !(lowPower && s % 4 === 2)) this.hat(t, s % 4 === 0 ? 0.06 : 0.035);
    // chords on the 1 (and a push on the "and" of 2 sometimes)
    const chord = this.prog[this.chordIdx];
    const root = 48 + this.key;
    if (s === 0 || (s === 6 && r.chance(0.35))) {
      for (let i = 0; i < chord.length; i++) this.keys(t + i * 0.012, mtof(root + 12 + chord[i]), s === 0 ? 1.9 : 0.9, 0.05);
    }
    // bass
    if (s === 0 || s === 8 || (s === 14 && r.chance(0.5))) this.bass(t, mtof(root - 12 + chord[0] + (s === 14 ? 7 : 0)), 0.5);
    // melody
    if (!lowPower && s % 2 === 0 && r.chance(this.bar % 4 < 2 ? 0.16 : 0.06)) {
      const penta = [0, 2, 4, 7, 9, 12, 14, 16];
      this.lead(t, mtof(root + 24 + r.pick(penta)), 0.35);
    }
  }

  private kick(t: number, v: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(v * 0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(this.out!);
    o.start(t);
    o.stop(t + 0.4);
  }

  private noiseBurst(t: number, dur: number, type: BiquadFilterType, freq: number, v: number): void {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.out!);
    src.start(t);
  }

  private snare(t: number, v: number): void {
    this.noiseBurst(t, 0.18, 'bandpass', 1800, v * 0.6);
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(v * 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(this.out!);
    o.start(t);
    o.stop(t + 0.15);
  }

  private hat(t: number, v: number): void {
    this.noiseBurst(t, 0.05, 'highpass', 7000, v);
  }

  /** Soft electric-piano: sine + quiet FM bell overtone, gentle tremolo. */
  private keys(t: number, f: number, dur: number, v: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = f * 2.001;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * 1;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * 0.9, t);
    mg.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.4);
    mod.connect(mg).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(v * 0.4, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.15;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1900;
    o.connect(g);
    o2.connect(g2).connect(g);
    g.connect(lp).connect(this.out!);
    for (const n of [o, o2, mod]) {
      n.start(t);
      n.stop(t + dur + 0.05);
    }
  }

  private bass(t: number, f: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    o.connect(lp).connect(g).connect(this.out!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private lead(t: number, f: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5;
    const vg = ctx.createGain();
    vg.gain.value = f * 0.006;
    vib.connect(vg).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.045, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out!);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 0.05);
    vib.stop(t + dur + 0.05);
  }

  // --------------------------------------------------------------- alpine
  private alpineStep(t: number): void {
    const s = this.step % 16;
    const r = this.rng;
    const chord = this.prog[this.chordIdx];
    const root = 38 + this.key;
    // new pad every bar (4 s at 60 bpm), long crossfades
    if (s === 0) this.pad(t, chord.map((c) => mtof(root + 12 + c)), 9);
    // bell plinks
    if (!this.engine.lowPower && s % 4 === 2 && r.chance(0.18)) {
      const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19];
      this.bell(t, mtof(root + 36 + r.pick(scale)), 0.03);
    }
    // alphorn calls every few bars
    if (s === 0 && this.bar % 4 === 1 && r.chance(0.6)) this.alphorn(t, mtof(root - 2));
    // distant cowbell
    if (s === 8 && r.chance(0.15)) this.bell(t + r.range(0, 0.3), r.range(560, 820), 0.012, 1.41);
  }

  private pad(t: number, freqs: number[], dur: number): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 2.5);
    g.gain.setValueAtTime(0.05, t + dur - 3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1300, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(600, t + dur);
    lp.connect(g).connect(this.out!);
    const oscs: OscillatorNode[] = [];
    const voices = this.engine.lowPower ? 1 : 2;
    for (const f of freqs) {
      for (let v = 0; v < voices; v++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f * (v === 0 ? 0.997 : 1.004);
        const og = ctx.createGain();
        og.gain.value = 0.25;
        o.connect(og).connect(lp);
        o.start(t);
        o.stop(t + dur + 0.1);
        oscs.push(o);
      }
    }
  }

  private bell(t: number, f: number, v: number, ratio = 3.5): void {
    const ctx = this.ctx!;
    const car = ctx.createOscillator();
    car.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * ratio;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * 2, t);
    mg.gain.exponentialRampToValueAtTime(f * 0.1, t + 1.5);
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rng.range(-0.7, 0.7);
    car.connect(g).connect(pan).connect(this.out!);
    car.start(t);
    mod.start(t);
    car.stop(t + 2.6);
    mod.stop(t + 2.6);
  }

  /** Alphorn: harmonic-series melody with breathy attack and slow vibrato. */
  private alphorn(t: number, fundamental: number): void {
    const ctx = this.ctx!;
    const partials = [4, 5, 6, 8, 6, 5, 6, 4, 3, 4];
    const len = this.rng.int(3, 6);
    const start = this.rng.int(0, partials.length - len);
    let tt = t;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rng.range(-0.5, 0.5);
    lp.connect(pan).connect(this.out!);
    for (let i = 0; i < len; i++) {
      const p = partials[start + i];
      const d = this.rng.pick([0.9, 1.2, 1.8, 2.4]);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fundamental * p;
      const vib = ctx.createOscillator();
      vib.frequency.value = 4.5;
      const vg = ctx.createGain();
      vg.gain.setValueAtTime(0, tt);
      vg.gain.linearRampToValueAtTime(fundamental * p * 0.008, tt + d * 0.7);
      vib.connect(vg).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.06, tt + 0.18);
      g.gain.setValueAtTime(0.055, tt + d - 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + d + 0.3);
      o.connect(g).connect(lp);
      o.start(tt);
      vib.start(tt);
      o.stop(tt + d + 0.4);
      vib.stop(tt + d + 0.4);
      tt += d;
    }
  }
}
