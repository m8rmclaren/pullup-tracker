import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Entry, formatLbs } from '../shared/model';
import { computeStats, usualReps } from '../shared/stats';
import { dayKey, formatDay } from '../shared/time';
import { parseInviteLink } from './api';
import { useNow, useTracker } from './hooks';
import { DaySheet, EntrySheet, JoinSheet, PadWeightSheet, type PendingInvite, SettingsSheet } from './sheets';
import { Today } from './Today';
import type { Tracker } from './tracker';
import { Trends } from './Trends';

type SheetState =
  | { kind: 'add'; day?: string }
  | { kind: 'edit'; entry: Entry }
  | { kind: 'day'; day: string }
  | { kind: 'settings' }
  | { kind: 'weight' }
  | { kind: 'join'; invite: PendingInvite }
  | null;

interface Toast {
  id: number;
  text: string;
  undo: () => void;
}

const TOAST_MS = 5000;

export function App({ tracker }: { tracker: Tracker }) {
  const version = useTracker(tracker);
  const now = useNow();
  const [tab, setTab] = useState<'today' | 'trends'>('today');
  const [sheet, setSheet] = useState<SheetState>(() => {
    // An opened invite link lands here; the code is taken out of the URL so a reload or a
    // shared screenshot doesn't carry it along.
    const invite = parseInviteLink(location.hash);
    if (!invite) return null;
    history.replaceState(null, '', location.pathname + location.search);
    return { kind: 'join', invite };
  });
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const entries = useMemo(() => tracker.all(), [tracker, version]);
  const goal = tracker.settings.goal;
  const stats = useMemo(() => computeStats(entries, now, goal), [entries, now, goal]);
  const usual = useMemo(() => usualReps(entries, now), [entries, now]);

  const showToast = useCallback((text: string, undo: () => void) => {
    clearTimeout(toastTimer.current);
    const id = Date.now();
    setToast({ id, text, undo });
    toastTimer.current = setTimeout(() => setToast((t) => (t?.id === id ? null : t)), TOAST_MS);
  }, []);

  const onLogged = useCallback(
    (e: Entry) => {
      const when = dayKey(e.ts) === dayKey(Date.now()) ? '' : ` on ${formatDay(dayKey(e.ts))}`;
      showToast(`Logged ${e.reps}${e.lbs ? ` @ ${formatLbs(e.lbs)}` : ''}${when}`, () => tracker.remove(e.id));
    },
    [tracker, showToast],
  );
  const onDeleted = useCallback((e: Entry) => showToast(`Deleted set of ${e.reps}`, () => tracker.restore(e.id)), [tracker, showToast]);
  const close = useCallback(() => setSheet(null), []);

  useEffect(() => {
    document.title = `${stats.today.reps} · Pull-ups`;
  }, [stats.today.reps]);

  return (
    <div class="app">
      <header class="topbar">
        <div class="topbar__date">
          <span class="topbar__dow">{formatDay(dayKey(now), { weekday: true }).split(',')[0]}</span>
          <span>{formatDay(dayKey(now))}</span>
        </div>
        <button type="button" class={`sync-pill sync-pill--${tracker.status}`} onClick={() => setSheet({ kind: 'settings' })} aria-label="Sync status and settings">
          <i class="dot" />
          <span>{pillText(tracker)}</span>
          <svg viewBox="0 0 24 24" class="gear" aria-hidden="true">
            <path d="M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm7.43-2.53c.04-.32.07-.64.07-.97s-.03-.66-.07-1l2.11-1.63a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.3 7.3 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.58-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64L4.57 11c-.04.34-.07.67-.07 1s.03.65.07.97l-2.11 1.66a.49.49 0 0 0-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65a7.3 7.3 0 0 0 1.69-.98l2.49 1.01c.22.08.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.66Z" />
          </svg>
        </button>
      </header>

      <main class="main">
        {tab === 'today' ? (
          <Today
            tracker={tracker}
            stats={stats}
            now={now}
            usual={usual}
            onLogged={onLogged}
            onEdit={(entry) => setSheet({ kind: 'edit', entry })}
            onCustom={() => setSheet({ kind: 'add' })}
            onSetup={() => setSheet({ kind: 'settings' })}
            onWeight={() => setSheet({ kind: 'weight' })}
          />
        ) : (
          <Trends entries={entries} stats={stats} now={now} goal={goal} onOpenDay={(day) => setSheet({ kind: 'day', day })} />
        )}
      </main>

      {toast ? (
        <div class="toast" role="status" key={toast.id}>
          <span>{toast.text}</span>
          <button
            type="button"
            onClick={() => {
              toast.undo();
              setToast(null);
            }}
          >
            Undo
          </button>
        </div>
      ) : null}

      <nav class="tabbar" aria-label="Views">
        <button type="button" class={tab === 'today' ? 'is-on' : ''} aria-current={tab === 'today'} onClick={() => setTab('today')}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6h18M7 6v4a5 5 0 0 0 10 0V6" />
          </svg>
          Today
        </button>
        <button type="button" class={tab === 'trends' ? 'is-on' : ''} aria-current={tab === 'trends'} onClick={() => setTab('trends')}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
          </svg>
          Trends
        </button>
      </nav>

      {sheet?.kind === 'add' ? (
        <EntrySheet tracker={tracker} day={sheet.day} defaultReps={usual ?? 5} defaultLbs={tracker.padLbs(dayKey(now))} now={now} onClose={close} onLogged={onLogged} />
      ) : null}
      {sheet?.kind === 'edit' ? (
        <EntrySheet tracker={tracker} entry={tracker.get(sheet.entry.id) ?? sheet.entry} defaultReps={sheet.entry.reps} now={now} onClose={close} onDeleted={onDeleted} />
      ) : null}
      {sheet?.kind === 'day' ? (
        <DaySheet
          tracker={tracker}
          day={sheet.day}
          goal={goal}
          onClose={close}
          onEdit={(entry) => setSheet({ kind: 'edit', entry })}
          onAdd={() => setSheet({ kind: 'add', day: sheet.day })}
        />
      ) : null}
      {sheet?.kind === 'settings' ? <SettingsSheet tracker={tracker} onClose={close} onOpenInvite={(invite) => setSheet({ kind: 'join', invite })} /> : null}
      {sheet?.kind === 'join' ? <JoinSheet tracker={tracker} invite={sheet.invite} onClose={close} /> : null}
      {sheet?.kind === 'weight' ? <PadWeightSheet tracker={tracker} now={now} onClose={close} /> : null}
    </div>
  );
}

function pillText(t: Tracker): string {
  const n = t.pendingCount();
  switch (t.status) {
    case 'synced':
      return 'Synced';
    case 'syncing':
      return 'Syncing';
    case 'pending':
      return `${n} pending`;
    case 'offline':
      return n ? `Offline · ${n}` : 'Offline';
    case 'auth':
      return 'Signed out';
    case 'unconfigured':
      return 'Sign in';
  }
}
