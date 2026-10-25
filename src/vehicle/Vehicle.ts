/**
 * Soft arcade vehicle physics, tuned for feel rather than realism:
 *  - world-space velocity with a capped lateral tyre force → natural,
 *    controllable drifts when you push (or pull the handbrake)
 *  - speed-sensitive steering and an optional steering assist that
 *    counter-steers gently when the rear steps out
 *  - automatic or manual gearbox (drives rpm for audio)
 *  - spring-damper suspension visuals: squat, dive, roll and bob
 *  - gentle airtime over crests, grade affects speed
 *  - cruise control and lane-keeping auto-drive
 *  - automatic recovery if you leave the road for too long
 * Runs at a fixed 120 Hz step with zero allocations.
 */
import * as THREE from 'three';
import type { World, Ground } from '../world/World';
import { RoadFrame, DS } from '../world/Road';
import { CarDef, CarModel, buildCar } from './Cars';
import { clamp, damp, dampTo, lerp, wrapAngle } from '../core/math';

export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number; // -1 left .. 1 right
  handbrake: boolean;
  boost: boolean;
}

const G = 9.81;
const SURF_GRIP: Record<string, number> = { asphalt: 1, bridge: 1, tunnel: 1, gravel: 0.78, grass: 0.62, water: 0.35 };
const SURF_ROLL: Record<string, number> = { asphalt: 0.12, bridge: 0.12, tunnel: 0.12, gravel: 0.55, grass: 1.3, water: 3 };

export class Vehicle {
  def: CarDef;
  model: CarModel;
  readonly pos = new THREE.Vector3();
  heading = 0;
  vx = 0;
  vz = 0;
  vy = 0;
  yawRate = 0;
  steerAngle = 0;
  speed = 0; // signed forward speed (m/s)
  rpm = 800;
  gear = 1; // 0 = reverse, 1.. forward
  manual = false;
  slip = 0; // lateral slip speed (m/s) – tyre squeal / drift
  throttleOut = 0;
  surface: Ground['surface'] = 'asphalt';
  onGround = true;
  airTime = 0;
  hint = 0; // last road sample index
  roadS = 0;
  roadU = 0;
  shift = 0; // >0 briefly after a gear change (audio)
  // assists
  steeringSensitivity = 1;
  steeringAssist = 0.5;
  cruise = false;
  cruiseSpeed = 0;
  autoDrive = false;
  // suspension (visual): value/velocity pairs
  private heave = [0, 0];
  private pitch = [0, 0];
  private roll = [0, 0];
  private wheelSpin = 0;
  private lastAccel = 0;
  private lastLat = 0;
  private prevGroundY = 0;
  private stuckT = 0;
  private offRoadT = 0;
  /** Set when an automatic reset happened (UI shows a soft fade). */
  recovered = 0;
  private ground: Ground = { y: 0, surface: 'asphalt', wall: 0 };
  private frame = new RoadFrame();
  private probe: Ground = { y: 0, surface: 'asphalt', wall: 0 };
  private wiperT = 0;
  wipers = 0; // 0 off, 1 slow, 2 fast
  headlights = false;
  braking = false;

  constructor(
    def: CarDef,
    private world: World,
  ) {
    this.def = def;
    this.model = buildCar(def);
  }

  /** Re-bind to a freshly generated world (new journey). */
  setWorld(world: World): void {
    this.world = world;
  }

  setCar(def: CarDef): THREE.Group {
    const parent = this.model.root.parent;
    parent?.remove(this.model.root);
    this.model.dispose();
    this.def = def;
    this.model = buildCar(def);
    this.gear = Math.min(this.gear, def.gears.length);
    parent?.add(this.model.root);
    return this.model.root;
  }

