const cron = require('node-cron');
const db = require('../db/database');
const wa = require('./whatsapp');
const holiday = require('./holiday');
const defaults = require('../config/defaults');
const time = require('../config/time');

const activeJobs = new Map();
const autoResendTimers = new Map(); // key: "phone_type", value: { timer, index, name }
let lastCheckedTime = null; // prevent duplicate sends within same simulated minute
let schedulerRunning = false;

// Callback to set pending reminder context in handler (injected to avoid circular dep)
let _onReminderSent = null;

function onReminderSent(callback) {
  _onReminderSent = callback;
}

function startScheduler() {
  // Guard against double-start (e.g. WhatsApp reconnects)
  if (schedulerRunning) {
    console.log('[Scheduler] Scheduler sudah berjalan, skip double-start.');
    return;
  }
  schedulerRunning = true;

  // In speed mode, check more frequently (every second) so simulated minutes aren't skipped
  const interval = time.speedMultiplier > 1
    ? Math.max(1000, Math.floor(60000 / time.speedMultiplier))
    : 60000;

  if (time.speedMultiplier > 1) {
    // Use setInterval for fast simulation
    const timer = setInterval(() => checkAndSendReminders(), interval);
    activeJobs.set('main', { stop: () => clearInterval(timer) });
  } else {
    // Use cron for production (every minute)
    const job = cron.schedule('* * * * *', () => checkAndSendReminders());
    activeJobs.set('main', job);
  }

  // Clean up old snooze data and auto-resend timers daily at midnight
  const cleanup = cron.schedule('0 0 * * *', async () => {
    db.resetDailySnooze();
    clearAllAutoResend();
    console.log('[Scheduler] Daily cleanup: snooze & auto-resend cleared.');
  });
  activeJobs.set('cleanup', cleanup);

  // Daily database backup at configured time (default 2 AM)
  const backupCron = `${defaults.BACKUP_MINUTE} ${defaults.BACKUP_HOUR} * * *`;
  const backup = cron.schedule(backupCron, async () => {
    console.log('[Scheduler] Starting daily database backup...');
    const backupPath = db.backupDatabase();
    if (backupPath) {
      console.log(`[Scheduler] Backup successful: ${backupPath}`);
    }
  });
  activeJobs.set('backup', backup);

  // Sync national holidays daily at 3 AM
  if (defaults.HOLIDAY_SYNC_ENABLED) {
    const holidaySync = cron.schedule('0 3 * * *', async () => {
      console.log('[Scheduler] Syncing national holidays...');
      await holiday.syncHolidaysToDb(db);
    });
    activeJobs.set('holiday-sync', holidaySync);

    // Initial sync on startup (with delay to ensure DB is ready)
    setTimeout(async () => {
      console.log('[Scheduler] Initial holiday sync...');
      await holiday.syncHolidaysToDb(db);
    }, 5000);
  }

  console.log('[Scheduler] Scheduler aktif.');
  if (time.isSimulated()) {
    console.log(`[Scheduler] Check interval: ${interval}ms (speed: ${time.speedMultiplier}x)`);
  }
}

