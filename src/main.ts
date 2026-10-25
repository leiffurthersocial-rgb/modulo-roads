/**
 * Modulo Roads – entry point.
 * Checks for WebGL, registers the service worker (offline + Add to Home
 * Screen), and boots the game.
 */
import './ui/styles.css';
import { Game } from './Game';

function fatal(msg: string): void {
  const ui = document.getElementById('ui')!;
  ui.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:40px;pointer-events:auto">
    <div><div style="font-size:22px;margin-bottom:10px">Modulo Roads can't start</div>
    <div style="color:rgba(255,255,255,.65);font-size:14px;max-width:420px;line-height:1.5">${msg}</div></div></div>`;
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// Stop iOS rubber-banding / pinch zoom while driving.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener(
  'touchmove',
  (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('.tab-pane, .trip-list, .help-grid, .start')) e.preventDefault();
  },
  { passive: false },
);
document.addEventListener('contextmenu', (e) => e.preventDefault());

if (!hasWebGL()) {
  fatal('Your browser does not support WebGL. Try a recent Safari, Chrome, Edge or Firefox.');
} else {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  try {
    const game = new Game(canvas, ui);
    (window as unknown as { game: Game }).game = game;
    game.boot().catch((err) => {
      console.error(err);
      fatal(String(err?.message ?? err));
    });
  } catch (err) {
    console.error(err);
    fatal(String((err as Error)?.message ?? err));
  }
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
