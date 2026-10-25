/**
 * Shared shader uniforms and material patches.
 *
 * - Replaces three.js' fog chunks with a stylised height fog that also picks
 *   up warm sun in-scattering (that golden-hour haze) and a low "mist" layer.
 * - Adds wind sway for vegetation and flags, and a night factor for glowing
 *   windows – all driven by a handful of shared uniforms so updating them is
 *   one assignment per frame, regardless of how many materials exist.
 */
import * as THREE from 'three';

export const Shared = {
  uTime: { value: 0 },
  uWind: { value: 0.3 },
  uNight: { value: 0 },
  uFogParams: { value: new THREE.Vector4(0.012, 0, 0, 30) }, // x: height falloff, y: base height, z: mist amount, w: mist height
  uFogSunColor: { value: new THREE.Color(0, 0, 0) },
  uFogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSnow: { value: 0 },
};

let chunksPatched = false;

/** Install the custom fog chunks once, before any material compiles. */
export function installShaderChunks(): void {
  if (chunksPatched) return;
  chunksPatched = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorld;
#endif`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vec4 fogW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    fogW = instanceMatrix * fogW;
  #endif
  vFogWorld = ( modelMatrix * fogW ).xyz;
#endif`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  uniform vec4 uFogParams;
  uniform vec3 uFogSunColor;
  uniform vec3 uFogSunDir;
#endif`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  vec3 fogRay = vFogWorld - cameraPosition;
  float fogDist = length( fogRay );
  #ifdef FOG_EXP2
    float fogK = uFogParams.x;
    float fh0 = cameraPosition.y - uFogParams.y;
    float fh1 = vFogWorld.y - uFogParams.y;
    float fogHF = 1.0;
    if ( fogK > 0.0 ) {
      float fdh = fh1 - fh0;
      float e0 = exp( -fogK * clamp( fh0, -60.0, 400.0 ) );
      float e1 = exp( -fogK * clamp( fh1, -60.0, 400.0 ) );
      fogHF = abs( fdh ) > 0.05 ? ( e0 - e1 ) / ( fogK * fdh ) : e0;
      fogHF = clamp( fogHF, 0.0, 3.0 );
    }
    float fogD2 = fogDensity * fogDensity * fogDist * fogDist * ( 0.28 + 0.72 * fogHF );
    // low mist hugging valleys
    float mistBand = 1.0 - smoothstep( 0.0, uFogParams.w, min( fh0, fh1 ) );
    fogD2 += uFogParams.z * fogDist * 0.0025 * mistBand;
    float fogFactor = 1.0 - exp( -fogD2 );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, fogDist );
  #endif
  float sunAmt = pow( max( dot( fogRay / max( fogDist, 0.001 ), uFogSunDir ), 0.0 ), 6.0 );
  vec3 fogC = fogColor + uFogSunColor * sunAmt;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogC, clamp( fogFactor, 0.0, 1.0 ) );
#endif`;
}

export interface PatchOptions {
  /** Vegetation sway (height-weighted) driven by wind. */
  sway?: number;
  /** Flag/cloth waving along uv.x. */
  wave?: boolean;
  /** Emissive scaled by night factor (windows). */
  nightGlow?: boolean;
  /** Snow tint on upward faces in winter / snow weather. */
  snowable?: boolean;
}

/** Attach shared uniforms and optional effects to a built-in material. */
export function patch<T extends THREE.Material>(mat: T, opts: PatchOptions = {}): T {
  const key = `mr:${opts.sway ?? 0}:${opts.wave ? 1 : 0}:${opts.nightGlow ? 1 : 0}:${opts.snowable ? 1 : 0}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFogParams = Shared.uFogParams;
    shader.uniforms.uFogSunColor = Shared.uFogSunColor;
    shader.uniforms.uFogSunDir = Shared.uFogSunDir;
    shader.uniforms.uTime = Shared.uTime;
    shader.uniforms.uWind = Shared.uWind;
    shader.uniforms.uNight = Shared.uNight;
    shader.uniforms.uSnow = Shared.uSnow;
    const head = 'uniform float uTime;\nuniform float uWind;\nuniform float uNight;\nuniform float uSnow;\n';
    shader.vertexShader = head + shader.vertexShader;
    shader.fragmentShader = head + shader.fragmentShader;
    if (opts.sway) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 ip = vec3(0.0);
          #ifdef USE_INSTANCING
            ip = instanceMatrix[3].xyz;
          #endif
          float sw = max( transformed.y, 0.0 ) * ${opts.sway.toFixed(4)} * ( 0.25 + uWind );
          float ph = uTime * ( 1.1 + uWind ) + ip.x * 0.21 + ip.z * 0.17;
          transformed.x += ( sin( ph ) + 0.4 * sin( ph * 2.3 ) ) * sw;
          transformed.z += cos( ph * 0.8 ) * sw * 0.6;
        }`,
      );
    }
    if (opts.wave) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_UV
        {
          float wv = vUv.x;
          transformed.z += sin( uTime * 4.0 - wv * 7.0 ) * wv * 0.18 * ( 0.4 + uWind );
          transformed.y += sin( uTime * 3.1 - wv * 5.0 ) * wv * 0.05;
        }
        #endif`,
      );
    }
    if (opts.nightGlow) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance *= uNight;
        #ifdef USE_COLOR
          totalEmissiveRadiance *= vColor;
        #endif`,
      );
    }
    if (opts.snowable) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
        varying float vSnowUp;`,
      ).replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        {
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wn = mat3( instanceMatrix ) * wn;
          #endif
          vSnowUp = normalize( mat3( modelMatrix ) * wn ).y;
        }`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
        varying float vSnowUp;`,
      ).replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.92, 0.94, 0.98 ), uSnow * smoothstep( 0.35, 0.8, vSnowUp ) );`,
      );
    }
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/** Convenience constructors (all patched). */
export function lambert(params: THREE.MeshLambertMaterialParameters, opts?: PatchOptions): THREE.MeshLambertMaterial {
  return patch(new THREE.MeshLambertMaterial(params), opts);
}
export function standard(params: THREE.MeshStandardMaterialParameters, opts?: PatchOptions): THREE.MeshStandardMaterial {
  return patch(new THREE.MeshStandardMaterial(params), opts);
}
export function basic(params: THREE.MeshBasicMaterialParameters, opts?: PatchOptions): THREE.MeshBasicMaterial {
  return patch(new THREE.MeshBasicMaterial(params), opts);
}
export function phong(params: THREE.MeshPhongMaterialParameters, opts?: PatchOptions): THREE.MeshPhongMaterial {
  return patch(new THREE.MeshPhongMaterial(params), opts);
}
