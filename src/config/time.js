/**
 * Time utility module with simulated time support for testing.
 *
 * Usage:
 *   Production:  node src/index.js
 *   Test mode:   node src/index.js --time 07:30
 *                node src/index.js --time 07:30 --date 2026-02-06
 *                node src/index.js --time 07:30 --date 2026-02-06 --day 1
 *                node src/index.js --speed 60  (1 menit = 1 detik)
 *
 * Combines:
 *   node src/index.js --time 16:00 --speed 10
 */

let simulatedTime = null;  // { hour, minute }
let simulatedDate = null;  // "YYYY-MM-DD"
let simulatedDay = null;   // 0-6 (Sun-Sat)
let speedMultiplier = 1;   // 1 = realtime, 60 = 1 min per second
let startRealTime = null;  // when simulation started
let startSimTime = null;   // simulated start point

function configure(opts = {}) {
  if (opts.time) {
    const [h, m] = opts.time.split(':').map(Number);
    if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
      throw new Error(`Invalid --time format: "${opts.time}". Use HH:MM (e.g. 07:30)`);
    }
    simulatedTime = { hour: h, minute: m };
    startRealTime = Date.now();
    startSimTime = { hour: h, minute: m };
  }

  if (opts.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
      throw new Error(`Invalid --date format: "${opts.date}". Use YYYY-MM-DD`);
    }
    simulatedDate = opts.date;
  }

  if (opts.day !== undefined && opts.day !== null) {
    const d = Number(opts.day);
    if (isNaN(d) || d < 0 || d > 6) {
      throw new Error(`Invalid --day: "${opts.day}". Use 0-6 (0=Sun, 1=Mon, ..., 6=Sat)`);
    }
    simulatedDay = d;
  }

  if (opts.speed) {
    const s = Number(opts.speed);
    if (isNaN(s) || s < 1) {
      throw new Error(`Invalid --speed: "${opts.speed}". Must be >= 1`);
    }
    speedMultiplier = s;
  }
}

function _getSimulatedNow() {
  if (!simulatedTime) return null;

  const elapsedMs = (Date.now() - startRealTime) * speedMultiplier;
  const elapsedMinutes = Math.floor(elapsedMs / 60000);

  let totalMinutes = startSimTime.hour * 60 + startSimTime.minute + elapsedMinutes;
  // Wrap around 24h
  totalMinutes = totalMinutes % (24 * 60);

  return {
    hour: Math.floor(totalMinutes / 60),
    minute: totalMinutes % 60,
  };
}

/** Returns current time as "HH:MM" */
function getCurrentTime() {
  const sim = _getSimulatedNow();
  if (sim) {
    return `${String(sim.hour).padStart(2, '0')}:${String(sim.minute).padStart(2, '0')}`;
  }
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** Returns current date as "YYYY-MM-DD" (local time, not UTC) */
function getCurrentDate() {
  if (simulatedDate) return simulatedDate;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Returns day of week: 0=Sun, 1=Mon, ..., 6=Sat */
function getCurrentDay() {
  if (simulatedDay !== null) return simulatedDay;
  if (simulatedDate) return new Date(simulatedDate + 'T12:00:00').getDay();
  return new Date().getDay();
}

/** Returns formatted time string for display (e.g., "07:30") */
function getConfirmationTime() {
  return getCurrentTime();
}

/** Returns localized date string for display */
function getDisplayDate() {
  const dateStr = getCurrentDate();
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString('id-ID', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function isSimulated() {
  return simulatedTime !== null || simulatedDate !== null || simulatedDay !== null;
}

function getStatusLabel() {
  if (!isSimulated()) return 'PRODUCTION';
  const parts = [];
  parts.push(`time=${getCurrentTime()}`);
  parts.push(`date=${getCurrentDate()}`);
  const dayNames = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  parts.push(`day=${dayNames[getCurrentDay()]}`);
  if (speedMultiplier > 1) parts.push(`speed=${speedMultiplier}x`);
  return `TEST MODE [${parts.join(', ')}]`;
}

module.exports = {
  configure,
  getCurrentTime,
  getCurrentDate,
  getCurrentDay,
  getConfirmationTime,
  getDisplayDate,
  isSimulated,
  getStatusLabel,
  get speedMultiplier() { return speedMultiplier; },
};
