/**
 * Car definitions (handling + audio character) and their low-poly models.
 * Bodies are extruded side silhouettes; the glasshouse is a second, slightly
 * wider extrusion so its sloped edges become windscreen and rear window.
 * Models face +Z; the driver sits on the left (+X), as in Switzerland.
 */
import * as THREE from 'three';
import { standard, basic, lambert } from '../world/Materials';

export interface CarDef {
  id: string;
  name: string;
  blurb: string;
  mass: number; // kg (affects weight transfer & bumps)
  accel: number; // m/s² peak drive acceleration
  topSpeed: number; // m/s
  grip: number; // lateral friction multiplier
  steer: number; // max wheel angle at standstill (rad)
  wheelbase: number;
  track: number;
  wheelRadius: number;
  softness: number; // suspension (0 stiff .. 1 floaty)
  gears: number[]; // top speed (m/s) in each forward gear
  idleRpm: number;
  maxRpm: number;
  engine: { base: number; harm: number; growl: number; cylinders: number };
  color: number;
  profile: [number, number][]; // side silhouette (z, y), counter-clockwise
  glass: [number, number][];
  width: number;
  length: number;
  height: number;
  eye: [number, number, number]; // cockpit camera (local)
}

export const CARS: CarDef[] = [
  {
    id: 'hatch',
    name: 'Zephyr Hatch',
    blurb: 'Light, eager and forgiving. A happy little hatchback for winding lanes.',
    mass: 1150,
    accel: 4.4,
    topSpeed: 52,
    grip: 1.0,
    steer: 0.58,
    wheelbase: 2.5,
    track: 1.52,
    wheelRadius: 0.31,
    softness: 0.5,
    gears: [12, 21, 31, 41, 52],
    idleRpm: 850,
    maxRpm: 6500,
    engine: { base: 1, harm: 0.55, growl: 0.35, cylinders: 4 },
    color: 0xc8312b,
    width: 1.74,
    length: 3.9,
    height: 1.45,
    profile: [
      [-1.95, 0.32], [1.95, 0.32], [1.97, 0.62], [1.86, 0.84], [0.8, 0.98], [0.18, 1.42], [-1.42, 1.43], [-1.9, 1.06], [-1.97, 0.74],
    ],
    glass: [[0.72, 1.0], [0.16, 1.385], [-1.38, 1.395], [-1.83, 1.06], [-1.8, 1.0]],
    eye: [0.36, 1.14, -0.2],
  },
  {
    id: 'estate',
    name: 'Alpina Estate',
    blurb: 'Long, calm and planted. Soft suspension that floats over alpine passes.',
    mass: 1600,
    accel: 4.0,
    topSpeed: 58,
    grip: 0.95,
    steer: 0.52,
    wheelbase: 2.85,
    track: 1.6,
    wheelRadius: 0.33,
    softness: 0.85,
    gears: [12, 22, 33, 44, 52, 58],
    idleRpm: 750,
    maxRpm: 5800,
    engine: { base: 0.85, harm: 0.45, growl: 0.25, cylinders: 5 },
    color: 0x3e5a72,
    width: 1.84,
    length: 4.75,
    height: 1.5,
    profile: [
      [-2.37, 0.34], [2.37, 0.34], [2.4, 0.64], [2.28, 0.86], [1.1, 1.0], [0.45, 1.45], [-2.05, 1.48], [-2.33, 1.25], [-2.4, 0.78],
    ],
    glass: [[1.02, 1.02], [0.43, 1.41], [-2.02, 1.44], [-2.28, 1.22], [-2.27, 1.02]],
    eye: [0.38, 1.18, 0.1],
  },
  {
    id: 'coupe',
    name: 'Lumen Coupé',
    blurb: 'Low, sharp and quick. Bites hard into corners and loves to slide when pushed.',
    mass: 1350,
    accel: 6.2,
    topSpeed: 70,
    grip: 1.18,
    steer: 0.5,
    wheelbase: 2.6,
    track: 1.6,
    wheelRadius: 0.33,
    softness: 0.2,
    gears: [15, 26, 38, 50, 61, 70],
    idleRpm: 950,
    maxRpm: 7600,
    engine: { base: 1.15, harm: 0.7, growl: 0.6, cylinders: 6 },
    color: 0xd9d9d6,
    width: 1.86,
    length: 4.4,
    height: 1.25,
    profile: [
      [-2.2, 0.28], [2.2, 0.28], [2.23, 0.52], [2.1, 0.7], [0.65, 0.86], [-0.15, 1.24], [-1.2, 1.22], [-2.12, 0.92], [-2.22, 0.66],
    ],
    glass: [[0.6, 0.88], [-0.14, 1.2], [-1.18, 1.19], [-1.95, 0.93], [-1.9, 0.88]],
    eye: [0.38, 0.98, -0.45],
  },
  {
    id: 'classic',
    name: 'Classic 1300',
    blurb: 'A rounded 1960s icon. Slow, bouncy, utterly charming. Takes its time.',
    mass: 840,
    accel: 2.6,
    topSpeed: 36,
    grip: 0.88,
    steer: 0.6,
    wheelbase: 2.4,
    track: 1.32,
    wheelRadius: 0.32,
    softness: 1,
    gears: [9, 17, 27, 36],
    idleRpm: 800,
    maxRpm: 4600,
    engine: { base: 0.7, harm: 0.8, growl: 0.75, cylinders: 2 },
    color: 0x7fb8b0,
    width: 1.55,
    length: 4.05,
    height: 1.5,
    profile: [
      [-2.0, 0.36], [2.0, 0.36], [2.03, 0.58], [1.92, 0.78], [1.55, 0.92], [0.9, 1.0], [0.45, 1.36], [0.0, 1.5], [-0.75, 1.5], [-1.4, 1.32], [-1.85, 0.98], [-2.02, 0.68],
    ],
    glass: [[0.84, 1.02], [0.43, 1.33], [0.0, 1.46], [-0.72, 1.46], [-1.32, 1.3], [-1.45, 1.05]],
    eye: [0.32, 1.18, -0.1],
  },
  {
    id: 'van',
    name: 'Alpine Post Van',
    blurb: 'Tall, yellow and unflappable – the mountain bus that brings the mail up every pass.',
    mass: 2400,
    accel: 2.8,
    topSpeed: 38,
    grip: 0.9,
    steer: 0.55,
    wheelbase: 3.1,
    track: 1.72,
    wheelRadius: 0.36,
    softness: 0.7,
    gears: [9, 17, 26, 33, 38],
    idleRpm: 700,
    maxRpm: 4200,
    engine: { base: 0.6, harm: 0.4, growl: 0.5, cylinders: 4 },
    color: 0xf2c200,
    width: 2.0,
    length: 5.3,
    height: 2.35,
    profile: [
      [-2.65, 0.4], [2.65, 0.4], [2.68, 0.75], [2.55, 1.05], [2.3, 1.2], [1.95, 2.2], [1.7, 2.32], [-2.55, 2.32], [-2.66, 2.1],
    ],
    glass: [[2.27, 1.25], [1.93, 2.12], [-2.5, 2.12], [-2.5, 1.45], [1.9, 1.45]],
    eye: [0.42, 1.85, 1.35],
  },
];

