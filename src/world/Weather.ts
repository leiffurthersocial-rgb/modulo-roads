/**
 * Precipitation: rain streaks or snowflakes in a box that wraps around the
 * camera. Positions are animated entirely in the vertex shader (zero CPU per
 * frame), so even thousands of drops cost almost nothing on the CPU.
 */
import * as THREE from 'three';
import { RNG } from '../core/rng';

const vert = /* glsl */ `
attribute vec3 aOffset;
attribute float aRand;
uniform vec3 uCam;
uniform float uTime;
uniform vec3 uBox;
uniform vec3 uVel;
uniform float uSnow;
uniform float uSize;
uniform vec3 uCamRight;
varying float vAlpha;
void main() {
  vec3 p = aOffset + uVel * ( uTime * ( 0.8 + aRand * 0.4 ) );
  if ( uSnow > 0.5 ) {
    p.x += sin( uTime * 1.3 + aRand * 40.0 ) * 0.6;
    p.z += cos( uTime * 1.1 + aRand * 30.0 ) * 0.6;
  }
  p = mod( p - uCam + uBox * 0.5, uBox ) - uBox * 0.5 + uCam;
  vec3 vel = normalize( uVel );
  vec3 right = uCamRight;
  vec3 w;
  if ( uSnow > 0.5 ) {
    // small camera-facing quad
    vec3 up = normalize( cross( right, normalize( cameraPosition - p ) ) );
    w = p + ( right * ( position.x ) + up * ( position.y - 0.5 ) ) * uSize * ( 0.6 + aRand * 0.8 );
  } else {
    // streak stretched along the velocity
    vec3 side = normalize( cross( vel, normalize( cameraPosition - p ) ) );
    w = p + side * position.x * uSize + vel * position.y * uSize * 18.0;
  }
  float d = length( p - cameraPosition );
  vAlpha = smoothstep( 1.0, 4.0, d ) * ( 1.0 - smoothstep( uBox.x * 0.35, uBox.x * 0.5, d ) );
  gl_Position = projectionMatrix * viewMatrix * vec4( w, 1.0 );
}`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uSnow;
varying float vAlpha;
void main() {
  gl_FragColor = vec4( uColor, uOpacity * vAlpha );
}`;

export class Precipitation {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uCam: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uBox: { value: new THREE.Vector3(70, 34, 70) },
    uVel: { value: new THREE.Vector3(0, -24, 0) },
    uSnow: { value: 0 },
    uSize: { value: 0.012 },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uColor: { value: new THREE.Color(0.75, 0.8, 0.88) },
    uOpacity: { value: 0.45 },
  };
  private geo: THREE.InstancedBufferGeometry;
  private max: number;

  constructor(max = 7000) {
    this.max = max;
    const base = new THREE.PlaneGeometry(1, 1);
    base.translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    const rng = new RNG(99);
    const off = new Float32Array(max * 3);
    const rnd = new Float32Array(max);
    for (let i = 0; i < max; i++) {
      off[i * 3] = rng.range(-35, 35);
      off[i * 3 + 1] = rng.range(-17, 17);
      off[i * 3 + 2] = rng.range(-35, 35);
      rnd[i] = rng.next();
    }
    g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    g.setAttribute('aRand', new THREE.InstancedBufferAttribute(rnd, 1));
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(1); // not rendered into water reflections
    this.mesh.renderOrder = 10;
  }

  /**
   * @param kind 0 none, 1 rain, 2 snow
   * @param intensity 0..1
   */
  set(kind: number, intensity: number, wind: number, windDir: number, quality: number): void {
    const count = Math.floor(this.max * intensity * quality);
    this.geo.instanceCount = kind === 0 ? 0 : count;
    this.mesh.visible = kind !== 0 && count > 0;
    const u = this.uniforms;
    if (kind === 2) {
      u.uSnow.value = 1;
      u.uVel.value.set(Math.sin(windDir) * wind * 3, -2.2, Math.cos(windDir) * wind * 3);
      u.uSize.value = 0.09;
      u.uColor.value.setRGB(0.95, 0.96, 1);
      u.uOpacity.value = 0.9;
    } else {
      u.uSnow.value = 0;
      u.uVel.value.set(Math.sin(windDir) * wind * 7, -26, Math.cos(windDir) * wind * 7);
      u.uSize.value = 0.014;
      u.uColor.value.setRGB(0.72, 0.77, 0.85);
      u.uOpacity.value = 0.32 + intensity * 0.18;
    }
  }

  update(camera: THREE.Camera, time: number): void {
    this.uniforms.uCam.value.copy(camera.position);
    this.uniforms.uTime.value = time;
    this.uniforms.uCamRight.value.setFromMatrixColumn(camera.matrixWorld, 0);
  }
}
