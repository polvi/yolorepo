import { runCallback } from '../lib/tpx';

// Runs in the popup the panel opened for the grant. Tokens land in
// localStorage (shared with the panel via the site origin); the panel
// notices through the storage event.

const status = document.getElementById('status')!;

runCallback().then((error) => {
  if (error) {
    status.textContent = `${error} You can close this window.`;
    return;
  }
  status.textContent = 'Connected. Returning to the editor…';
  setTimeout(() => window.close(), 400);
});
