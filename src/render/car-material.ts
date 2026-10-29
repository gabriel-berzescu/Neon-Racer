/**
 * The neon car's materials.
 *
 * One shader draws the whole car (body, wheels, lamps): lit dark surfaces that reflect the violet night (a horizon band and a fresnel
 * rim, so the silhouette reads against the dark ground and sky but stays far under the bloom threshold), and glowing parts whose
 * brightness comes from the vertex colour times a channel gain (car-geom.ts GLOW): the brake lights, the spokes and their blur disc
 * change by uniforms only, never by rewriting a buffer.
 *
 * It needs no scene lights, so it looks the same in the game, on the menu and in the sandbox.
 *
 * The ghost variant: one colour, additive and faint, drawn after a depth-only pass of the same mesh (so the ghost hides its own far
 * side and reads as a solid hologram, not a tangle of lines), every value kept under the bloom threshold, and fading further when it is
 * right in front of the camera (uOpacity, set per frame from the camera distance).
 */
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

const VERT = /* glsl */ `
attribute vec3 aCol;
attribute float aGlow;
varying vec3 vCol;
varying float vGlow;
varying vec3 vN;
varying vec3 vV;
void main() {
  vCol = aCol;
  vGlow = aGlow;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal;
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform float uBrake;
uniform float uSpoke;
uniform float uBlur;
uniform float uOpacity;
uniform vec3 uRim;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uGhost;
varying vec3 vCol;
varying float vGlow;
varying vec3 vN;
varying vec3 vV;

void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  float ndv = dot(n, v);
  if (ndv < 0.0) { n = -n; ndv = -ndv; }
  float fres = pow(1.0 - clamp(ndv, 0.0, 1.0), 3.0);

  if (vGlow > 0.5) {
    float g = vGlow < 1.5 ? 1.0 : vGlow < 2.5 ? uBrake : vGlow < 3.5 ? uSpoke : uBlur;
    if (g < 0.01) discard;
    vec3 c = vCol * g;
#ifdef GHOST
    float l = min(dot(c, vec3(0.3, 0.59, 0.11)), 1.0);
    gl_FragColor = vec4(uGhost * (0.55 * l) * uOpacity, 1.0);
#else
    gl_FragColor = vec4(c, 1.0);
#endif
    return;
  }

#ifdef GHOST
  gl_FragColor = vec4(uGhost * (0.035 + 0.38 * fres) * uOpacity, 1.0);
#else
  // the reflected direction in world space (view -> world: multiply by the view matrix's transpose)
  vec3 r = reflect(-v, n);
  vec3 rw = (vec4(r, 0.0) * viewMatrix).xyz;
  vec3 nw = (vec4(n, 0.0) * viewMatrix).xyz;
  float band = exp(-abs(rw.y) * 5.0);
  vec3 env = mix(uZenith, uHorizon, band) * (rw.y > 0.0 ? 1.0 : 0.3);
  float key = 0.45 + 0.55 * clamp(nw.y * 0.8 + 0.2, 0.0, 1.0);
  vec3 col = vCol * key + env * (0.3 + 0.7 * fres) + uRim * fres;
  gl_FragColor = vec4(col, 1.0);
#endif
}
`;

export interface CarUniforms {
  uBrake: { value: number };
  uSpoke: { value: number };
  uBlur: { value: number };
  uOpacity: { value: number };
  uRim: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uZenith: { value: THREE.Color };
  uGhost: { value: THREE.Color };
}

/** The car's surface material (one per CarView: its uniforms are that car's brake and wheel state). */
export function carMaterial(opts: { rim: THREE.Color; ghost?: THREE.Color | null }): THREE.ShaderMaterial & { uniforms: CarUniforms } {
  const uniforms: CarUniforms = {
    uBrake: { value: 0.4 },
    uSpoke: { value: 1 },
    uBlur: { value: 0 },
    uOpacity: { value: 1 },
    uRim: { value: opts.rim.clone() },
    // the night the body reflects: the violet-pink horizon band and the dark zenith
    uHorizon: { value: new THREE.Color(0.075, 0.02, 0.13) },
    uZenith: { value: new THREE.Color(0.006, 0.003, 0.016) },
    uGhost: { value: (opts.ghost ?? new THREE.Color(1, 1, 1)).clone() },
  };
  const ghost = !!opts.ghost;
  const m = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
    defines: ghost ? { GHOST: 1 } : {},
    transparent: ghost,
    depthWrite: !ghost,
    depthFunc: ghost ? THREE.LessEqualDepth : THREE.LessEqualDepth,
    blending: ghost ? THREE.AdditiveBlending : THREE.NormalBlending,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  return m as THREE.ShaderMaterial & { uniforms: CarUniforms };
}

/** The ghost's depth-only pass (drawn after the opaque world, before the ghost's colour). */
export function depthOnlyMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
}

/** The neon edge lines (per-vertex colours, screen-space width). */
export function lineMaterial(opts: { ghost?: THREE.Color | null }): LineMaterial {
  const ghost = !!opts.ghost;
  const m = new LineMaterial({
    color: ghost ? opts.ghost!.clone().multiplyScalar(0.62) : 0xffffff,
    vertexColors: !ghost,
    linewidth: 2.2,
    worldUnits: false,
    transparent: ghost,
    opacity: 1,
    depthWrite: !ghost,
  });
  // A fat line is a screen-space quad: on a curved body half of it sinks into the surface it rides on and fights it for depth (the
  // line shows as a string of beads). Each end is pulled LINE_LIFT towards the camera along its own view ray, so it wins the depth
  // test without moving on the screen.
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );',
      `vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );
      start.xyz -= normalize( start.xyz ) * min( ${LINE_LIFT.toFixed(3)}, 0.5 * length( start.xyz ) );
      end.xyz -= normalize( end.xyz ) * min( ${LINE_LIFT.toFixed(3)}, 0.5 * length( end.xyz ) );`,
    );
  };
  m.customProgramCacheKey = () => 'neon-car-line';
  return m;
}

/** How far (m) the car's edge lines are pulled towards the camera to win the depth test against the body they sit on. */
const LINE_LIFT = 0.03;

/** The soft pool of light under the car: an additive ellipse, kept under the bloom threshold. */
export function underglowMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float d = length(vUv);
        float a = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(uColor * a * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}