  /** Place the car on the road at distance s, in the right-hand lane. */
  placeAt(s: number, keepSpeed = 0): void {
    const road = this.world.road;
    const F = road.frameAt(Math.max(s, road.baseIndex * DS + 4), this.frame);
    const u = road.halfWidth * 0.5;
    this.pos.set(F.x + F.rx * u, F.y + u * F.bank, F.z + F.rz * u);
    this.heading = F.heading;
    const sp = keepSpeed;
    this.vx = Math.sin(this.heading) * sp;
    this.vz = Math.cos(this.heading) * sp;
    this.vy = 0;
    this.yawRate = 0;
    this.steerAngle = 0;
    this.hint = F.i;
    this.prevGroundY = this.pos.y;
    this.stuckT = 0;
    this.offRoadT = 0;
    this.roadS = F.s;
  }

  /** Gentle reset (R key or automatic): back to the lane, facing forward. */
  recover(): void {
    const p = this.world.projectPoint(this.pos.x, this.pos.z, this.hint);
    this.placeAt(p.s, Math.max(0, Math.min(Math.abs(this.speed), 14)) * 0.6);
    this.recovered = 1;
  }

  shiftUp(): void {
    if (this.gear < this.def.gears.length) {
      this.gear++;
      this.shift = 0.25;
    }
  }
  shiftDown(): void {
    if (this.gear > 1) {
      this.gear--;
      this.shift = 0.25;
    }
  }

  /** Lane-keeping steer & speed (used for auto-drive and as gentle hints). */
  private autopilot(input: DriveInput): void {
    const road = this.world.road;
    const v = Math.max(4, Math.abs(this.speed));
    const look = clamp(v * 1.1, 9, 40);
    const F = road.frameAt(this.roadS + look, this.frame);
    const u = road.halfWidth * 0.5;
    const tx = F.x + F.rx * u - this.pos.x;
    const tz = F.z + F.rz * u - this.pos.z;
    const ang = wrapAngle(Math.atan2(tx, tz) - this.heading);
    // pure pursuit: positive ang = target to the left (heading increases left)
    const ld = Math.hypot(tx, tz);
    const delta = Math.atan((2 * this.def.wheelbase * Math.sin(ang)) / ld);
    input.steer = clamp(-delta / (this.maxSteer() || 1), -1, 1);
    // comfortable speed for the curvature ahead
    let kMax = 0;
    for (let d = 0; d <= 90; d += 10) kMax = Math.max(kMax, Math.abs(road.frameAt(this.roadS + d, this.frame).curv));
    const target = Math.min(this.cruise ? this.cruiseSpeed : 24, Math.sqrt(2.6 / Math.max(kMax, 1e-4)));
    const err = target - this.speed;
    input.throttle = clamp(err * 0.35, 0, 1);
    input.brake = clamp(-err * 0.2, 0, 1);
  }

  private maxSteer(): number {
    const v = Math.abs(this.speed);
    return (this.def.steer * this.steeringSensitivity) / (1 + v / 13);
  }