async function checkAndSendReminders() {
  if (!wa.getIsReady()) {
    console.log('[Scheduler] WhatsApp belum siap, skip check.');
    return;
  }

  const currentTime = time.getCurrentTime();
  const currentDay = time.getCurrentDay();
  const currentDate = time.getCurrentDate();

  // Skip if we already checked this minute (prevents duplicate sends)
  if (currentTime === lastCheckedTime) return;
  lastCheckedTime = currentTime;

  // Check if today is a holiday
  const isHolidayToday = db.isHoliday(currentDate);
  if (isHolidayToday) {
    const holidayInfo = db.getHoliday(currentDate);
    console.log(`[Scheduler] Hari ini libur (${holidayInfo.name}), skip reminder.`);
    return;
  }

  const users = db.getAllActiveUsers();

  if (users.length === 0) {
    return;
  }

  console.log(`[Scheduler] Cek reminder: waktu=${currentTime}, hari=${currentDay}, tanggal=${currentDate}, users=${users.length}`);

  for (const user of users) {
    // Skip bot phone (only receives commands, not reminders)
    if (user.phone === defaults.BOT_PHONE) {
      continue;
    }

    const hariKerja = JSON.parse(user.hari_kerja);
    if (!hariKerja.includes(currentDay)) {
      continue;
    }

    // Check if user is on leave today
    const leaves = db.getActiveLeaves(user.phone, currentDate);
    if (leaves.length > 0) {
      console.log(`[Scheduler] Skip ${user.phone} - sedang izin/cuti (${leaves[0].reason})`);
      continue;
    }

    // Get effective reminder times for today (may differ from default on certain days)
    const pagiTime = db.getEffectiveReminderTime(user, 'pagi', currentDay);
    const soreTime = db.getEffectiveReminderTime(user, 'sore', currentDay);

    // Check pagi reminder
    if (currentTime === pagiTime) {
      const existing = db.getAttendanceToday(user.phone, 'pagi');
      if (!existing) {
        console.log(`[Scheduler] Trigger reminder pagi untuk ${user.phone} (jadwal: ${pagiTime})`);
        await sendReminder(user.phone, 'pagi', user.name);
        startAutoResend(user.phone, 'pagi', user.name);
      } else {
        console.log(`[Scheduler] Skip pagi ${user.phone} - sudah absen`);
      }
    }

    // Check sore reminder + weekly recap on Friday
    if (currentTime === soreTime) {
      const existing = db.getAttendanceToday(user.phone, 'sore');
      if (!existing) {
        console.log(`[Scheduler] Trigger reminder sore untuk ${user.phone} (jadwal: ${soreTime})`);
        await sendReminder(user.phone, 'sore', user.name);
        startAutoResend(user.phone, 'sore', user.name);
      } else {
        console.log(`[Scheduler] Skip sore ${user.phone} - sudah absen`);
        
        // Send weekly recap on Friday after sore confirmation
        if (currentDay === 5) { // Friday
          await sendWeeklyRecap(user.phone, user.name);
        }
      }
    }
  }
}

/**
 * Send initial reminder to a user.
 * @param {string} phone
 * @param {string} type - 'pagi' or 'sore'
 * @param {string} [name] - User's name for personalization
 */
async function sendReminder(phone, type, name) {
  let message = type === 'pagi'
    ? defaults.MESSAGES.REMINDER_PAGI
    : defaults.MESSAGES.REMINDER_SORE;

  // Get user's max follow-ups for info in reminder
  const user = db.getUser(phone);
  const maxFollowups = user && user.max_followups ? user.max_followups : defaults.DEFAULT_MAX_FOLLOWUPS;

  message = message.replace(/\{name\}/g, name || 'kamu');
  message = message.replace(/\{maxpengingat\}/g, maxFollowups);

  const simLabel = time.isSimulated() ? ` (sim: ${time.getCurrentTime()})` : '';
  console.log(`[Scheduler] Kirim reminder ${type} ke ${phone}${simLabel}`);

  try {
    await wa.sendMessage(phone, message);
    console.log(`[Scheduler] Reminder ${type} berhasil dikirim ke ${phone}`);

    // Set pending reminder context so quick reply (1/2) works
    if (_onReminderSent) {
      _onReminderSent(phone, type);
    }
  } catch (err) {
    console.error(`[Scheduler] Gagal kirim reminder ${type} ke ${phone}:`, err.message);
  }
}

// ─── Auto-resend with Fibonacci intervals & tiered messages ─────────

/**
 * Start auto-resend chain for a user/type using Fibonacci intervals.
 * Uses tiered messages (polite → direct → urgent)
 *
 * @param {string} phone
 * @param {string} type - 'pagi' or 'sore'
 * @param {string} [name] - User's name for personalization
 */
