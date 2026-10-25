/**
 * Painted 2D preview cards for the map picker – layered silhouettes, a sun
 * and a winding road, in each biome's palette. Drawn once to small canvases.
 */
import { BIOMES } from '../world/Biomes';
import { Noise, RNG } from '../core/rng';

function ridge(g: CanvasRenderingContext2D, w: number, h: number, base: number, amp: number, freq: number, color: string, n: Noise, seed: number, jag: number): void {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(0, h);
  for (let x = 0; x <= w; x += 2) {
    const t = x / w;
    let y = base - amp * (0.5 + 0.5 * n.fbm(t * freq + seed, seed * 0.37, 3));
    if (jag > 0) y -= amp * jag * Math.pow(Math.max(0, n.ridged(t * freq * 1.7 + seed, seed, 2) - 0.4), 2) * 2;
    g.lineTo(x, y);
  }
  g.lineTo(w, h);
  g.closePath();
  g.fill();
}

export function paintPreview(canvas: HTMLCanvasElement, biome: number): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = 320;
  const h = 200;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  const n = new Noise(1000 + biome * 17);
  const rng = new RNG(77 + biome);
  if (biome < 0) {
    // auto journey: diagonal slices of every region
    const slices = BIOMES.length;
    for (let i = 0; i < slices; i++) {
      const off = document.createElement('canvas');
      paintPreview(off, i);
      g.save();
      g.beginPath();
      const x0 = (i / slices) * w * 1.4 - w * 0.2;
      const x1 = ((i + 1) / slices) * w * 1.4 - w * 0.2;
      g.moveTo(x0 + 40, 0);
      g.lineTo(x1 + 40, 0);
      g.lineTo(x1 - 40, h);
      g.lineTo(x0 - 40, h);
      g.closePath();
      g.clip();
      g.drawImage(off, 0, 0, w, h);
      g.restore();
    }
    g.fillStyle = 'rgba(0,0,0,0.15)';
    g.fillRect(0, 0, w, h);
    return;
  }
  const p = BIOMES[biome].preview;
  const sky = g.createLinearGradient(0, 0, 0, h * 0.75);
  sky.addColorStop(0, p.sky[0]);
  sky.addColorStop(1, p.sky[1]);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  // sun / moon
  const sx = w * (0.62 + rng.next() * 0.25);
  const sy = h * (0.22 + rng.next() * 0.15);
  const sun = g.createRadialGradient(sx, sy, 0, sx, sy, 60);
  sun.addColorStop(0, 'rgba(255,250,235,0.95)');
  sun.addColorStop(0.15, 'rgba(255,245,220,0.6)');
  sun.addColorStop(1, 'rgba(255,240,210,0)');
  g.fillStyle = sun;
  g.fillRect(0, 0, w, h);
  const m = BIOMES[biome].mountains;
  ridge(g, w, h, h * 0.62, h * 0.45 * m.height + 8, 2.2, p.far, n, 3, m.jagged * 0.8);
  if (BIOMES[biome].skyline) {
    // little skyline with twin towers
    g.fillStyle = p.mid;
    for (let i = 0; i < 26; i++) {
      const x = 30 + i * 9 + rng.next() * 4;
      const bh = 8 + rng.next() * 16;
      g.fillRect(x, h * 0.62 - bh, 8, bh);
    }
    g.fillRect(140, h * 0.62 - 40, 6, 40);
    g.fillRect(152, h * 0.62 - 40, 6, 40);
    g.beginPath();
    g.moveTo(200, h * 0.62 - 26);
    g.lineTo(203, h * 0.62 - 58);
    g.lineTo(206, h * 0.62 - 26);
    g.fill();
    g.fillStyle = p.accent;
    for (let i = 0; i < 40; i++) g.fillRect(30 + rng.next() * 220, h * 0.62 - rng.next() * 20, 1.5, 1.5);
  }
  ridge(g, w, h, h * 0.72, h * 0.18, 3.5, p.mid, n, 9, 0);
  // lake band
  if (BIOMES[biome].boats > 0) {
    const lake = g.createLinearGradient(0, h * 0.7, 0, h * 0.82);
    lake.addColorStop(0, p.mid);
    lake.addColorStop(1, p.sky[0]);
    g.fillStyle = lake;
    g.fillRect(0, h * 0.7, w, h * 0.09);
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.beginPath();
    g.moveTo(w * 0.3, h * 0.75);
    g.lineTo(w * 0.31, h * 0.7);
    g.lineTo(w * 0.32, h * 0.75);
    g.fill();
  }
  ridge(g, w, h, h * 0.86, h * 0.12, 1.4, p.near, n, 17, 0);
  // trees
  g.fillStyle = 'rgba(20,40,20,0.55)';
  for (let i = 0; i < 14; i++) {
    const x = rng.next() * w;
    const y = h * (0.8 + rng.next() * 0.08);
    const s = 4 + rng.next() * 6;
    g.beginPath();
    g.moveTo(x, y - s * 2.2);
    g.lineTo(x - s * 0.7, y);
    g.lineTo(x + s * 0.7, y);
    g.fill();
  }
  // road
  g.strokeStyle = '#3d3f44';
  g.lineWidth = 16;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(w * 0.15, h + 10);
  g.bezierCurveTo(w * 0.45, h * 0.92, w * 0.35, h * 0.84, w * 0.62, h * 0.8);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = 1.2;
  g.setLineDash([5, 7]);
  g.stroke();
  g.setLineDash([]);
  // accent (chalet / flag)
  g.fillStyle = p.accent;
  g.fillRect(w * 0.76, h * 0.8, 12, 9);
  g.beginPath();
  g.moveTo(w * 0.76 - 3, h * 0.8);
  g.lineTo(w * 0.76 + 6, h * 0.8 - 7);
  g.lineTo(w * 0.76 + 15, h * 0.8);
  g.fill();
}