  /** Advance physics by dt (fixed step). */
  step(dt: number, input: DriveInput): void {
    const def = this.def;
    const world = this.world;

    // ---- driver aids
    if (this.autoDrive && Math.abs(input.steer) < 0.05 && input.brake < 0.05) this.autopilot(input);
    if (this.cruise && !this.autoDrive) {
      if (input.brake > 0.1) this.cruise = false;
      else {
        if (input.throttle > 0.1) this.cruiseSpeed = Math.min(def.topSpeed, this.cruiseSpeed + 1.4 * dt);
        const err = this.cruiseSpeed - this.speed;
        input.throttle = clamp(err * 0.4, 0, 1);
        input.brake = clamp(-err * 0.15, 0, 0.5);
      }
    }

    const sh = Math.sin(this.heading);
    const ch = Math.cos(this.heading);
    // forward f = (sh, ch); right r = (-ch, sh)
    let vf = this.vx * sh + this.vz * ch;
    let vs = -this.vx * ch + this.vz * sh;

    // ---- ground
    this.hint = world.ground(this.pos.x, this.pos.z, this.hint, this.ground);
    const gnd = this.ground;
    this.surface = gnd.surface;
    const grip = (SURF_GRIP[gnd.surface] ?? 1) * def.grip;
    const roll = SURF_ROLL[gnd.surface] ?? 0.2;

    // slope along the car (front/rear probes)
    const half = def.wheelbase / 2;
    world.ground(this.pos.x + sh * half, this.pos.z + ch * half, this.hint, this.probe);
    const yF = this.probe.y;
    world.ground(this.pos.x - sh * half, this.pos.z - ch * half, this.hint, this.probe);
    const yR = this.probe.y;
    const gradeF = (yF - yR) / def.wheelbase;

    // ---- steering
    const maxS = this.maxSteer();
    let target = -input.steer * maxS; // positive wheel angle = left (heading increases)
    if (this.steeringAssist > 0 && Math.abs(vf) > 3) {
      // counter-steer into slides, and soften steering at the limit
      const slipAngle = Math.atan2(vs, Math.abs(vf));
      target -= slipAngle * 0.6 * this.steeringAssist * Math.sign(vf);
    }
    const steerRate = Math.abs(input.steer) > 0.01 ? 4.2 : 6.5;
    this.steerAngle = dampTo(this.steerAngle, target, steerRate, dt);

    // ---- gearbox
    const gears = def.gears;
    const absV = Math.abs(vf);
    if (this.gear > 0) {
      if (!this.manual) {
        const top = gears[this.gear - 1];
        if (absV > top * 0.92 && this.gear < gears.length) {
          this.gear++;
          this.shift = 0.22;
        } else if (this.gear > 1 && absV < gears[this.gear - 2] * 0.62) {
          this.gear--;
          this.shift = 0.15;
        }
      }
    }
    const gTop = this.gear > 0 ? gears[this.gear - 1] : 8;
    const rpmTarget = def.idleRpm + clamp(absV / gTop, 0, 1.08) * (def.maxRpm - def.idleRpm);
    const free = def.idleRpm + input.throttle * (def.maxRpm - def.idleRpm) * 0.55;
    const engaged = this.onGround ? rpmTarget : lerp(rpmTarget, free, 0.6);
    this.rpm = dampTo(this.rpm, Math.max(engaged, absV < 2 ? lerp(def.idleRpm, free, 0.6) : def.idleRpm), 12, dt);
    if (this.shift > 0) this.shift -= dt;

    // ---- longitudinal
    let ax = 0;
    const wantReverse = input.brake > 0.1 && input.throttle < 0.05 && vf < 0.6;
    if (wantReverse) this.gear = 0;
    else if (this.gear === 0 && (input.throttle > 0.05 || vf > 0.5)) this.gear = 1;
    this.braking = false;
    if (this.onGround) {
      if (this.gear === 0) {
        // reverse
        if (input.brake > 0.05) ax -= input.brake * def.accel * 0.6 * (vf > -6 ? 1 : 0);
        if (input.throttle > 0.05) {
          ax += input.throttle * 7 * Math.sign(-vf);
          this.braking = true;
        }
      } else {
        const ratio = clamp(absV / gTop, 0, 1);
        const torque = 0.78 + 0.32 * Math.sin(Math.min(1, ratio) * Math.PI * 0.95);
        const gearMul = 1.25 - (this.gear - 1) * (0.55 / Math.max(1, gears.length - 1));
        const limiter = ratio > 0.99 && this.gear === gears.length ? 0 : 1;
        const boost = input.boost ? 1.4 : 1;
        ax += input.throttle * def.accel * torque * gearMul * limiter * boost * Math.min(1, grip + 0.15);
        if (input.brake > 0.05 && vf > 0.3) {
          ax -= input.brake * 9.5 * Math.min(1, grip + 0.1);
          this.braking = true;
        }
      }
      if (input.handbrake) {
        ax -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, 4.5);
        this.braking = true;
      }
      // rolling resistance, aero drag (top speed balance), engine braking
      const dragK = (def.accel * 0.82) / (def.topSpeed * def.topSpeed);
      ax -= dragK * vf * Math.abs(vf);
      ax -= Math.sign(vf) * Math.min(Math.abs(vf) / dt, roll + (input.throttle < 0.05 ? 0.35 : 0));
      // gravity along the slope
      ax -= G * clamp(gradeF, -0.4, 0.4) * 0.85;
    }
    this.throttleOut = input.throttle;
    vf += ax * dt;
    if (this.gear > 0 && vf < 0 && input.brake > 0.05 && !wantReverse) vf = Math.max(vf, 0);

