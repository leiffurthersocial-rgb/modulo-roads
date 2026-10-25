/**
 * Sky dome: analytic gradient sky with sun glow, moon, procedural cloud layer
 * and a star field. The dome follows the camera and is drawn after all opaque
 * geometry so only visible sky pixels pay for the shader.
 */
import * as THREE from 'three';
import { RNG } from '../core/rng';

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize( position );
  vec4 p = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * p;
}`;

const frag = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uHorizonFog;
uniform float uCover;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec2 uCloudOffset;
uniform float uNight;
uniform float uFlash;
uniform float uSunVisible;

float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float vnoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float fbm( vec2 p ) {
  float s = 0.0; float a = 0.5;
  for ( int i = 0; i < CLOUD_OCTAVES; i++ ) { s += a * vnoise( p ); p = p * 2.03 + vec2( 1.7, 9.2 ); a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize( vDir );
  float y = d.y;
  // gradient
  float t = pow( clamp( y, 0.0, 1.0 ), 0.45 );
  vec3 col = mix( uHorizon, uZenith, t );
  if ( y < 0.0 ) col = mix( uHorizon, uGround, clamp( -y * 6.0, 0.0, 1.0 ) );
  // sun glow & disc
  float sd = max( dot( d, uSunDir ), 0.0 );
  col += uSunColor * ( pow( sd, 6.0 ) * 0.22 + pow( sd, 60.0 ) * 0.45 ) * uSunVisible;
  float disc = smoothstep( 0.99935, 0.99965, sd );
  col += uSunColor * disc * 6.0 * uSunVisible;
  // moon
  float md = max( dot( d, uMoonDir ), 0.0 );
  float moon = smoothstep( 0.99935, 0.99955, md );
  col += vec3( 0.9, 0.93, 1.0 ) * ( moon * ( 0.85 + 0.15 * vnoise( d.xz * 900.0 ) ) * 1.6 + pow( md, 200.0 ) * 0.25 ) * uNight;
  // clouds
  if ( y > 0.0 && uCover > 0.01 ) {
    vec2 p = d.xz / ( y + 0.12 ) * 1.6 + uCloudOffset;
    float n = fbm( p );
    float c = smoothstep( 1.0 - uCover * 0.9 - 0.12, 1.0 - uCover * 0.9 + 0.22, n + uCover * 0.25 );
    c *= smoothstep( 0.0, 0.18, y );
    float n2 = fbm( p + uSunDir.xz * 0.12 );
    float shade = clamp( 0.55 + ( n - n2 ) * 2.5, 0.0, 1.0 );
    vec3 cc = mix( uCloudShade, uCloudLit, shade );
    cc += uSunColor * pow( sd, 4.0 ) * 0.25 * ( 1.0 - c * 0.5 ) * uSunVisible;
    col = mix( col, cc, c * 0.94 );
  }
  // blend horizon into the scene fog colour so the far terrain melts into sky
  col = mix( col, uFogColor, uHorizonFog * ( 1.0 - smoothstep( 0.0, 0.22, y ) ) );
  col += vec3( 0.8, 0.85, 1.0 ) * uFlash;
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Sky {
  readonly dome: THREE.Mesh;
  readonly stars: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uZenith: { value: new THREE.Color(0x3d7bd0) },
    uHorizon: { value: new THREE.Color(0xcfe3f2) },
    uGround: { value: new THREE.Color(0x6a7a6a) },
    uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
    uFogColor: { value: new THREE.Color(0xcfe3f2) },
    uHorizonFog: { value: 0.6 },
    uCover: { value: 0.4 },
    uCloudLit: { value: new THREE.Color(1, 1, 1) },
    uCloudShade: { value: new THREE.Color(0.7, 0.74, 0.8) },
    uCloudOffset: { value: new THREE.Vector2() },
    uNight: { value: 0 },
    uFlash: { value: 0 },
    uSunVisible: { value: 1 },
  };
  private starMat: THREE.PointsMaterial;

  constructor(octaves: number) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      defines: { CLOUD_OCTAVES: octaves },
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.material);
    this.dome.renderOrder = 1e6;
    this.dome.frustumCulled = false;

    // stars
    const rng = new RNG(4242);
    const N = 1800;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = rng.next() * 2 - 1;
      const a = rng.next() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = r * Math.cos(a);
      pos[i * 3 + 1] = Math.abs(u) * 0.98 + 0.02;
      pos[i * 3 + 2] = r * Math.sin(a);
      const b = 0.4 + Math.pow(rng.next(), 3) * 1.6;
      const warm = rng.next();
      col[i * 3] = b * (0.85 + warm * 0.15);
      col[i * 3 + 1] = b * 0.9;
      col[i * 3 + 2] = b * (1 - warm * 0.15);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.PointsMaterial({
      size: 1.6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 1e6 + 1;
  }

  setOctaves(o: number): void {
    if (this.material.defines!.CLOUD_OCTAVES === o) return;
    this.material.defines!.CLOUD_OCTAVES = o;
    this.material.needsUpdate = true;
  }

  /** Keep the dome centred on the camera, just inside the far plane. */
  follow(camera: THREE.PerspectiveCamera, time: number): void {
    const r = camera.far * 0.92;
    this.dome.position.copy(camera.position);
    this.dome.scale.setScalar(r);
    this.stars.position.copy(camera.position);
    this.stars.scale.setScalar(r * 0.98);
    this.stars.rotation.y = time * 0.002;
  }

  setStars(opacity: number): void {
    this.starMat.opacity = opacity;
    this.stars.visible = opacity > 0.01;
  }
}
