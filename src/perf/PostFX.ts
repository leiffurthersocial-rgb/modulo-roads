/**
 * Post-processing chain: (DOF) → bloom → tone-map/sRGB → colour grade,
 * vignette, film grain and photo filters → FXAA. When nothing is enabled the
 * renderer draws straight to the screen and this costs nothing.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

export type PhotoFilter = 'none' | 'vivid' | 'film' | 'mono' | 'warm' | 'cool' | 'vintage' | 'dream';
export const PHOTO_FILTERS: PhotoFilter[] = ['none', 'vivid', 'film', 'mono', 'warm', 'cool', 'vintage', 'dream'];

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.0 },
    uGrain: { value: 0.0 },
    uGrade: { value: 1.0 },
    uSat: { value: 1.08 },
    uContrast: { value: 1.04 },
    uWarm: { value: 0.0 },
    uLift: { value: new THREE.Vector3(0.01, 0.012, 0.02) },
    uMono: { value: 0 },
    uFade: { value: 0 },
    uFlash: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uGrade, uSat, uContrast, uWarm, uMono, uFade, uFlash;
    uniform vec3 uLift;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;
      if ( uGrade > 0.5 ) {
        float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
        c = mix( vec3( l ), c, uSat );
        c = ( c - 0.5 ) * uContrast + 0.5;
        c += uLift * ( 1.0 - l );
        c *= vec3( 1.0 + uWarm * 0.08, 1.0 + uWarm * 0.02, 1.0 - uWarm * 0.08 );
        // gentle split-tone: warm highlights, cool shadows
        c = mix( c, c * vec3( 0.96, 0.99, 1.06 ), ( 1.0 - l ) * 0.25 );
      }
      if ( uMono > 0.0 ) {
        float l = dot( c, vec3( 0.299, 0.587, 0.114 ) );
        c = mix( c, vec3( l ), uMono );
      }
      if ( uFade > 0.0 ) c = mix( c, vec3( 0.55, 0.52, 0.48 ) + c * 0.45, uFade );
      if ( uVignette > 0.0 ) {
        vec2 d = vUv - 0.5;
        d.x *= uRes.x / uRes.y;
        float v = smoothstep( 0.85, 0.25, length( d ) );
        c *= mix( 1.0, v, uVignette );
      }
      if ( uGrain > 0.0 ) {
        float n = hash( vUv * uRes + fract( uTime ) * 100.0 ) - 0.5;
        c += n * uGrain;
      }
      c = mix( c, vec3( 1.0 ), uFlash );
      gl_FragColor = vec4( clamp( c, 0.0, 1.0 ), 1.0 );
    }`,
};

export interface PostOptions {
  bloom: boolean;
  dof: boolean;
  grade: boolean;
  vignette: boolean;
  grain: boolean;
  fxaa: boolean;
  msaa: boolean;
}

export class PostFX {
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private bokeh: BokehPass | null = null;
  private grade: ShaderPass | null = null;
  private fxaa: ShaderPass | null = null;
  private opts: PostOptions = { bloom: false, dof: false, grade: false, vignette: false, grain: false, fxaa: false, msaa: false };
  enabled = false;
  filter: PhotoFilter = 'none';
  /** White fade used for the car-reset transition (0..1). */
  flash = 0;
  focus = 10;
  private photoDof = false;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {}

  configure(o: PostOptions, photoDof = false): void {
    const same = JSON.stringify(o) === JSON.stringify(this.opts) && photoDof === this.photoDof;
    if (same && (this.composer || !this.wantComposer(o, photoDof))) return;
    this.opts = { ...o };
    this.photoDof = photoDof;
    this.dispose();
    this.enabled = this.wantComposer(o, photoDof);
    if (!this.enabled) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: o.msaa ? 4 : 0 });
    const comp = new EffectComposer(this.renderer, rt);
    comp.setPixelRatio(1);
    comp.setSize(size.x, size.y);
    this.renderPass = new RenderPass(this.scene, this.camera);
    comp.addPass(this.renderPass);
    if (o.dof || photoDof) {
      this.bokeh = new BokehPass(this.scene, this.camera, { focus: 10, aperture: 0.0009, maxblur: 0.006 });
      comp.addPass(this.bokeh);
    }
    if (o.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.55, 0.86);
      comp.addPass(this.bloom);
    }
    comp.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    comp.addPass(this.grade);
    if (o.fxaa) {
      this.fxaa = new ShaderPass(FXAAShader);
      this.fxaa.material.uniforms['resolution'].value.set(1 / size.x, 1 / size.y);
      comp.addPass(this.fxaa);
    }
    this.composer = comp;
  }

  private wantComposer(o: PostOptions, photoDof: boolean): boolean {
    return o.bloom || o.dof || o.grade || o.vignette || o.grain || o.fxaa || photoDof || this.filter !== 'none' || this.flash > 0;
  }

  setSize(w: number, h: number): void {
    if (!this.composer) return;
    this.composer.setSize(w, h);
    if (this.fxaa) this.fxaa.material.uniforms['resolution'].value.set(1 / w, 1 / h);
    if (this.bloom) this.bloom.resolution.set(w / 2, h / 2);
  }

  render(dt: number, time: number, warmth: number): void {
    if (!this.composer) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    const g = this.grade!.material.uniforms;
    g.uTime.value = time;
    g.uVignette.value = this.opts.vignette ? 0.42 : 0;
    g.uGrain.value = this.opts.grain ? 0.035 : 0;
    g.uGrade.value = this.opts.grade || this.filter !== 'none' ? 1 : 0;
    g.uWarm.value = warmth;
    g.uSat.value = 1.08;
    g.uContrast.value = 1.04;
    g.uMono.value = 0;
    g.uFade.value = 0;
    g.uFlash.value = this.flash;
    const size = this.renderer.getDrawingBufferSize(TMP_V2);
    g.uRes.value.copy(size);
    switch (this.filter) {
      case 'vivid':
        g.uSat.value = 1.35;
        g.uContrast.value = 1.12;
        break;
      case 'film':
        g.uSat.value = 0.92;
        g.uContrast.value = 1.08;
        g.uWarm.value = warmth + 0.4;
        g.uGrain.value = 0.06;
        g.uFade.value = 0.12;
        g.uVignette.value = 0.55;
        break;
      case 'mono':
        g.uMono.value = 1;
        g.uContrast.value = 1.18;
        g.uGrain.value = 0.05;
        break;
      case 'warm':
        g.uWarm.value = warmth + 1.2;
        break;
      case 'cool':
        g.uWarm.value = warmth - 1.2;
        g.uSat.value = 0.95;
        break;
      case 'vintage':
        g.uSat.value = 0.7;
        g.uWarm.value = warmth + 0.9;
        g.uFade.value = 0.28;
        g.uVignette.value = 0.7;
        g.uGrain.value = 0.07;
        break;
      case 'dream':
        g.uSat.value = 1.15;
        g.uFade.value = 0.18;
        g.uWarm.value = warmth + 0.5;
        if (this.bloom) this.bloom.strength = 0.9;
        break;
    }
    if (this.bloom && this.filter !== 'dream') this.bloom.strength = 0.32;
    if (this.bokeh) {
      const u = this.bokeh.uniforms as Record<string, THREE.IUniform>;
      u['focus'].value = this.focus;
      u['nearClip'].value = this.camera.near;
      u['farClip'].value = this.camera.far;
      u['aspect'].value = this.camera.aspect;
    }
    this.composer.render(dt);
  }

  dispose(): void {
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      for (const p of this.composer.passes) (p as unknown as { dispose?: () => void }).dispose?.();
    }
    this.composer = null;
    this.bloom = null;
    this.bokeh = null;
    this.grade = null;
    this.fxaa = null;
    this.renderPass = null;
  }
}

const TMP_V2 = new THREE.Vector2();