    // ---- yaw & lateral
    if (this.onGround) {
      const latMax = G * grip * (input.handbrake ? 0.5 : 1.08);
      let rT = (vf * Math.tan(this.steerAngle)) / def.wheelbase;
      // understeer at the limit: cap the yaw rate the tyres can deliver
      const rMax = (latMax * 1.15) / Math.max(1, Math.abs(vf));
      rT = clamp(rT, -rMax, rMax);
      if (input.handbrake && Math.abs(vf) > 6) rT *= 1.35; // handbrake turn
      this.yawRate = dampTo(this.yawRate, rT, input.handbrake ? 3.5 : 7.5, dt);
      // lateral friction pulls velocity back in line with the heading
      const latNeed = Math.abs(vs) / dt;
      const latF = Math.min(latNeed, latMax * (Math.abs(vf) < 3 ? 3 : 1));
      vs -= Math.sign(vs) * latF * dt;
      this.slip = Math.abs(vs);
      this.lastLat = vf * this.yawRate;
    } else {
      this.yawRate *= 1 - damp(0.8, dt);
      this.slip = 0;
    }
    this.heading += this.yawRate * dt;
    this.lastAccel = ax;

    // recompose velocity in world space using the *old* basis so slides persist
    this.vx = vf * sh - vs * ch;
    this.vz = vf * ch + vs * sh;
    this.pos.x += this.vx * dt;
    this.pos.z += this.vz * dt;
    this.speed = vf;

    // ---- walls (tunnels, bridge parapets)
    if (gnd.wall !== 0) {
      const p = world.projectPoint(this.pos.x, this.pos.z, this.hint);
      const F = world.road.frameAt(p.s, this.frame);
      const push = gnd.wall;
      this.pos.x -= F.rx * push;
      this.pos.z -= F.rz * push;
      const vr = this.vx * F.rx + this.vz * F.rz;
      if (vr * push > 0) {
        this.vx -= F.rx * vr * 1.3;
        this.vz -= F.rz * vr * 1.3;
        this.vx *= 0.97;
        this.vz *= 0.97;
        // align heading with the road
        this.heading += wrapAngle(F.heading + (vf < 0 ? Math.PI : 0) - this.heading) * 0.08;
      }
    }

