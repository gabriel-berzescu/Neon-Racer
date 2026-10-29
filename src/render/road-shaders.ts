/**
 * The road's shaders (src/render/road.ts): the road surface, the barriers, and the neon of the gantries. Everything is drawn from
 * the road's own coordinates (s along it, d across it, carried as vertex attributes), so the lines are exact and anti-aliased in the
 * fragment shader, whatever the mesh, and nothing is uploaded per frame but a few uniforms.
 *
 * Brightness: the bloom (src/render/stage.ts) catches anything above about 0.75 (linear). The edge lines, the barrier's top rail and
 * its posts, the chevrons and the gantries are drawn above it and glow; the surfaces stay far below it. Lines thinner than a pixel
 * keep the light of their true width (no beads, no shimmer far away), and everything fades into the horizon's colour with the
 * terrain's fog (the same function), so the road melts into the distance with the land.
 */
import { SKY_COMMON_GLSL } from './skyGlsl';
import { TERRAIN_FOG_DISTANCE } from './terrainGlsl';
import { ROAD_HALF, SHOULDER, WALL, FORMATION } from '../world/stage-track';

function fl(v: number): string {
  if (Number.isInteger(v)) return `${v}.0`;
  const s = v.toPrecision(9);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

const COMMON = /* glsl */ `
${SKY_COMMON_GLSL}
#define FOG_DISTANCE ${fl(TERRAIN_FOG_DISTANCE)}
// The light of a line of half-width hw (m) at distance x (m) from its centre, px = a pixel's size (m): never thinner than a pixel, with
// the light of its true width.
float aaLine(float x, float hw, float px) {
  float w = max(hw, 0.5 * px);
  return clamp((w - abs(x)) / px + 0.5, 0.0, 1.0) * (hw / w);
}
// A periodic dash along s: on for the first 'duty' of every 'period' metres, anti-aliased (ps = a pixel's size along s).
float aaDash(float s, float period, float duty, float ps) {
  float f = fract(s / period) * period;
  float on = duty * period;
  float a = clamp((f) / max(ps, 1e-4) + 0.5, 0.0, 1.0) * clamp((on - f) / max(ps, 1e-4) + 0.5, 0.0, 1.0);
  // far away, where the dash is under a pixel, its average
  return mix(a, duty, smoothstep(0.3 * period, period, ps));
}
// A neon tube: the line's body (its true width) at 'body', below the bloom's threshold, and a core about a pixel wide at 'core', above
// it, so the bloom sees a line of about a pixel whatever the distance (like the terrain's grid lines) and does not flood the screen
// with the glow of a line that is forty pixels wide next to the camera. Far away, under a pixel, it is the core's light alone.
float tube(float x, float hw, float px, float body, float core) {
  float b = aaLine(x, hw, px);
  // (the core is a gaussian about a pixel wide, so it carries the same light whatever its sub-pixel position: no beads along a line
  // that is nearly horizontal or vertical on the screen; a line thinner than the core gives it only its own light)
  float xp = x / px;
  float c = exp(-0.5 * xp * xp / 0.5625) * min(1.0, hw / (0.65 * px));
  return b * body + c * (core - body * min(1.0, hw / (0.65 * px)));
}
`;

export const ROAD_VERT = /* glsl */ `
attribute vec3 aRoad;   // s, d, curvature
varying vec3 vRoad;
varying vec3 vView;
varying vec3 vWorldN;
void main() {
  vRoad = aRoad;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  vWorldN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * mv;
}
`;

export const ROAD_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uAsphalt;
uniform vec3 uRunoff;
uniform vec3 uVerge;
uniform vec3 uCyan;
uniform vec3 uMagenta;
uniform vec3 uAmber;
uniform float uFinish;   // s of the finish line
uniform float uTime;
varying vec3 vRoad;
varying vec3 vView;
varying vec3 vWorldN;

#define ROAD_HALF ${fl(ROAD_HALF)}
#define SHOULDER ${fl(SHOULDER)}
#define WALL ${fl(WALL)}
#define FORMATION ${fl(FORMATION)}

void main() {
  float s = vRoad.x;
  float d = vRoad.y;
  float ad = abs(d);
  float kap = vRoad.z;
  vec2 px = fwidth(vRoad.xy);
  float ps = max(px.x, 1e-4);
  float pd = max(px.y, 1e-4);
  float dist = length(vView);
  vec3 wdir = (vec4(vView / dist, 0.0) * viewMatrix).xyz;
  vec3 hz = skyHorizonColor(wdir);

  // ---- the surfaces: asphalt, the shoulder, the run-off, the verge behind the barrier, the skirt down to the terrain
  vec3 col = uAsphalt;
  float fres = pow(1.0 - clamp(-wdir.y, 0.0, 1.0), 4.0);
  if (ad > FORMATION) {
    col = uVerge * 0.6;
  } else if (ad > WALL) {
    col = uVerge;
  } else if (ad > SHOULDER) {
    col = uRunoff;
  } else if (ad > ROAD_HALF) {
    col = mix(uAsphalt, uRunoff, 0.35);
  }
  // the asphalt and the shoulder are smooth: they mirror the horizon's glow at grazing angles (a night road after rain)
  if (ad <= SHOULDER) col += hz * (0.10 * fres);

  // ---- lines
  float lines = 0.0;
  vec3 lineCol = vec3(0.0);
  // the edge lines
  lineCol += uCyan * tube(ad - (ROAD_HALF - 0.22), 0.12, pd, 0.5, 1.7);
  // the dashed centre line
  lineCol += vec3(1.0, 0.72, 0.95) * (tube(d, 0.08, pd, 0.45, 1.0) * aaDash(s, 12.0, 0.42, ps));
  // kerbs on the shoulder in corners: magenta and dark, 2 m blocks
  float curve = smoothstep(1.0 / 400.0, 1.0 / 180.0, abs(kap));
  if (curve > 0.0 && ad > ROAD_HALF && ad < ROAD_HALF + 1.0) {
    float k = aaDash(s, 2.0, 0.5, ps) * aaLine(ad - (ROAD_HALF + 0.5), 0.42, pd);
    lineCol += uMagenta * (0.55 * k * curve);
  }
  // the run-off and the verge: a faint road-aligned grid (10 m along, 2.5 m across), for the sense of speed at the edge of the eye
  if (ad > SHOULDER && ad < FORMATION) {
    float g1 = aaLine(fract(s / 10.0 + 0.5) * 10.0 - 5.0, 0.05, ps);
    float g2 = aaLine(fract((ad - SHOULDER) / 2.5 + 0.5) * 2.5 - 1.25, 0.04, pd);
    float fadeG = 1.0 - smoothstep(4.0, 12.0, ps / 0.05 * 0.5);
    lineCol += uCyan * (0.16 * max(g1, g2) * fadeG);
  }
  // the shoulder's outer edge (where the paving ends and the run-off begins), and the formation's edge where the road meets the land
  lineCol += uMagenta * (0.22 * aaLine(ad - SHOULDER, 0.05, pd));
  lineCol += uCyan * (0.22 * aaLine(ad - FORMATION + 0.06, 0.05, pd));

  // ---- the start line and the finish line: chequered, 1.2 m
  float sl = step(-1.2, s) * step(s, 0.0);
  float fl0 = step(uFinish, s) * step(s, uFinish + 1.6);
  if ((sl + fl0) > 0.0 && ad < ROAD_HALF) {
    float ch = mod(floor(s / 0.4) + floor(d / 0.4), 2.0);
    vec3 c2 = fl0 > 0.0 ? mix(vec3(0.02), vec3(1.4, 1.3, 1.4), ch) : mix(vec3(0.02), uAmber * 0.9, ch);
    col = c2;
  }
  // the grid box of the start: a bracket behind the start line
  if (s < 0.0 && s > -9.0) {
    float box = max(aaLine(s + 1.8, 0.07, ps) * step(ad, 1.3), aaLine(ad - 1.3, 0.07, pd) * step(s, -1.8) * step(-7.5, s));
    lineCol += vec3(0.9, 0.9, 1.0) * (0.8 * box);
  }

  float fog;
  float fd = dist / FOG_DISTANCE;
  fog = 1.0 - exp(-fd * fd);
  float lineFade = (1.0 - fog) * (1.0 - fog);
  col += lineCol * lineFade;
  col = mix(col, hz, fog);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const BARRIER_VERT = /* glsl */ `
attribute vec4 aBar;    // s, height above the road (m), chevron (signed: the way the road turns, 0 = none), side (+1 left, -1 right)
varying vec4 vBar;
varying vec3 vView;
void main() {
  vBar = aBar;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

export const BARRIER_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uPanel;
uniform vec3 uCyan;
uniform vec3 uMagenta;
uniform vec3 uAmber;
varying vec4 vBar;
varying vec3 vView;

#define RAIL_TOP 1.0
void main() {
  float s = vBar.x;
  float v = vBar.y;
  float chev = vBar.z;
  vec2 px = fwidth(vBar.xy);
  float ps = max(px.x, 1e-4);
  float pv = max(px.y, 1e-4);
  float ac = abs(chev);
  float top = RAIL_TOP + 0.6 * ac;

  vec3 col = uPanel;
  vec3 glow = vec3(0.0);
  // the top rail: a bright cyan bar, and a dimmer magenta one low down
  glow += uCyan * tube(v - (top - 0.07), 0.07, pv, 0.5, 1.55);
  glow += uMagenta * (0.65 * aaLine(v - 0.32, 0.035, pv));
  // posts every 4 m: they stream past at speed
  glow += uCyan * (tube(fract(s / 4.0 + 0.5) * 4.0 - 2.0, 0.06, ps, 0.35, 1.0) * step(0.0, v));
  // chevrons on the outside of the tight corners: amber arrows pointing the way the road goes
  if (ac > 0.01) {
    float c = 0.5 * top;
    float ph = fract((s * sign(chev) * -1.0 + 1.25 * abs(v - c)) / 2.4);
    // (the arrows point along the direction of travel: the stripes lean back from the middle of the board)
    float a = clamp((0.42 - abs(ph - 0.5)) / max(ps / 2.4, 1e-4) * 0.5, 0.0, 1.0);
    float board = step(0.12, v) * step(v, top - 0.18);
    glow += uAmber * (0.62 * a * board * ac);
  }
  float fog;
  float dist = length(vView);
  vec3 wdir = (vec4(vView / dist, 0.0) * viewMatrix).xyz;
  vec3 hz = skyHorizonColor(wdir);
  float fd = dist / FOG_DISTANCE;
  fog = 1.0 - exp(-fd * fd);
  col += glow * (1.0 - fog) * (1.0 - fog);
  col = mix(col, hz, fog);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const NEON_VERT = /* glsl */ `
varying vec3 vView;
varying vec3 vN;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

/** A flat neon colour (or a dark body with a hint of the horizon on its edges), fogged like the terrain. */
export const NEON_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uColor;
uniform float uIntensity;
uniform float uBody;     // 1: a dark body (lit by the horizon's glow at grazing angles), 0: neon
varying vec3 vView;
varying vec3 vN;
void main() {
  float dist = length(vView);
  vec3 wdir = (vec4(vView / dist, 0.0) * viewMatrix).xyz;
  vec3 hz = skyHorizonColor(wdir);
  vec3 col = uColor * uIntensity;
  if (uBody > 0.5) {
    float ndv = abs(dot(normalize(vN), normalize(-vView)));
    col = uColor + hz * (0.25 * pow(1.0 - ndv, 2.0));
  }
  float fd = dist / FOG_DISTANCE;
  float fog = 1.0 - exp(-fd * fd);
  col = mix(col, hz, fog);
  gl_FragColor = vec4(col, 1.0);
}
`;

export { fl as glslFloat };
