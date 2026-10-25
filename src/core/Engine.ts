/**
 * Renderer + main loop.
 *
 * - requestAnimationFrame loop with an optional FPS cap (30 in Low Battery
 *   Mode) implemented by skipping vsync ticks, so frames stay evenly paced
 * - fixed-timestep simulation callbacks (handled by Game via `onFrame`)
 * - pauses entirely (no rAF, audio suspended) while the tab is hidden
 * - handles resize, orientation changes and the iPad visual viewport
 */
import * as THREE from 'three';

export interface FrameInfo {
  dt: number; // seconds since last rendered frame (clamped)
  time: number; // seconds since start
  frameMs: number; // CPU time of the previous frame's work
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  fpsCap = 60;
  onFrame: ((f: FrameInfo) => void) | null = null;
  onResize: ((w: number, h: number) => void) | null = null;
  onVisibility: ((visible: boolean) => void) | null = null;
  private raf = 0;
  private running = false;
  private last = 0;
  private lastTick = 0;
  private start = performance.now();
  private workMs = 0;
  // fps counter
  fps = 0;
  private fpsFrames = 0;
  private fpsT = 0;
  pixelRatio = 1;
  readonly msaa: boolean;

  constructor(canvas: HTMLCanvasElement, msaa: boolean) {
    this.canvas = canvas;
    this.msaa = msaa;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: msaa,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x9fc4e0, 1);
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.3, 3000);
    this.camera.layers.enable(1);
    this.scene.add(this.camera);
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    window.visualViewport?.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.pause();
        this.onVisibility?.(false);
      } else {
        this.resume();
        this.onVisibility?.(true);
      }
    });
    this.resize();
  }

  setPixelRatio(pr: number): void {
    const v = Math.max(0.4, Math.min(3, pr));
    if (Math.abs(v - this.pixelRatio) < 0.01) return;
    this.pixelRatio = v;
    this.renderer.setPixelRatio(v);
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.onResize?.(size.x, size.y);
  }

  run(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.lastTick = this.last;
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resume(): void {
    if (!this.running) this.run();
  }

  get time(): number {
    return (performance.now() - this.start) / 1000;
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    // FPS cap: only render when enough time has passed (with 2 ms slack so a
    // 30 fps cap on a 60 Hz display lands on every second vsync).
    if (this.fpsCap > 0) {
      const interval = 1000 / this.fpsCap;
      if (now - this.lastTick < interval - 2) return;
      this.lastTick = now;
    }
    const dt = Math.min(0.1, Math.max(0.0005, (now - this.last) / 1000));
    this.last = now;
    const t0 = performance.now();
    this.onFrame?.({ dt, time: (now - this.start) / 1000, frameMs: this.workMs });
    this.workMs = performance.now() - t0;
    this.fpsFrames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = this.fpsFrames / this.fpsT;
      this.fpsFrames = 0;
      this.fpsT = 0;
    }
  };
}