    // ---- vertical
    this.hint = world.ground(this.pos.x, this.pos.z, this.hint, this.ground);
    const yg = this.ground.y;
    const groundVy = (yg - this.prevGroundY) / dt;
    this.prevGroundY = yg;
    this.vy -= G * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y <= yg) {
      const impact = Math.max(0, groundVy - this.vy);
      if (!this.onGround && this.airTime > 0.08) this.heave[1] -= impact * 0.35 * (0.6 + def.softness);
      this.pos.y = yg;
      this.vy = clamp(groundVy, -30, 8);
      this.onGround = true;
      this.airTime = 0;
    } else if (this.pos.y - yg > 0.08) {
      this.onGround = false;
      this.airTime += dt;
    }

    // ---- road-relative tracking & recovery
    const pr = world.projectPoint(this.pos.x, this.pos.z, this.hint);
    this.roadS = pr.s;
    this.roadU = pr.u;
    const off = Math.abs(pr.u) - world.road.halfWidth;
    if (off > 32 || (gnd.surface === 'water' && this.pos.y < 0.2)) this.offRoadT += dt;
    else this.offRoadT = Math.max(0, this.offRoadT - dt);
    if (off > 4 && Math.abs(this.speed) < 0.8 && (input.throttle > 0.3 || input.brake > 0.3)) this.stuckT += dt;
    else this.stuckT = 0;
    if (this.offRoadT > 1.2 || this.stuckT > 3.5 || this.pos.y < -8) this.recover();

    // ---- suspension visuals (springs)
    const soft = def.softness;
    const kHeave = lerp(70, 28, soft);
    const kPitch = lerp(60, 22, soft);
    const zeta = lerp(0.45, 0.22, soft);
    const bump = gnd.surface === 'grass' ? 0.035 : gnd.surface === 'gravel' ? 0.02 : 0.004;
    const rough = (Math.random() - 0.5) * bump * Math.min(1, Math.abs(vf) / 10) * 60;
    this.spring(this.heave, 0, kHeave, zeta, rough, dt);
    this.spring(this.pitch, clamp(-this.lastAccel * 0.006 * (0.6 + soft), -0.06, 0.06), kPitch, zeta, 0, dt);
    this.spring(this.roll, clamp(this.lastLat * 0.0065 * (0.6 + soft), -0.08, 0.08), kPitch, zeta, 0, dt);
    this.wheelSpin += (vf / def.wheelRadius) * dt;
  }

  private spring(s: number[], target: number, k: number, zeta: number, force: number, dt: number): void {
    const c = 2 * Math.sqrt(k) * zeta;
    const a = -k * (s[0] - target) - c * s[1] + force;
    s[1] += a * dt;
    s[0] += s[1] * dt;
  }

  /** Sync the 3D model with the physics state (once per rendered frame). */
  updateModel(dt: number, time: number, rainy: number): void {
    const m = this.model;
    // terrain pitch/roll from probes
    const def = this.def;
    const sh = Math.sin(this.heading);
    const ch = Math.cos(this.heading);
    const half = def.wheelbase / 2;
    const w = this.world;
    w.ground(this.pos.x + sh * half, this.pos.z + ch * half, this.hint, this.probe);
    const yF = this.probe.y;
    w.ground(this.pos.x - sh * half, this.pos.z - ch * half, this.hint, this.probe);
    const yR = this.probe.y;
    const tr = def.track / 2;
    w.ground(this.pos.x - ch * tr, this.pos.z + sh * tr, this.hint, this.probe); // right side (r = (-ch, sh))
    const yRt = this.probe.y;
    w.ground(this.pos.x + ch * tr, this.pos.z - sh * tr, this.hint, this.probe);
    const yLt = this.probe.y;
    const tPitch = this.onGround ? Math.atan2(yF - yR, def.wheelbase) : -m.root.rotation.x;
    const tRoll = this.onGround ? Math.atan2(yRt - yLt, def.track) : 0;
    m.root.position.copy(this.pos);
    m.root.rotation.order = 'YXZ';
    m.root.rotation.y = this.heading;
    m.root.rotation.x = dampTo(m.root.rotation.x, -tPitch, 18, dt);
    m.root.rotation.z = dampTo(m.root.rotation.z, -tRoll, 18, dt);
    // body on springs
    m.body.position.y = this.heave[0] * 0.5;
    m.body.rotation.x = this.pitch[0];
    m.body.rotation.z = this.roll[0];
    // wheels
    for (let i = 0; i < 4; i++) {
      m.spinners[i].rotation.x = this.wheelSpin;
      if (i < 2) m.wheels[i].rotation.y = this.steerAngle;
    }
    m.steeringWheel.rotation.z = -this.steerAngle * 6;
    // lights
    m.tailMat.color.setRGB(this.braking ? 1.6 : this.headlights ? 0.7 : 0.35, 0.02, 0.02);
    m.headlightMat.color.setRGB(this.headlights ? 2.2 : 0.85, this.headlights ? 2.1 : 0.85, this.headlights ? 1.8 : 0.8);
    // wipers
    if (this.wipers > 0 || this.wiperT > 0) {
      const speed = this.wipers === 2 ? 2.2 : 1.2;
      this.wiperT += dt * speed;
      if (this.wipers === 0 && Math.sin(this.wiperT * Math.PI) < 0.02) this.wiperT = 0;
    }
    const sweep = Math.max(0, Math.sin(this.wiperT * Math.PI)) * 1.6;
    m.wipers[0].rotation.y = 0;
    m.wipers[0].rotation.z = sweep;
    m.wipers[1].rotation.z = sweep;
    void time;
    void rainy;
  }

  /** Lateral acceleration (for camera sway). */
  get lateral(): number {
    return this.lastLat;
  }
  get longitudinal(): number {
    return this.lastAccel;
  }
}
