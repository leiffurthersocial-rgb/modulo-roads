/**
 * Procedural audio with the Web Audio API – no samples.
 *
 *  engine   : firing-frequency oscillators + sub + intake noise, soft-clipped
 *             and low-passed; pitch follows rpm, brightness follows throttle
 *  tyres    : filtered noise whose colour changes with the surface; gravel
 *             adds crackle, slides add a squeal
 *  wind     : speed² rumble plus ambient gusts
 *  bridges  : low hum and expansion-joint thumps; tunnels: convolution reverb
 *  ambience : rain, thunder, birds, crickets, cowbells, lapping water, trains
 *  ui       : soft clicks
 * Buses map to the settings sliders (master/engine/ambient/music/ui).
 */
import { clamp } from '../core/math';
import { Radio } from './Radio';

export interface AudioFrame {
  rpm: number;
  maxRpm: number;
  idleRpm: number;
  throttle: number;
  speed: number; // m/s abs
  slip: number;
  surface: string;
  inTunnel: number; // 0..1
  onBridge: boolean;
  wind: number; // 0..1 strength setting
  rain: number; // 0..1
  snow: boolean;
  night: number;
  birds: number;
  cowbells: number;
  crickets: number;
  water: number;
  trainDist: number;
  shift: boolean;
  engine: { base: number; harm: number; growl: number; cylinders: number };
  boost: boolean;
  dt: number;
  cameraInside: boolean;
}

function makeNoise(ctx: BaseAudioContext, seconds: number, pink: boolean): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (!pink) {
      d[i] = w;
      continue;
    }
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

function makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 40 ? i / 40 : 1);
    }
  }
  return buf;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: { engine: GainNode; ambient: GainNode; music: GainNode; ui: GainNode };
  private comp!: DynamicsCompressorNode;
  private noise!: AudioBuffer;
  private pink!: AudioBuffer;
  // engine
  private eOsc: OscillatorNode[] = [];
  private eGain!: GainNode;
  private eFilter!: GainNode | BiquadFilterNode;
  private eShaper!: WaveShaperNode;
  private eNoiseGain!: GainNode;
  private eNoiseFilt!: BiquadFilterNode;
  private eAm!: GainNode;
  private eAmOsc!: OscillatorNode;
  // tyres, wind, etc.
  private rollGain!: GainNode;
  private rollFilt!: BiquadFilterNode;
  private crunchGain!: GainNode;
  private squealGain!: GainNode;
  private squealOsc!: OscillatorNode;
  private windGain!: GainNode;
  private windFilt!: BiquadFilterNode;
  private gustGain!: GainNode;
  private humGain!: GainNode;
  private humOsc!: OscillatorNode;
  private rainGain!: GainNode;
  private waterGain!: GainNode;
  private trainGain!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private dry!: GainNode;
  private interiorFilt!: BiquadFilterNode;
  readonly radio: Radio;
  private vol = { master: 0.8, engine: 0.7, ambient: 0.7, music: 0.5, ui: 0.5, muted: false };
  private nextBird = 2;
  private nextBell = 3;
  private nextCricket = 0;
  private jointDist = 0;
  private gustT = 0;
  lowPower = false;
  private started = false;

  constructor() {
    this.radio = new Radio(this);
  }

  /** Create/resume the context. Must be called from a user gesture on iOS. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'playback' });
      this.build();
    }
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get musicBus(): GainNode | null {
    return this.ctx ? this.buses.music : null;
  }
  get reverbInput(): AudioNode | null {
    return this.ctx ? this.reverb : null;
  }

  setVolumes(v: { master: number; engine: number; ambient: number; music: number; ui: number; muted: boolean }): void {
    this.vol = { ...v };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(v.muted ? 0 : v.master, t, 0.08);
    this.buses.engine.gain.setTargetAtTime(v.engine, t, 0.08);
    this.buses.ambient.gain.setTargetAtTime(v.ambient, t, 0.08);
    this.buses.music.gain.setTargetAtTime(v.music * 0.8, t, 0.08);
    this.buses.ui.gain.setTargetAtTime(v.ui, t, 0.05);
  }

  private build(): void {
    const ctx = this.ctx!;
    this.noise = makeNoise(ctx, 3, false);
    this.pink = makeNoise(ctx, 4, true);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 3;
    this.master = ctx.createGain();
    this.master.connect(this.comp).connect(ctx.destination);
    const bus = () => {
      const g = ctx.createGain();
      g.connect(this.master);
      return g;
    };
    this.buses = { engine: bus(), ambient: bus(), music: bus(), ui: bus() };
    // reverb (tunnels + music)
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 2.6, 2.8);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.9;
    this.reverb.connect(revOut).connect(this.master);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0;
    this.reverbSend.connect(this.reverb);
    // vehicle sounds go through a filter that muffles them in the cockpit
    this.interiorFilt = ctx.createBiquadFilter();
    this.interiorFilt.type = 'lowpass';
    this.interiorFilt.frequency.value = 18000;
    this.dry = ctx.createGain();
    this.dry.connect(this.interiorFilt).connect(this.buses.engine);
    this.dry.connect(this.reverbSend);

    // ---- engine
    this.eShaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    this.eShaper.curve = curve;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 800;
    filt.Q.value = 1.2;
    this.eFilter = filt;
    this.eGain = ctx.createGain();
    this.eGain.gain.value = 0;
    this.eAm = ctx.createGain();
    this.eAm.gain.value = 1;
    const mix = ctx.createGain();
    mix.gain.value = 0.35;
    const types: OscillatorType[] = ['sawtooth', 'square', 'sawtooth', 'triangle'];
    const levels = [0.5, 0.35, 0.18, 0.4];
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      o.type = types[i];
      const g = ctx.createGain();
      g.gain.value = levels[i];
      o.connect(g).connect(mix);
      o.start();
      this.eOsc.push(o);
    }
    mix.connect(this.eShaper).connect(filt).connect(this.eAm).connect(this.eGain).connect(this.dry);
    // growl: amplitude modulation at half firing frequency
    this.eAmOsc = ctx.createOscillator();
    this.eAmOsc.type = 'sine';
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.25;
    this.eAmOsc.connect(amDepth).connect(this.eAm.gain);
    this.eAmOsc.start();
    // intake/exhaust rasp
    const n = this.loopNoise(this.noise);
    this.eNoiseFilt = ctx.createBiquadFilter();
    this.eNoiseFilt.type = 'bandpass';
    this.eNoiseFilt.Q.value = 1.4;
    this.eNoiseGain = ctx.createGain();
    this.eNoiseGain.gain.value = 0;
    n.connect(this.eNoiseFilt).connect(this.eNoiseGain).connect(this.dry);

    // ---- tyres
    const roll = this.loopNoise(this.pink);
    this.rollFilt = ctx.createBiquadFilter();
    this.rollFilt.type = 'bandpass';
    this.rollFilt.frequency.value = 600;
    this.rollFilt.Q.value = 0.7;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    roll.connect(this.rollFilt).connect(this.rollGain).connect(this.dry);
    // gravel crunch: white noise high-passed, amplitude-modulated by slow noise
    const cr = this.loopNoise(this.noise);
    const crf = ctx.createBiquadFilter();
    crf.type = 'highpass';
    crf.frequency.value = 2200;
    const crMod = ctx.createGain();
    crMod.gain.value = 0;
    const modSrc = this.loopNoise(this.noise, 0.012);
    const modAmt = ctx.createGain();
    modAmt.gain.value = 1.4;
    modSrc.connect(modAmt).connect(crMod.gain);
    this.crunchGain = ctx.createGain();
    this.crunchGain.gain.value = 0;
    cr.connect(crf).connect(crMod).connect(this.crunchGain).connect(this.dry);
    // squeal
    const sq = this.loopNoise(this.noise);
    const sqf = ctx.createBiquadFilter();
    sqf.type = 'bandpass';
    sqf.frequency.value = 1900;
    sqf.Q.value = 9;
    this.squealOsc = ctx.createOscillator();
    this.squealOsc.frequency.value = 1150;
    const sqo = ctx.createGain();
    sqo.gain.value = 0.05;
    this.squealOsc.connect(sqo);
    this.squealOsc.start();
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    sq.connect(sqf).connect(this.squealGain);
    sqo.connect(this.squealGain);
    this.squealGain.connect(this.dry);

    // ---- wind
    const wn = this.loopNoise(this.pink);
    this.windFilt = ctx.createBiquadFilter();
    this.windFilt.type = 'lowpass';
    this.windFilt.frequency.value = 300;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wn.connect(this.windFilt).connect(this.windGain).connect(this.buses.ambient);
    const gn = this.loopNoise(this.pink, 0.7);
    const gf = ctx.createBiquadFilter();
    gf.type = 'bandpass';
    gf.frequency.value = 500;
    gf.Q.value = 0.5;
    this.gustGain = ctx.createGain();
    this.gustGain.gain.value = 0;
    gn.connect(gf).connect(this.gustGain).connect(this.buses.ambient);

    // ---- bridge hum
    this.humOsc = ctx.createOscillator();
    this.humOsc.type = 'triangle';
    this.humOsc.frequency.value = 62;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    this.humOsc.connect(this.humGain).connect(this.dry);
    this.humOsc.start();

    // ---- rain & water
    const rn = this.loopNoise(this.noise);
    const rf = ctx.createBiquadFilter();
    rf.type = 'highpass';
    rf.frequency.value = 900;
    const rf2 = ctx.createBiquadFilter();
    rf2.type = 'lowpass';
    rf2.frequency.value = 7000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rn.connect(rf).connect(rf2).connect(this.rainGain).connect(this.buses.ambient);
    const wa = this.loopNoise(this.pink, 0.5);
    const waf = ctx.createBiquadFilter();
    waf.type = 'lowpass';
    waf.frequency.value = 420;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    wa.connect(waf).connect(this.waterGain).connect(this.buses.ambient);
    // ---- train rumble
    const tn = this.loopNoise(this.pink, 0.6);
    const tf = ctx.createBiquadFilter();
    tf.type = 'lowpass';
    tf.frequency.value = 260;
    this.trainGain = ctx.createGain();
    this.trainGain.gain.value = 0;
    tn.connect(tf).connect(this.trainGain).connect(this.buses.ambient);

    this.setVolumes(this.vol);
    this.started = true;
  }

  private loopNoise(buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.loopStart = Math.random() * (buf.duration - 0.5);
    src.start(0, Math.random() * buf.duration);
    return src;
  }

  /** Per-frame update of all continuous sounds. */
  update(f: AudioFrame): void {
    if (!this.ctx || !this.started || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const tc = 0.05;
    // ---- engine
    const e = f.engine;
    const fire = (f.rpm / 60) * (e.cylinders / 2) * e.base;
    const base = clamp(fire, 18, 900);
    this.eOsc[0].frequency.setTargetAtTime(base, t, tc);
    this.eOsc[1].frequency.setTargetAtTime(base * 0.5, t, tc);
    this.eOsc[2].frequency.setTargetAtTime(base * 2.01, t, tc);
    this.eOsc[3].frequency.setTargetAtTime(base * (1 + e.harm), t, tc);
    this.eAmOsc.frequency.setTargetAtTime(base * 0.5, t, tc);
    const load = f.shift ? 0.15 : f.throttle;
    const rpm01 = clamp((f.rpm - f.idleRpm) / (f.maxRpm - f.idleRpm), 0, 1);
    (this.eFilter as BiquadFilterNode).frequency.setTargetAtTime(260 + load * 1600 + rpm01 * 1400 + (f.boost ? 600 : 0), t, tc);
    this.eGain.gain.setTargetAtTime(0.16 + load * 0.2 + rpm01 * 0.1, t, tc);
    this.eNoiseFilt.frequency.setTargetAtTime(base * 3.5, t, tc);
    this.eNoiseGain.gain.setTargetAtTime((0.02 + load * 0.08 * (0.5 + e.growl)) * (0.4 + rpm01), t, tc);

    // ---- tyres per surface
    const sp = f.speed;
    const sp01 = clamp(sp / 40, 0, 1);
    let rollF = 650;
    let rollQ = 0.7;
    let rollV = 0.12 * sp01;
    let crunch = 0;
    switch (f.surface) {
      case 'gravel':
        rollF = 1800;
        rollQ = 0.5;
        rollV = 0.12 * sp01;
        crunch = 0.32 * Math.min(1, sp / 12);
        break;
      case 'grass':
        rollF = 380;
        rollQ = 0.4;
        rollV = 0.18 * Math.min(1, sp / 15);
        crunch = 0.05 * Math.min(1, sp / 10);
        break;
      case 'bridge':
        rollF = 520;
        rollV = 0.14 * sp01;
        break;
      case 'tunnel':
        rollF = 700;
        rollV = 0.16 * sp01;
        break;
    }
    this.rollFilt.frequency.setTargetAtTime(rollF + sp * 8, t, 0.1);
    this.rollFilt.Q.setTargetAtTime(rollQ, t, 0.1);
    this.rollGain.gain.setTargetAtTime(rollV, t, 0.08);
    this.crunchGain.gain.setTargetAtTime(crunch, t, 0.08);
    const asphalt = f.surface !== 'grass' && f.surface !== 'gravel' && f.surface !== 'water';
    const squeal = asphalt ? clamp((f.slip - 1.8) / 5, 0, 1) * Math.min(1, sp / 8) : 0;
    this.squealGain.gain.setTargetAtTime(squeal * 0.22, t, 0.05);
    this.squealOsc.frequency.setTargetAtTime(1050 + Math.sin(t * 13) * 40 + f.slip * 15, t, 0.05);

    // ---- wind
    const tun = f.inTunnel;
    this.windFilt.frequency.setTargetAtTime(180 + sp * 22, t, 0.2);
    this.windGain.gain.setTargetAtTime(clamp(sp01 * sp01 * 0.5, 0, 0.5) * (1 - tun * 0.6) * (f.cameraInside ? 0.5 : 1), t, 0.2);
    this.gustT += f.dt;
    const gust = (0.5 + 0.5 * Math.sin(this.gustT * 0.33) * Math.sin(this.gustT * 0.71 + 1)) * f.wind;
    this.gustGain.gain.setTargetAtTime(gust * 0.18 * (1 - tun), t, 0.4);

    // ---- bridge hum & joints
    this.humGain.gain.setTargetAtTime(f.onBridge ? 0.05 + sp01 * 0.08 : 0, t, 0.15);
    this.humOsc.frequency.setTargetAtTime(48 + sp * 1.4, t, 0.2);
    if (f.onBridge) {
      this.jointDist += sp * f.dt;
      if (this.jointDist > 24) {
        this.jointDist = 0;
        this.thump(0.25 * Math.min(1, sp / 15));
      }
    }
    // ---- tunnel reverb + cockpit muffling
    this.reverbSend.gain.setTargetAtTime(this.lowPower ? 0 : tun * 0.55, t, 0.25);
    this.interiorFilt.frequency.setTargetAtTime(f.cameraInside ? 2400 : 18000, t, 0.2);

    // ---- ambience
    this.rainGain.gain.setTargetAtTime(f.rain * (f.snow ? 0.04 : 0.28) * (1 - tun * 0.85), t, 0.5);
    this.waterGain.gain.setTargetAtTime(f.water * 0.12 * (1 - tun), t, 0.8);
    const tr = clamp(1 - f.trainDist / 300, 0, 1);
    this.trainGain.gain.setTargetAtTime(tr * tr * 0.5, t, 0.2);

    if (!this.lowPower || Math.random() < 0.5) {
      const day = 1 - f.night;
      this.nextBird -= f.dt;
      if (this.nextBird <= 0) {
        this.nextBird = 1.5 + Math.random() * 6 / Math.max(0.15, f.birds);
        if (f.birds > 0.05 && day > 0.4 && f.rain < 0.3 && tun < 0.1) this.birdCall(f.birds * day);
      }
      this.nextBell -= f.dt;
      if (this.nextBell <= 0) {
        this.nextBell = 0.4 + Math.random() * 2.5;
        if (f.cowbells > 0.05 && day > 0.3 && tun < 0.1 && Math.random() < f.cowbells * 0.5) this.cowbell(f.cowbells);
      }
      this.nextCricket -= f.dt;
      if (this.nextCricket <= 0) {
        this.nextCricket = 0.15 + Math.random() * 0.4;
        if (f.crickets > 0.05 && f.night > 0.5 && f.rain < 0.2 && tun < 0.1) this.cricket(f.crickets * f.night);
      }
    }
  }

  // ---- one-shots -----------------------------------------------------------
  private env(g: GainNode, t: number, a: number, peak: number, d: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private thump(v: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = ctx.createGain();
    this.env(g, t, 0.005, v, 0.14);
    o.connect(g).connect(this.dry);
    o.start(t);
    o.stop(t + 0.2);
  }

  private birdCall(v: number): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + 0.05;
    const notes = 2 + Math.floor(Math.random() * 5);
    const base = 2200 + Math.random() * 2200;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.buses.ambient);
    for (let i = 0; i < notes; i++) {
      const t = t0 + i * (0.09 + Math.random() * 0.08);
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f1 = base * (0.85 + Math.random() * 0.4);
      o.frequency.setValueAtTime(f1, t);
      o.frequency.exponentialRampToValueAtTime(f1 * (Math.random() < 0.5 ? 1.35 : 0.7), t + 0.07);
      const g = ctx.createGain();
      this.env(g, t, 0.01, 0.03 * v, 0.08);
      o.connect(g).connect(pan);
      o.start(t);
      o.stop(t + 0.12);
    }
  }

  private cowbell(v: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.02;
    const f = 520 + Math.random() * 380;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const mg = ctx.createGain();
    mod.frequency.value = f * 1.41;
    mg.gain.value = f * 1.6;
    mod.connect(mg).connect(car.frequency);
    car.frequency.value = f;
    const g = ctx.createGain();
    this.env(g, t, 0.004, 0.035 * v, 0.9);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    car.connect(g).connect(pan).connect(this.buses.ambient);
    car.start(t);
    mod.start(t);
    car.stop(t + 1);
    mod.stop(t + 1);
  }

  private cricket(v: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.02;
    const o = ctx.createOscillator();
    o.frequency.value = 4200 + Math.random() * 700;
    const g = ctx.createGain();
    const pulses = 3;
    g.gain.setValueAtTime(0, t);
    for (let i = 0; i < pulses; i++) {
      g.gain.setValueAtTime(0.012 * v, t + i * 0.035);
      g.gain.setValueAtTime(0, t + i * 0.035 + 0.018);
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.8 - 0.9;
    o.connect(g).connect(pan).connect(this.buses.ambient);
    o.start(t);
    o.stop(t + pulses * 0.035 + 0.02);
  }

  thunder(delay: number, strength: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.pink;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(600, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * strength, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.3 * strength, t + 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.8);
    src.connect(f).connect(g).connect(this.buses.ambient);
    src.start(t);
    src.stop(t + 4);
  }

  /** Soft UI sounds. */
  ui(kind: 'click' | 'tick' | 'open' | 'close' | 'toggle'): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    const g = ctx.createGain();
    const map = { click: [1320, 0.05, 0.06], tick: [2100, 0.02, 0.02], open: [660, 0.05, 0.18], close: [520, 0.05, 0.16], toggle: [990, 0.05, 0.08] } as const;
    const [freq, vol, dur] = map[kind];
    o.frequency.setValueAtTime(freq, t);
    if (kind === 'open') o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur);
    if (kind === 'close') o.frequency.exponentialRampToValueAtTime(freq * 0.66, t + dur);
    this.env(g, t, 0.004, vol, dur);
    o.connect(g).connect(this.buses.ui);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}
