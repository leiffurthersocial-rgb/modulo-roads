/**
 * Lake water: one large plane following the camera at WATER_LEVEL.
 * Animated normals, Fresnel, sun glitter, and either a cheap sky-gradient
 * reflection or a real planar reflection (half-res mirror render, adapted
 * from three's Reflector with an oblique clip plane).
 */
import * as THREE from 'three';
import { Shared } from './Materials';
import { WATER_LEVEL } from './TerrainField';

const vert = /* glsl */ `
uniform mat4 uTexMatrix;
varying vec4 vReflUv;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec3 transformed = position;
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vReflUv = uTexMatrix * wp;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const frag = /* glsl */ `
uniform sampler2D uRefl;
uniform float uUseRefl;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uTime;
uniform vec2 uOrigin;
uniform float uWind;
uniform float uRain;
varying vec4 vReflUv;
varying vec3 vWorld;
#include <fog_pars_fragment>

vec2 wave( vec2 p, vec2 dir, float freq, float speed, float amp ) {
  float ph = dot( p, dir ) * freq + uTime * speed;
  return dir * cos( ph ) * amp * freq;
}

void main() {
  vec2 p = vWorld.xz - uOrigin;
  float a = 0.35 + uWind * 0.8;
  vec2 g = vec2( 0.0 );
  g += wave( p, normalize( vec2( 1.0, 0.3 ) ), 0.11, 1.1, 0.35 * a );
  g += wave( p, normalize( vec2( -0.4, 1.0 ) ), 0.23, 1.7, 0.16 * a );
  g += wave( p, normalize( vec2( 0.7, -0.7 ) ), 0.61, 2.6, 0.05 * a );
  g += wave( p, normalize( vec2( -0.9, -0.2 ) ), 1.37, 3.9, 0.018 * a );
  g += wave( p, normalize( vec2( 0.2, 0.95 ) ), 2.9, 5.1, 0.007 * ( a + uRain * 2.0 ) );
  vec3 n = normalize( vec3( -g.x, 1.0, -g.y ) );
  vec3 V = cameraPosition - vWorld;
  float dist = length( V );
  V /= dist;
  // soften normals with distance to avoid shimmer
  n = normalize( mix( n, vec3( 0.0, 1.0, 0.0 ), smoothstep( 80.0, 900.0, dist ) * 0.7 ) );
  float cosT = max( dot( n, V ), 0.0 );
  float fres = 0.02 + 0.98 * pow( 1.0 - cosT, 5.0 );
  vec3 R = reflect( -V, n );
  vec3 skyR = mix( uHorizon, uZenith, pow( clamp( R.y, 0.0, 1.0 ), 0.5 ) );
  vec3 refl = skyR;
  if ( uUseRefl > 0.5 ) {
    vec4 uv = vReflUv;
    uv.xy += n.xz * 6.0;
    vec3 mirror = texture2DProj( uRefl, uv ).rgb;
    refl = mirror;
  }
  vec3 body = mix( uShallow, uDeep, clamp( 1.0 - cosT, 0.0, 1.0 ) );
  vec3 col = mix( body, refl, clamp( fres * 1.15, 0.0, 1.0 ) );
  float spec = pow( max( dot( R, uSunDir ), 0.0 ), 260.0 ) * 6.0 + pow( max( dot( R, uSunDir ), 0.0 ), 32.0 ) * 0.25;
  col += uSunColor * spec * smoothstep( -0.05, 0.1, uSunDir.y );
  gl_FragColor = vec4( col, 1.0 );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Water {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  private rt: THREE.WebGLRenderTarget | null = null;
  private mirrorCam = new THREE.PerspectiveCamera();
  private reflections = false;
  private texMatrix = new THREE.Matrix4();
  private rendering = false;
  resolution = 0.5;

  constructor() {
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uRefl: { value: null },
        uUseRefl: { value: 0 },
        uTexMatrix: { value: new THREE.Matrix4() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uZenith: { value: new THREE.Color(0x3d7bd0) },
        uHorizon: { value: new THREE.Color(0xcfe3f2) },
        uDeep: { value: new THREE.Color(0x0f3f52) },
        uShallow: { value: new THREE.Color(0x2a7a86) },
        uOrigin: { value: new THREE.Vector2() },
        uWind: { value: 0.3 },
        uRain: { value: 0 },
      },
    ]);
    // shared uniforms by reference
    this.uniforms.uTime = Shared.uTime;
    this.uniforms.uFogParams = Shared.uFogParams;
    this.uniforms.uFogSunColor = Shared.uFogSunColor;
    this.uniforms.uFogSunDir = Shared.uFogSunDir;
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms, fog: true });
    const geo = new THREE.CircleGeometry(1, 64);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1e6 - 10; // after terrain so early-z rejects hidden water
    this.mesh.onBeforeRender = (renderer, scene, camera) => this.renderMirror(renderer, scene, camera as THREE.PerspectiveCamera);
  }

  setReflections(on: boolean): void {
    this.reflections = on;
    this.uniforms.uUseRefl.value = on ? 1 : 0;
    if (!on && this.rt) {
      this.rt.dispose();
      this.rt = null;
      this.uniforms.uRefl.value = null;
    }
  }

  follow(camera: THREE.PerspectiveCamera): void {
    const r = camera.far * 0.9;
    this.mesh.position.set(camera.position.x, WATER_LEVEL, camera.position.z);
    this.mesh.scale.set(r, 1, r);
    const o = this.uniforms.uOrigin.value as THREE.Vector2;
    o.set(Math.floor(camera.position.x / 2048) * 2048, Math.floor(camera.position.z / 2048) * 2048);
  }

  private renderMirror(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    if (!this.reflections || this.rendering || camera === this.mirrorCam) return;
    if (camera.position.y < WATER_LEVEL) return;
    const size = renderer.getDrawingBufferSize(TMP_V2);
    const w = Math.max(64, Math.floor(size.x * this.resolution));
    const h = Math.max(64, Math.floor(size.y * this.resolution));
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 0 });
      this.uniforms.uRefl.value = this.rt.texture;
    } else if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);

    // --- mirror camera (plane y = WATER_LEVEL, normal +Y) ---
    const mc = this.mirrorCam;
    const normal = TMP_N.set(0, 1, 0);
    const planePos = TMP_P.set(camera.position.x, WATER_LEVEL, camera.position.z);
    const view = TMP_VIEW.setFromMatrixPosition(camera.matrixWorld);
    view.y = 2 * WATER_LEVEL - view.y;
    const target = TMP_T.set(0, 0, -1).applyMatrix4(TMP_ROT.extractRotation(camera.matrixWorld)).add(TMP_CP.setFromMatrixPosition(camera.matrixWorld));
    target.y = 2 * WATER_LEVEL - target.y;
    mc.position.copy(view);
    mc.up.set(0, 1, 0).applyMatrix4(TMP_ROT);
    mc.up.reflect(normal);
    mc.lookAt(target);
    mc.far = camera.far;
    mc.near = camera.near;
    mc.fov = camera.fov;
    mc.aspect = camera.aspect;
    mc.updateMatrixWorld();
    mc.projectionMatrix.copy(camera.projectionMatrix);
    mc.layers.set(0);

    // texture matrix
    this.texMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.texMatrix.multiply(mc.projectionMatrix);
    this.texMatrix.multiply(mc.matrixWorldInverse);
    (this.uniforms.uTexMatrix.value as THREE.Matrix4).copy(this.texMatrix);

    // oblique near plane clipping (Eric Lengyel)
    const plane = TMP_PLANE.setFromNormalAndCoplanarPoint(normal, planePos);
    plane.applyMatrix4(mc.matrixWorldInverse);
    const clip = TMP_V4.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = mc.projectionMatrix;
    const q = TMP_Q4;
    q.x = (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    clip.multiplyScalar(2.0 / clip.dot(q));
    pm.elements[2] = clip.x;
    pm.elements[6] = clip.y;
    pm.elements[10] = clip.z + 1.0 - 0.0;
    pm.elements[14] = clip.w;

    this.rendering = true;
    this.mesh.visible = false;
    const prevRT = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.rt);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, mc);
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevRT);
    this.mesh.visible = true;
    this.rendering = false;
  }
}

const TMP_V2 = new THREE.Vector2();
const TMP_N = new THREE.Vector3();
const TMP_P = new THREE.Vector3();
const TMP_VIEW = new THREE.Vector3();
const TMP_T = new THREE.Vector3();
const TMP_CP = new THREE.Vector3();
const TMP_ROT = new THREE.Matrix4();
const TMP_PLANE = new THREE.Plane();
const TMP_V4 = new THREE.Vector4();
const TMP_Q4 = new THREE.Vector4();
