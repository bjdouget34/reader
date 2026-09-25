// The dialog both converters use -- WMA to MP3 (wma-convert.js) and PDF to
// EPUB (pdf-to-epub.js) -- and what goes with a long job on a phone: keeping
// the screen on, and saying how long is left.
//
// One dialog, #convert in index.html. It asks first, since both jobs take
// minutes; then shows a bar, a line of progress and a Cancel button.

const $ = (sel) => document.querySelector(sel);

// "2 h 5 min", "12 min", "under a minute".
export function formatSpan(seconds) {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'under a minute';
  const min = Math.round(seconds / 60);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

// Time left, from how fast the job is actually going on this device rather
// than a guess. Nothing for the first few seconds, which are not typical.
export function timeLeft(fractionDone, elapsedSeconds) {
  if (!(fractionDone > 0) || elapsedSeconds <= 4) return '';
  const s = (elapsedSeconds * (1 - fractionDone)) / fractionDone;
  return s < 60 ? 'less than a minute left' : `about ${formatSpan(s)} left`;
}

// Resolves true for the go button, false for Cancel. The dialog stays open on
// go, ready for progress().
export function ask({ title, text, go, cancel = 'Cancel' }) {
  const root = $('#convert');
  const goBtn = $('#convert-go');
  const cancelBtn = $('#convert-cancel');
  $('#convert-title').textContent = title;
  $('#convert-text').textContent = text;
  $('#convert-progress').hidden = true;
  $('#convert-status').textContent = '';
  goBtn.textContent = go;
  goBtn.hidden = false;
  cancelBtn.textContent = cancel;
  root.hidden = false;
  goBtn.focus();
  return new Promise((resolve) => {
    const finish = (yes) => {
      goBtn.removeEventListener('click', onGo);
      cancelBtn.removeEventListener('click', onCancel);
      if (!yes) root.hidden = true;
      resolve(yes);
    };
    const onGo = () => finish(true);
    const onCancel = () => finish(false);
    goBtn.addEventListener('click', onGo);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// The dialog as a progress display. status(line, fraction) -- a fraction of
// null shows the bar as busy without a length. Cancel calls onCancel.
export function progress({ title, text, onCancel }) {
  const root = $('#convert');
  const bar = $('#convert-progress');
  const statusEl = $('#convert-status');
  const cancelBtn = $('#convert-cancel');
  $('#convert-go').hidden = true;
  $('#convert-title').textContent = title;
  $('#convert-text').textContent = text;
  cancelBtn.textContent = 'Cancel';
  bar.hidden = false;
  bar.removeAttribute('value');
  statusEl.textContent = '';
  root.hidden = false;
  const cancel = () => onCancel?.();
  cancelBtn.addEventListener('click', cancel);
  const screen = holdScreen();
  return {
    status(line, fraction = null) {
      statusEl.textContent = line;
      if (fraction == null) bar.removeAttribute('value');
      else { bar.max = 1; bar.value = Math.min(1, Math.max(0, fraction)); }
    },
    close() {
      cancelBtn.removeEventListener('click', cancel);
      screen.release();
      root.hidden = true;
    },
  };
}

// Keeps the screen on while a job runs: left alone, a phone dims and locks,
// and a locked phone may stop the page. The browser drops a wake lock
// whenever the page is hidden, so it is taken again on the way back.
export function holdScreen() {
  let lock = null;
  let released = false;
  const take = async () => {
    if (released || document.visibilityState !== 'visible') return;
    try { lock = await navigator.wakeLock?.request('screen'); } catch { /* not offered */ }
  };
  const onVisible = () => { if (!lock || lock.released) take(); };
  document.addEventListener('visibilitychange', onVisible);
  take();
  return {
    release() {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      try { lock?.release(); } catch { /* ignore */ }
    },
  };
}