function startAutoResend(phone, type, name) {
  const key = `${phone}_${type}`;

  // Don't restart if already running
  if (autoResendTimers.has(key)) {
    console.log(`[AutoResend] Sudah aktif untuk ${phone} ${type}, skip.`);
    return;
  }

  // Get user's max follow-ups setting
  const user = db.getUser(phone);
  const maxFollowups = user && user.max_followups ? user.max_followups : defaults.DEFAULT_MAX_FOLLOWUPS;

  const state = { timer: null, index: 0, name: name || 'kamu', maxFollowups };
  autoResendTimers.set(key, state);

  console.log(`[AutoResend] Mulai auto-resend ${type} untuk ${phone} (max: ${maxFollowups} pengingat, interval Fibonacci)`);

  scheduleNextResend(phone, type);
}

/**
 * Schedule the next follow-up reminder in the Fibonacci chain.
 * Tier 1 (1-2): Polite reminder
 * Tier 2 (3-5): Direct reminder
 * Tier 3 (6+): Urgent reminder
 */
function scheduleNextResend(phone, type) {
  const key = `${phone}_${type}`;
  const state = autoResendTimers.get(key);
  if (!state) return;

  const intervals = defaults.FIBONACCI_INTERVALS;
  const maxFollowups = state.maxFollowups || defaults.DEFAULT_MAX_FOLLOWUPS;

  // User's max follow-ups reached → stop
  if (state.index >= maxFollowups) {
    console.log(`[AutoResend] Batas pengingat tercapai (${maxFollowups}x) untuk ${phone} ${type}.`);
    stopAutoResend(phone, type);
    return;
  }

  // Fibonacci intervals exhausted → stop
  if (state.index >= intervals.length) {
    console.log(`[AutoResend] Semua interval selesai untuk ${phone} ${type}.`);
    stopAutoResend(phone, type);
    return;
  }

  const intervalMin = intervals[state.index];
  const intervalMs = (intervalMin * 60 * 1000) / time.speedMultiplier;
  const isLast = (state.index === maxFollowups - 1) || (state.index === intervals.length - 1);
  const nextIntervalMin = isLast ? null : intervals[state.index + 1];

  console.log(`[AutoResend] Jadwal pengingat ke-${state.index + 1} ${type} untuk ${phone} dalam ${intervalMin} mnt (${Math.round(intervalMs / 1000)}s real)`);

  state.timer = setTimeout(async () => {
    // Check if already confirmed
    const existing = db.getAttendanceToday(phone, type);
    if (existing) {
      console.log(`[AutoResend] ${phone} ${type} sudah dikonfirmasi, stop.`);
      stopAutoResend(phone, type);
      return;
    }

    const count = state.index + 1;
    const total = Math.min(maxFollowups, intervals.length);

    // Build footer with next timing info
    let footer;
    if (isLast) {
      footer = `_⚠️ Ini adalah pengingat terakhir (${count}/${total})_`;
    } else {
      footer = `_⏳ Pengingat ke-${count}/${total} · Berikutnya: ${nextIntervalMin} mnt_`;
    }

    // Select message tier based on count
    let template;
    if (count <= 2) {
      template = defaults.MESSAGES.FOLLOWUP_TIER1; // Polite
    } else if (count <= 5) {
      template = defaults.MESSAGES.FOLLOWUP_TIER2; // Direct
    } else {
      template = defaults.MESSAGES.FOLLOWUP_TIER3; // Urgent
    }

    // Build follow-up message
    const followUpMsg = template
      .replace(/\{count\}/g, count)
      .replace(/\{max\}/g, total)
      .replace(/\{TYPE\}/g, type.toUpperCase())
      .replace(/\{type\}/g, type)
      .replace(/\{name\}/g, state.name)
      .replace(/\{footer\}/g, footer);

    console.log(`[AutoResend] Kirim pengingat tier ${count <= 2 ? 1 : count <= 5 ? 2 : 3} ke-${count}/${total} ${type} ke ${phone}`);

    try {
      await wa.sendMessage(phone, followUpMsg);
      // Update pending reminder context
      if (_onReminderSent) {
        _onReminderSent(phone, type);
      }
    } catch (err) {
      console.error(`[AutoResend] Gagal kirim follow-up ke ${phone}:`, err.message);
    }

    // Advance to next interval
    state.index++;

    if (state.index < maxFollowups && state.index < intervals.length) {
      scheduleNextResend(phone, type);
    } else {
      console.log(`[AutoResend] Semua ${total} pengingat telah dikirim untuk ${phone} ${type}.`);
      stopAutoResend(phone, type);
    }
  }, intervalMs);
}

