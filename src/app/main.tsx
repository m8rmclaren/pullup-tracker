import { render } from 'preact';
import { fetchTransport } from './api';
import { App } from './App';
import { Tracker } from './tracker';
import './styles.css';

const tracker = new Tracker({ storage: localStorage, transport: fetchTransport });

// No background-sync API on iOS, so sync opportunistically whenever the app is likely to have signal.
const syncUnlessSignedOut = () => tracker.status !== 'auth' && void tracker.syncNow();
window.addEventListener('online', syncUnlessSignedOut);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && syncUnlessSignedOut());
setInterval(() => document.visibilityState === 'visible' && syncUnlessSignedOut(), 60_000);
syncUnlessSignedOut();

render(<App tracker={tracker} />, document.getElementById('app')!);

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}
