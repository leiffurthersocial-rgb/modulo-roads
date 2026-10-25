/**
 * Low Battery Mode support: Battery Status API where available (Chrome,
 * Edge) with a graceful fallback (Safari/iPad has no API – the player toggles
 * the mode manually, and we suggest it when frame times stay high).
 */
interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
}

export class BatteryWatcher {
  supported = false;
  level = 1;
  charging = true;
  private suggested = false;
  private slowFrames = 0;
  onSuggest: ((reason: string) => void) | null = null;

  async init(): Promise<void> {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    if (!nav.getBattery) return;
    try {
      const b = await nav.getBattery();
      this.supported = true;
      const update = () => {
        this.level = b.level;
        this.charging = b.charging;
        this.check();
      };
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
      update();
    } catch {
      this.supported = false;
    }
  }

  private check(): void {
    if (this.suggested) return;
    if (!this.charging && this.level <= 0.3) {
      this.suggested = true;
      this.onSuggest?.(`Battery at ${Math.round(this.level * 100)}%`);
    }
  }

  /** Fallback heuristic: sustained slow frames on a touch device. */
  reportFrame(ms: number, touch: boolean): void {
    if (this.suggested || this.supported || !touch) return;
    if (ms > 24) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 2);
    if (this.slowFrames > 600) {
      this.suggested = true;
      this.onSuggest?.('Running warm');
    }
  }

  reset(): void {
    this.suggested = false;
  }
}