/**
 * Stop auto-resend for a specific user/type.
 * Called when user confirms attendance.
 */
function stopAutoResend(phone, type) {
  const key = `${phone}_${type}`;
  const state = autoResendTimers.get(key);
  if (state) {
    if (state.timer) clearTimeout(state.timer);
    autoResendTimers.delete(key);
    console.log(`[AutoResend] Dihentikan untuk ${phone} ${type}.`);
  }
}

/**
 * Clear all auto-resend timers (used for daily cleanup and shutdown).
 */
function clearAllAutoResend() {
  for (const [key, state] of autoResendTimers) {
    if (state.timer) clearTimeout(state.timer);
  }
  autoResendTimers.clear();
  console.log('[AutoResend] Semua timer dibersihkan.');
}

/**
 * Check if auto-resend is active for a user/type.
 */
function isAutoResendActive(phone, type) {
  return autoResendTimers.has(`${phone}_${type}`);
}

// ─── Weekly recap ───────────────────────────────────────────────────

/**
 * Send weekly attendance recap to a user (sent on Friday sore after confirmation)
 * @param {string} phone
 * @param {string} name
 */
async function sendWeeklyRecap(phone, name) {
  try {
    // Calculate this week's date range (Monday - Friday)
    const currentDate = new Date(time.getCurrentDate() + 'T12:00:00');
    const currentDay = currentDate.getDay(); // 5 = Friday
    
    // Get Monday of this week
    const monday = new Date(currentDate);
    monday.setDate(currentDate.getDate() - (currentDay - 1));
    const startDate = monday.toISOString().slice(0, 10);
    
    // Friday is today
    const endDate = time.getCurrentDate();

    // Get attendance for this week
    const attendance = db.getAttendanceForDateRange(phone, startDate, endDate);
    
    const pagiCount = attendance.filter(a => a.type === 'pagi').length;
    const soreCount = attendance.filter(a => a.type === 'sore').length;
    const expected = 5; // Monday to Friday

    const avgPercentage = Math.round(((pagiCount + soreCount) / (expected * 2)) * 100);

    let status;
    if (avgPercentage >= 90) {
      status = '🌟 *Luar biasa!* Kamu sangat rajin.';
    } else if (avgPercentage >= 70) {
      status = '👍 *Bagus!* Tetap pertahankan.';
    } else {
      status = '💪 *Semangat!* Tingkatkan kedisiplinan minggu depan.';
    }

    const header = defaults.MESSAGES.WEEKLY_RECAP_HEADER
      .replace('{start}', startDate)
      .replace('{end}', endDate);

    const personal = defaults.MESSAGES.WEEKLY_RECAP_PERSONAL
      .replace('{name}', name)
      .replace('{pagi}', pagiCount)
      .replace('{sore}', soreCount)
      .replace('{expected}', expected)
      .replace('{percentage}', avgPercentage)
      .replace('{status}', status);

    const message = header + personal;

    await wa.sendMessage(phone, message);
    console.log(`[WeeklyRecap] Sent to ${phone} (${pagiCount}+${soreCount}/${expected*2})`);
  } catch (err) {
    console.error(`[WeeklyRecap] Failed for ${phone}:`, err.message);
  }
}

function stopScheduler() {
  for (const [name, job] of activeJobs) {
    job.stop();
    console.log(`[Scheduler] Job '${name}' dihentikan.`);
  }
  activeJobs.clear();
  clearAllAutoResend();
  schedulerRunning = false;
}

module.exports = {
  startScheduler,
  stopScheduler,
  sendReminder,
  startAutoResend,
  stopAutoResend,
  clearAllAutoResend,
  isAutoResendActive,
  onReminderSent,
};
