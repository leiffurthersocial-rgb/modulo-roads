/**
 * Camera modes with soft, spring-based smoothing, gentle sway, and FOV that
 * widens with speed. Also drives the free orbit and photo-mode cameras.
 */
import * as THREE from 'three';
import type { CameraMode } from '../core/Settings';
import type { Vehicle } from './Vehicle';
import { clamp, damp, dampAngle, lerp } from '../core/math';

const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const Q = new THREE.Quaternion();
const E = new THREE.Euler(0, 0, 0, 'YXZ');

export class CameraRig {
  mode: CameraMode = 'chase';
  baseFov = 62;
  smoothing = 0.6;
  sway = 0.5;
  speedFov = true;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private yawFollow = 0;
  private rollS = 0;
  private fovS = 62;
  private initialised = false;
  // orbit / photo
  orbitYaw = 0.6;
  orbitPitch = 0.25;
  orbitDist = 9;
  private orbitIdle = 0;
  photo = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
  ) {
    dom.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'orbit' && !this.photo) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.orbitYaw -= (e.clientX - this.lastX) * 0.006;
      this.orbitPitch = clamp(this.orbitPitch + (e.clientY - this.lastY) * 0.004, -0.15, 1.3);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.orbitIdle = 0;
    });
    const end = () => (this.dragging = false);
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'orbit' && !this.photo) return;
        this.orbitDist = clamp(this.orbitDist * (1 + e.deltaY * 0.001), 3.5, 40);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  reset(): void {
    this.initialised = false;
  }

  /** Keyboard orbit control (photo mode). */
  nudgeOrbit(dyaw: number, dpitch: number, dzoom: number): void {
    this.orbitYaw += dyaw;
    this.orbitPitch = clamp(this.orbitPitch + dpitch, -0.15, 1.3);
    this.orbitDist = clamp(this.orbitDist * (1 + dzoom), 3.5, 40);
    this.orbitIdle = 0;
  }

  update(dt: number, car: Vehicle, topSpeed: number): void {
    const cam = this.camera;
    const m = car.model.root;
    const h = car.heading;
    const sh = Math.sin(h);
    const ch = Math.cos(h);
    const speed = Math.abs(car.speed);
    const sp01 = clamp(speed / topSpeed, 0, 1);
    const inside = !this.photo && (this.mode === 'cockpit' || this.mode === 'hood' || this.mode === 'bumper');
    car.model.interior.visible = !this.photo && this.mode === 'cockpit';

    // smoothing strength (0 = rigid, 1 = very floaty)
    const sm = this.smoothing;
    if (!this.initialised) {
      this.yawFollow = h;
      this.initialised = true;
      this.pos.set(m.position.x - sh * 7, m.position.y + 2.5, m.position.z - ch * 7);
      this.look.copy(m.position);
    }

    let fovTarget = this.baseFov + (this.speedFov && !this.photo ? sp01 * sp01 * 14 : 0);

    if (this.photo || this.mode === 'orbit') {
      this.orbitIdle += dt;
      if (!this.photo && this.orbitIdle > 4) this.orbitYaw += dt * 0.08; // slow auto-rotate when idle
      const yaw = h + Math.PI + this.orbitYaw;
      const cp = Math.cos(this.orbitPitch);
      TMP.set(Math.sin(yaw) * cp * this.orbitDist, Math.sin(this.orbitPitch) * this.orbitDist + 1.0, Math.cos(yaw) * cp * this.orbitDist).add(m.position);
      this.pos.lerp(TMP, damp(this.photo ? 10 : 6, dt));
      TMP2.set(m.position.x, m.position.y + 1.0, m.position.z);
      this.look.lerp(TMP2, damp(12, dt));
      cam.position.copy(this.pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
      fovTarget = this.photo ? this.baseFov : fovTarget;
    } else if (inside) {
      // rigidly attached to the body, with a little lag on yaw for comfort
      const local =
        this.mode === 'cockpit'
          ? TMP.set(car.def.eye[0], car.def.eye[1], car.def.eye[2])
          : this.mode === 'hood'
            ? TMP.set(0, car.def.height * 0.86, car.def.length * 0.12)
            : TMP.set(0, 0.55, car.def.length / 2 + 0.25);
      car.model.body.updateMatrixWorld(true);
      local.applyMatrix4(car.model.body.matrixWorld);
      cam.position.copy(local);
      E.setFromQuaternion(car.model.body.getWorldQuaternion(Q), 'YXZ');
      this.yawFollow = dampAngle(this.yawFollow, h, lerp(30, 9, sm), dt);
      const swayRoll = clamp(car.lateral * 0.004, -0.05, 0.05) * this.sway;
      this.rollS = lerp(this.rollS, swayRoll, damp(5, dt));
      E.set(-E.x * 0.7, this.yawFollow + Math.PI, -E.z * 0.6 + this.rollS, 'YXZ');
      // three cameras look down −Z: rotate by π so the camera faces the car's +Z
      cam.quaternion.setFromEuler(E);
      // cockpit FOV a touch wider
      if (this.mode === 'cockpit') fovTarget += 8;
    } else {
      const far = this.mode === 'far';
      const dist = (far ? 12 : 6.4) + car.def.length * 0.25 + sp01 * (far ? 2 : 1.2);
      const height = (far ? 4.6 : 2.3) + car.def.height * 0.35;
      // follow the direction of travel (so drifts are visible) and lag a little
      const velHeading = speed > 3 ? Math.atan2(car.vx, car.vz) : h;
      const reverse = car.speed < -1;
      const followTarget = reverse ? h : dampAngle(h, velHeading, 1, 0.35);
      this.yawFollow = dampAngle(this.yawFollow, followTarget, lerp(10, 2.4, sm), dt);
      const yf = this.yawFollow;
      TMP.set(m.position.x - Math.sin(yf) * dist, m.position.y + height, m.position.z - Math.cos(yf) * dist);
      // keep the camera above ground
      const k = damp(lerp(25, 5, sm), dt);
      this.pos.lerp(TMP, k);
      TMP2.set(m.position.x + sh * 3, m.position.y + 1.0 + car.def.height * 0.2, m.position.z + ch * 3);
      this.look.lerp(TMP2, damp(lerp(30, 9, sm), dt));
      cam.position.copy(this.pos);
      // subtle bob from suspension
      cam.position.y += car.model.body.position.y * 0.5;
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
      const swayRoll = clamp(-car.lateral * 0.0035, -0.045, 0.045) * this.sway;
      this.rollS = lerp(this.rollS, swayRoll, damp(3, dt));
      cam.rotateZ(this.rollS);
    }
    this.fovS = lerp(this.fovS, fovTarget, damp(3, dt));
    const near = inside ? 0.05 : 0.3;
    if (Math.abs(cam.fov - this.fovS) > 0.01 || cam.near !== near) {
      cam.fov = this.fovS;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
  }

  /** Keep the chase camera from dipping under terrain. */
  clampAbove(groundY: number): void {
    if (this.camera.position.y < groundY + 0.6) {
      this.camera.position.y = groundY + 0.6;
      this.pos.y = Math.max(this.pos.y, groundY + 0.6);
    }
  }
}
