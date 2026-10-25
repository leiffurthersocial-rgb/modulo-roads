/**
 * Growable vertex/index buffers for building merged meshes (road chunks,
 * bridges, prop models). Each vertex has position, normal, colour, uv.
 */
import * as THREE from 'three';

export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  r = 1;
  g = 1;
  b = 1;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  color(c: THREE.Color | number): this {
    if (typeof c === 'number') {
      const t = TMP_C.setHex(c);
      this.r = t.r;
      this.g = t.g;
      this.b = t.b;
    } else {
      this.r = c.r;
      this.g = c.g;
      this.b = c.b;
    }
    return this;
  }
  rgb(r: number, g: number, b: number): this {
    this.r = r;
    this.g = g;
    this.b = b;
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(this.r, this.g, this.b);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Quad from 4 points (counter-clockwise when seen from the front) with flat normal. */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
  ): void {
    // normal = (b - a) x (d - a)
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = dx - ax, vy = dy - ay, vz = dz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const i0 = this.vertex(ax, ay, az, nx, ny, nz, 0, 0);
    this.vertex(bx, by, bz, nx, ny, nz, 1, 0);
    this.vertex(cx, cy, cz, nx, ny, nz, 1, 1);
    this.vertex(dx, dy, dz, nx, ny, nz, 0, 1);
    this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  }

  /**
   * Oriented box centred at (cx, cy, cz) with half extents along a local
   * frame: forward (fx, fz) in the XZ plane, up = +Y.
   */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, fx = 0, fz = 1, taper = 1): void {
    // right = (-fz, fx)?  Using right = (fz, -fx) so that x axis maps consistently.
    const rx = fz;
    const rz = -fx;
    const pts: number[] = [];
    for (let k = 0; k < 8; k++) {
      const sx = k & 1 ? 1 : -1;
      const sy = k & 2 ? 1 : -1;
      const sz = k & 4 ? 1 : -1;
      const tp = sy > 0 ? taper : 1;
      const lx = sx * hx * tp;
      const lz = sz * hz * tp;
      pts.push(cx + rx * lx + fx * lz, cy + sy * hy, cz + rz * lx + fz * lz);
    }
    const P = (i: number) => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]] as const;
    const face = (a: number, b: number, c: number, d: number) => {
      const A = P(a), B = P(b), C = P(c), D = P(d);
      this.quad(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2]);
    };
    // corners: bit0 = +x(right), bit1 = +y, bit2 = +z(forward)
    face(2, 6, 7, 3); // top (+y)
    face(0, 1, 5, 4); // bottom
    face(4, 5, 7, 6); // front (+z)
    face(1, 0, 2, 3); // back
    face(5, 1, 3, 7); // right? (+x)
    face(0, 4, 6, 2); // left
  }

  /** Append a three.js geometry transformed by `m`, tinted with the current colour. */
  geometry(geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const g = geo.index ? geo : geo;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const uvA = g.getAttribute('uv');
    const nm = TMP_N.getNormalMatrix(m);
    const base = this.vertexCount;
    for (let i = 0; i < p.count; i++) {
      TMP_V.fromBufferAttribute(p, i).applyMatrix4(m);
      if (n) TMP_V2.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      else TMP_V2.set(0, 1, 0);
      this.vertex(TMP_V.x, TMP_V.y, TMP_V.z, TMP_V2.x, TMP_V2.y, TMP_V2.z, uvA ? uvA.getX(i) : 0, uvA ? uvA.getY(i) : 0);
    }
    if (g.index) {
      const ix = g.index;
      for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    } else {
      for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    }
  }

  /** Convenience: primitive at position/rotation/scale. */
  prim(geo: THREE.BufferGeometry, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, ry = 0, rx = 0, rz = 0): void {
    TMP_E.set(rx, ry, rz);
    TMP_Q.setFromEuler(TMP_E);
    TMP_M.compose(TMP_V3.set(x, y, z), TMP_Q, TMP_S.set(sx, sy, sz));
    this.geometry(geo, TMP_M);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    const vc = this.vertexCount;
    geo.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  clear(): void {
    this.pos.length = 0;
    this.nor.length = 0;
    this.col.length = 0;
    this.uv.length = 0;
    this.idx.length = 0;
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }
}

const TMP_C = new THREE.Color();
const TMP_V = new THREE.Vector3();
const TMP_V2 = new THREE.Vector3();
const TMP_V3 = new THREE.Vector3();
const TMP_S = new THREE.Vector3();
const TMP_N = new THREE.Matrix3();
const TMP_M = new THREE.Matrix4();
const TMP_Q = new THREE.Quaternion();
const TMP_E = new THREE.Euler();
