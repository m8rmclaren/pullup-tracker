import { useEffect, useState } from 'preact/hooks';
import { msUntilNextDay } from '../shared/time';
import type { Tracker } from './tracker';

export function useTracker(tracker: Tracker): number {
  const [version, setVersion] = useState(0);
  useEffect(() => tracker.subscribe(() => setVersion((previousVersion) => previousVersion + 1)), [tracker]);
  return version;
}

/** Current time, refreshed every minute, at midnight in `timeZone`, and when the app is foregrounded. */
export function useNow(timeZone: string): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const minuteInterval = setInterval(tick, 60_000);
    const midnightTimeout = setTimeout(tick, msUntilNextDay(now, timeZone) + 500);
    const onVisibilityChange = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(minuteInterval);
      clearTimeout(midnightTimeout);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [now, timeZone]);
  return now;
}

export function haptic(durationMs = 10): void {
  try {
    navigator.vibrate?.(durationMs);
  } catch {}
}
