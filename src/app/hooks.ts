import { useEffect, useState } from 'preact/hooks';
import { msUntilNextDay } from '../shared/time';
import type { Tracker } from './tracker';

export function useTracker(tracker: Tracker): number {
  const [version, setVersion] = useState(0);
  useEffect(() => tracker.subscribe(() => setVersion((n) => n + 1)), [tracker]);
  return version;
}

/** Current time, refreshed every minute, at Denver midnight, and when the app is foregrounded. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const minute = setInterval(tick, 60_000);
    const midnight = setTimeout(tick, msUntilNextDay(now) + 500);
    const onVis = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(minute);
      clearTimeout(midnight);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [now]);
  return now;
}

export function haptic(ms = 10): void {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}
