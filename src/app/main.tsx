import { render } from 'preact';
import { fetchTransport } from './api';
import { App } from './App';
import { Tracker } from './tracker';
import './styles.css';

const tracker = new Tracker({ storage: localStorage, transport: fetchTransport });

// No background-sync API on iOS, so sync opportunistically whenever the app is likely to have signal.
const kick = () => tracker.status !== 'auth' && void tracker.syncNow();
window.addEventListener('online', kick);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && kick());
setInterval(() => document.visibilityState === 'visible' && kick(), 60_000);
kick();

render(<App tracker={tracker} />, document.getElementById('app')!);

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
}
