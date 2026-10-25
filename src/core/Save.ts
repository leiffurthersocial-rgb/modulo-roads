/**
 * Persistence: a defensive localStorage wrapper plus the journey save
 * ("Continue") and the trip log.
 */

const PREFIX = 'moduloRoads.';

export const storage = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* private mode / quota – the game still works, it just forgets */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
};

/** Map selection: a biome index (0..7) or -1 for Auto journey. */
export type MapChoice = number;

export interface JourneySave {
  seed: string;
  map: MapChoice;
  distance: number; // metres along the route where the car is
  odometer: number; // metres driven this journey (incl. reversing etc.)
  time: number; // seconds driven
  topSpeed: number; // m/s
  regions: string[];
  timeOfDay: number;
  startedAt: number; // epoch ms
}

export interface TripEntry {
  date: number;
  seed: string;
  map: MapChoice;
  distance: number;
  time: number;
  topSpeed: number;
  regions: string[];
}

const JOURNEY_KEY = 'journey.v1';
const TRIPS_KEY = 'trips.v1';
const MAX_TRIPS = 40;

export const saves = {
  loadJourney(): JourneySave | null {
    const j = storage.get<JourneySave>(JOURNEY_KEY);
    if (!j || typeof j.seed !== 'string' || typeof j.distance !== 'number') return null;
    return j;
  },
  saveJourney(j: JourneySave): void {
    storage.set(JOURNEY_KEY, j);
  },
  clearJourney(): void {
    storage.remove(JOURNEY_KEY);
  },
  trips(): TripEntry[] {
    return storage.get<TripEntry[]>(TRIPS_KEY) ?? [];
  },
  /** Add or update the trip log entry for the journey that started at `startedAt`. */
  logTrip(entry: TripEntry, startedAt: number): void {
    if (entry.distance < 50) return; // ignore journeys that never really started
    const list = saves.trips();
    const idx = list.findIndex((t) => t.date === startedAt);
    const e = { ...entry, date: startedAt };
    if (idx >= 0) list[idx] = e;
    else list.unshift(e);
    storage.set(TRIPS_KEY, list.slice(0, MAX_TRIPS));
  },
  clearTrips(): void {
    storage.remove(TRIPS_KEY);
  },
};