export function carById(id: string): CarDef {
  return CARS.find((c) => c.id === id) ?? CARS[0];
}

/** Sutherland–Hodgman clip of a polygon to the half-plane y ≥ c. */
function clipAbove(poly: [number, number][], c: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ina = a[1] >= c;
    const inb = b[1] >= c;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (c - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, c]);
    }
  }
  return out;
}

function extrudeProfile(points: [number, number][], width: number, bevel: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  // shape lies in XY (x = length); extrusion along +Z. Rotate so length → Z, width → X.
  geo.rotateY(-Math.PI / 2);
  geo.translate(width / 2 - bevel, 0, 0);
  return geo;
}

export interface CarModel {
  root: THREE.Group;
  body: THREE.Group; // receives suspension pitch/roll/heave
  wheels: THREE.Object3D[]; // FL, FR, RL, RR (pivot for steering on front)
  spinners: THREE.Object3D[];
  headlightMat: THREE.MeshBasicMaterial;
  tailMat: THREE.MeshBasicMaterial;
  interior: THREE.Group;
  steeringWheel: THREE.Object3D;
  wipers: THREE.Object3D[];
  paint: THREE.MeshStandardMaterial;
  headlightAnchor: THREE.Object3D;
  dispose(): void;
}

export function buildCar(def: CarDef): CarModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const paint = standard({ color: def.color, metalness: 0.35, roughness: 0.32, envMapIntensity: 1.0 });
  const glassMat = standard({ color: 0x1b242c, metalness: 0.6, roughness: 0.08, envMapIntensity: 1.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const trim = lambert({ color: 0x24262a });
  const chrome = standard({ color: 0xc8ccd0, metalness: 0.9, roughness: 0.2 });
  const headlightMat = basic({ color: 0xfff6dd });
  const tailMat = basic({ color: 0x7a0c0c });
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [paint, glassMat, trim, chrome, headlightMat, tailMat];

  const bodyGeo = extrudeProfile(def.profile, def.width, 0.06);
  geos.push(bodyGeo);
  const bodyMesh = new THREE.Mesh(bodyGeo, paint);
  bodyMesh.castShadow = true;
  body.add(bodyMesh);
  // Glasshouse = the body silhouette above the belt line, drawn with a polygon
  // offset so it always wins over the paint; a painted roof skin goes on top.
  const belt = def.glass[0][1];
  const glassGeo = extrudeProfile(clipAbove(def.profile, belt), def.width + 0.004, 0.0);
  let roofY = 0;
  for (const p of def.profile) roofY = Math.max(roofY, p[1]);
  const roofGeo = extrudeProfile(clipAbove(def.profile, roofY - 0.07), def.width - 0.16, 0.0);
  roofGeo.translate(0, 0.012, 0);
  geos.push(roofGeo);
  geos.push(glassGeo);
  const glass = new THREE.Mesh(glassGeo, glassMat);
  body.add(glass);
  const roofPaint = standard({ color: def.color, metalness: 0.35, roughness: 0.32, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
  mats.push(roofPaint);
  body.add(new THREE.Mesh(roofGeo, def.id === 'classic' ? standard({ color: 0xf2ead8, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }) : roofPaint));

  const L = def.length / 2;
  const W = def.width / 2;
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
    const g = new THREE.BoxGeometry(w, h, d);
    geos.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    body.add(mesh);
    return mesh;
  };
  // bumpers & sills
  const frontY = def.profile[2][1] * 0.5 + 0.22;
  box(def.width + 0.04, 0.18, 0.16, 0, 0.42, L + 0.02, trim);
  box(def.width + 0.04, 0.18, 0.16, 0, 0.42, -L - 0.02, trim);
  box(0.06, 0.12, def.length * 0.62, W + 0.01, 0.42, 0, trim);
  box(0.06, 0.12, def.length * 0.62, -W - 0.01, 0.42, 0, trim);
  // lights
  const hlY = Math.min(frontY + 0.12, def.profile[2][1] + 0.05);
  for (const sx of [-1, 1]) {
    box(0.32, 0.13, 0.05, sx * (W - 0.28), hlY, L + 0.035, headlightMat);
    box(0.3, 0.12, 0.05, sx * (W - 0.26), def.profile[def.profile.length - 1][1] + 0.02, -L - 0.035, tailMat);
  }
  // grille / plate
  box(0.5, 0.11, 0.04, 0, 0.6, L + 0.05, chrome);
  box(0.46, 0.11, 0.03, 0, 0.62, -L - 0.05, basic({ color: 0xf2f2f2 }));
  // mirrors
  for (const sx of [-1, 1]) box(0.16, 0.1, 0.08, sx * (W + 0.07), def.glass[0][1] + 0.05, def.glass[0][0] - 0.15, paint);
  if (def.id === 'van') {
    // classic post-horn style red stripe on the roof edge and a roof box
    box(def.width + 0.02, 0.12, def.length * 0.9, 0, 1.0, 0, basic({ color: 0xd52b1e }));
    box(def.width * 0.8, 0.12, def.length * 0.55, 0, 2.42, -0.4, trim);
  }
  // wheels
  const wheelGeo = new THREE.CylinderGeometry(def.wheelRadius, def.wheelRadius, 0.22, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(def.wheelRadius * 0.55, def.wheelRadius * 0.55, 0.235, 8);
  hubGeo.rotateZ(Math.PI / 2);
  geos.push(wheelGeo, hubGeo);
  const tyre = lambert({ color: 0x18191b });
  const hubMat = standard({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.35 });
  mats.push(tyre, hubMat);
  const wheels: THREE.Object3D[] = [];
  const spinners: THREE.Object3D[] = [];
  const zs = [def.wheelbase / 2, def.wheelbase / 2, -def.wheelbase / 2, -def.wheelbase / 2];
  const tw = Math.max(def.track / 2, def.width / 2 - 0.1);
  const xs = [tw, -tw, tw, -tw];
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(xs[i], def.wheelRadius, zs[i]);
    const spin = new THREE.Group();
    const t = new THREE.Mesh(wheelGeo, tyre);
    t.castShadow = true;
    const h = new THREE.Mesh(hubGeo, hubMat);
    spin.add(t, h);
    pivot.add(spin);
    root.add(pivot);
    wheels.push(pivot);
    spinners.push(spin);
  }

  // interior (cockpit view only)
  const interior = new THREE.Group();
  const dashMat = lambert({ color: 0x2a2c30 });
  mats.push(dashMat);
  const dashZ = def.glass[0][0] - 0.12;
  const dash = new THREE.Mesh(new THREE.BoxGeometry(def.width - 0.15, 0.22, 0.5), dashMat);
  dash.position.set(0, def.glass[0][1] - 0.05, dashZ - 0.1);
  geos.push(dash.geometry);
  interior.add(dash);
  const clusterMat = basic({ color: 0x0c1014 });
  mats.push(clusterMat);
  const cluster = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.02), clusterMat);
  cluster.position.set(def.eye[0], def.glass[0][1] + 0.06, dashZ - 0.36);
  cluster.rotation.x = -0.3;
  geos.push(cluster.geometry);
  interior.add(cluster);
  const sw = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 6, 18), dashMat);
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.02), dashMat);
  geos.push(ring.geometry, spoke.geometry);
  sw.add(ring, spoke);
  sw.position.set(def.eye[0], def.eye[1] - 0.3, def.eye[2] + 0.42);
  sw.rotation.x = -0.35;
  interior.add(sw);
  // A-pillars to frame the view
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.06), trim);
    p.position.set(sx * (W - 0.08), (def.glass[0][1] + def.glass[1][1]) / 2, (def.glass[0][0] + def.glass[1][0]) / 2);
    p.rotation.x = Math.atan2(def.glass[0][0] - def.glass[1][0], def.glass[1][1] - def.glass[0][1]);
    geos.push(p.geometry);
    interior.add(p);
  }
  interior.visible = false;
  body.add(interior);

  // wipers (visible from inside and outside)
  const wipers: THREE.Object3D[] = [];
  for (const sx of [-0.35, 0.3]) {
    const piv = new THREE.Group();
    piv.position.set(sx, def.glass[0][1] + 0.02, def.glass[0][0] + 0.02);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.015, 0.02), trim);
    arm.position.x = 0.27;
    geos.push(arm.geometry);
    piv.add(arm);
    piv.rotation.x = -Math.atan2(def.glass[0][0] - def.glass[1][0], def.glass[1][1] - def.glass[0][1]);
    body.add(piv);
    wipers.push(piv);
  }

  const headlightAnchor = new THREE.Object3D();
  headlightAnchor.position.set(0, hlY, L + 0.1);
  body.add(headlightAnchor);

  return {
    root,
    body,
    wheels,
    spinners,
    headlightMat,
    tailMat,
    interior,
    steeringWheel: sw,
    wipers,
    paint,
    headlightAnchor,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
