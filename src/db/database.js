const { Pool } = require('pg');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const defaults = require('../config/defaults');
const time = require('../config/time');

const BACKUP_DIR = path.join(__dirname, '..', '..', 'data', 'backups');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://reminder:reminder_secret@localhost:5432/reminder';

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL });
    pool.on('error', (err) => {
      console.error('[DB] Pool error:', err.message);
    });
  }
  return pool;
}

async function connect() {
  const p = getPool();
  await initTables();
  await runMigrations();
  console.log('[DB] PostgreSQL connected.');
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function initTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT,
      role TEXT DEFAULT 'user',
      reminder_pagi TEXT DEFAULT '${defaults.REMINDER_PAGI}',
      reminder_sore TEXT DEFAULT '${defaults.REMINDER_SORE}',
      jadwal_khusus TEXT DEFAULT '${defaults.DEFAULT_JADWAL_KHUSUS.replace(/'/g, "''")}',
      hari_kerja TEXT DEFAULT '${JSON.stringify(defaults.HARI_KERJA)}',
      max_followups INTEGER DEFAULT ${defaults.DEFAULT_MAX_FOLLOWUPS},
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS attendance_log (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL REFERENCES users(phone),
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('pagi', 'sore')),
      confirmed_at TEXT NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('manual', 'auto')),
      UNIQUE(phone, date, type)
    );

    CREATE TABLE IF NOT EXISTS snooze_state (
      phone TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('pagi', 'sore')),
      count INTEGER DEFAULT 0,
      PRIMARY KEY(phone, date, type)
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'approved' CHECK(status IN ('approved', 'cancelled')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS holidays (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      is_national BOOLEAN DEFAULT TRUE,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rate_limit (
      phone TEXT PRIMARY KEY,
      last_message_at INTEGER NOT NULL,
      message_count INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_attendance_phone_date ON attendance_log(phone, date);
    CREATE INDEX IF NOT EXISTS idx_leave_active ON leave_requests(phone, status, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);
  `);
}

async function runMigrations() {
  const { rows } = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'users'
  `);
  const columnNames = rows.map((r) => r.column_name);

  if (!columnNames.includes('role')) {
    await query("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
    console.log('[DB] Migration: kolom role ditambahkan.');
  }

  if (!columnNames.includes('jadwal_khusus')) {
    await query(`ALTER TABLE users ADD COLUMN jadwal_khusus TEXT DEFAULT '${defaults.DEFAULT_JADWAL_KHUSUS.replace(/'/g, "''")}'`);
    await query(`UPDATE users SET jadwal_khusus = '${defaults.DEFAULT_JADWAL_KHUSUS.replace(/'/g, "''")}' WHERE jadwal_khusus IS NULL`);
    console.log('[DB] Migration: kolom jadwal_khusus ditambahkan.');
  }

  if (!columnNames.includes('max_followups')) {
    await query(`ALTER TABLE users ADD COLUMN max_followups INTEGER DEFAULT ${defaults.DEFAULT_MAX_FOLLOWUPS}`);
    console.log('[DB] Migration: kolom max_followups ditambahkan.');
  }

  await query(`UPDATE users SET reminder_pagi = '${defaults.REMINDER_PAGI}' WHERE reminder_pagi = '07:30'`);
  await query(`UPDATE users SET reminder_sore = '${defaults.REMINDER_SORE}' WHERE reminder_sore = '16:00'`);
}

// ─── User operations ────────────────────────────────────────────────

async function getUser(phone) {
  const { rows } = await query('SELECT * FROM users WHERE phone = $1', [phone]);
  return rows[0] || null;
}

async function upsertUser(phone, name, role = 'user') {
  await query(`
    INSERT INTO users (phone, name, role) VALUES ($1, $2, $3)
    ON CONFLICT(phone) DO UPDATE SET name = $2, updated_at = NOW()
  `, [phone, name, role]);
  return getUser(phone);
}

async function getAllActiveUsers() {
  const { rows } = await query('SELECT * FROM users WHERE is_active = TRUE');
  return rows;
}

async function getAllUsers() {
  const { rows } = await query('SELECT * FROM users ORDER BY created_at DESC');
  return rows;
}

async function getAllAdmins() {
  const { rows } = await query("SELECT * FROM users WHERE role = 'admin'");
  return rows;
}

async function removeUser(phone) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM leave_requests WHERE phone = $1', [phone]);
    await client.query('DELETE FROM snooze_state WHERE phone = $1', [phone]);
    await client.query('DELETE FROM attendance_log WHERE phone = $1', [phone]);
    await client.query('DELETE FROM users WHERE phone = $1', [phone]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateUserSetting(phone, field, value) {
  const allowed = ['reminder_pagi', 'reminder_sore', 'jadwal_khusus', 'hari_kerja', 'is_active', 'role', 'max_followups'];
  if (!allowed.includes(field)) throw new Error(`Invalid field: ${field}`);
  await query(`UPDATE users SET ${field} = $1, updated_at = NOW() WHERE phone = $2`, [value, phone]);
  return getUser(phone);
}

async function setAdmin(phone) {
  await query("UPDATE users SET role = 'admin', updated_at = NOW() WHERE phone = $1", [phone]);
  return getUser(phone);
}

async function isAdmin(phone) {
  const user = await getUser(phone);
  return user && user.role === 'admin';
}

async function getAdminPhone() {
  const { rows } = await query("SELECT phone FROM users WHERE role = 'admin' LIMIT 1");
  return rows[0] ? rows[0].phone : null;
}

// ─── Schedule helpers ───────────────────────────────────────────────

function getEffectiveReminderTime(user, type, day) {
  try {
    const jadwalKhusus = JSON.parse(user.jadwal_khusus || '{}');
    const dayStr = String(day);

    if (jadwalKhusus[dayStr] && jadwalKhusus[dayStr][type]) {
      return jadwalKhusus[dayStr][type];
    }
  } catch (err) {
    console.error('[DB] Error parsing jadwal_khusus:', err.message);
  }

  return type === 'pagi' ? user.reminder_pagi : user.reminder_sore;
}

// ─── Attendance log operations ──────────────────────────────────────

async function getAttendanceToday(phone, type) {
  const today = time.getCurrentDate();
  const { rows } = await query(
    'SELECT * FROM attendance_log WHERE phone = $1 AND date = $2 AND type = $3',
    [phone, today, type]
  );
  return rows[0] || null;
}

async function confirmAttendance(phone, type, method = 'manual') {
  const today = time.getCurrentDate();
  const now = time.getConfirmationTime();
  await query(`
    INSERT INTO attendance_log (phone, date, type, confirmed_at, method)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(phone, date, type) DO NOTHING
  `, [phone, today, type, now, method]);
  return getAttendanceToday(phone, type);
}

async function getAttendanceHistory(phone, limit = 14) {
  const { rows } = await query(
    'SELECT * FROM attendance_log WHERE phone = $1 ORDER BY date DESC, type ASC LIMIT $2',
    [phone, limit]
  );
  return rows;
}

async function getAttendanceForDateRange(phone, startDate, endDate) {
  const { rows } = await query(
    'SELECT * FROM attendance_log WHERE phone = $1 AND date >= $2 AND date <= $3 ORDER BY date, type',
    [phone, startDate, endDate]
  );
  return rows;
}

async function getWeeklyAttendanceSummary(startDate, endDate) {
  const { rows } = await query(`
    SELECT
      u.phone, u.name,
      COUNT(CASE WHEN a.type = 'pagi' THEN 1 END) as pagi_count,
      COUNT(CASE WHEN a.type = 'sore' THEN 1 END) as sore_count
    FROM users u
    LEFT JOIN attendance_log a ON u.phone = a.phone
      AND a.date >= $1 AND a.date <= $2
    WHERE u.is_active = TRUE AND u.role != 'admin'
    GROUP BY u.phone, u.name
    ORDER BY u.name
  `, [startDate, endDate]);
  return rows;
}

// ─── Leave request operations ───────────────────────────────────────

async function addLeaveRequest(phone, startDate, endDate, reason) {
  const { rows } = await query(`
    INSERT INTO leave_requests (phone, start_date, end_date, reason, status)
    VALUES ($1, $2, $3, $4, 'approved')
    RETURNING id
  `, [phone, startDate, endDate, reason]);
  return rows[0].id;
}

async function getActiveLeaves(phone, date) {
  const { rows } = await query(`
    SELECT * FROM leave_requests
    WHERE phone = $1 AND start_date <= $2 AND end_date >= $2 AND status = 'approved'
  `, [phone, date]);
  return rows;
}

async function getActiveLeavePhones(date) {
  const { rows } = await query(`
    SELECT DISTINCT phone FROM leave_requests
    WHERE start_date <= $1 AND end_date >= $1 AND status = 'approved'
  `, [date]);
  return new Set(rows.map((r) => r.phone));
}

async function getAllLeaves(phone) {
  const { rows } = await query(
    'SELECT * FROM leave_requests WHERE phone = $1 ORDER BY start_date DESC LIMIT 10',
    [phone]
  );
  return rows;
}

async function cancelLeave(leaveId, phone) {
  await query(
    "UPDATE leave_requests SET status = 'cancelled' WHERE id = $1 AND phone = $2",
    [leaveId, phone]
  );
}

// ─── Holiday operations ─────────────────────────────────────────────

async function addHoliday(date, name, isNational = false, createdBy = null) {
  await query(`
    INSERT INTO holidays (date, name, is_national, created_by) VALUES ($1, $2, $3, $4)
    ON CONFLICT(date) DO UPDATE SET name = $2, is_national = $3, created_by = $4
  `, [date, name, isNational, createdBy]);
}

async function isHoliday(date) {
  const { rows } = await query('SELECT 1 FROM holidays WHERE date = $1', [date]);
  return rows.length > 0;
}

async function getHoliday(date) {
  const { rows } = await query('SELECT * FROM holidays WHERE date = $1', [date]);
  return rows[0] || null;
}

async function getUpcomingHolidays(limit = 10) {
  const today = time.getCurrentDate();
  const { rows } = await query(
    'SELECT * FROM holidays WHERE date >= $1 ORDER BY date ASC LIMIT $2',
    [today, limit]
  );
  return rows;
}

async function removeHoliday(date) {
  await query('DELETE FROM holidays WHERE date = $1 AND is_national = FALSE', [date]);
}

async function syncNationalHolidays(holidays) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM holidays WHERE is_national = TRUE');
    for (const h of holidays) {
      await client.query(
        'INSERT INTO holidays (date, name, is_national) VALUES ($1, $2, TRUE) ON CONFLICT(date) DO NOTHING',
        [h.date, h.name]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Settings operations ────────────────────────────────────────────

async function getSetting(key) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}

async function setSetting(key, value) {
  await query(`
    INSERT INTO settings (key, value) VALUES ($1, $2)
    ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = NOW()
  `, [key, value]);
}

async function getDefaultReminderPagi() {
  return (await getSetting('default_reminder_pagi')) || defaults.REMINDER_PAGI;
}

async function getDefaultReminderSore() {
  return (await getSetting('default_reminder_sore')) || defaults.REMINDER_SORE;
}

async function setDefaultReminderTime(type, newTime) {
  const settingKey = type === 'pagi' ? 'default_reminder_pagi' : 'default_reminder_sore';
  const field = type === 'pagi' ? 'reminder_pagi' : 'reminder_sore';

  const oldDefault = type === 'pagi' ? await getDefaultReminderPagi() : await getDefaultReminderSore();

  await setSetting(settingKey, newTime);

  const result = await query(
    `UPDATE users SET ${field} = $1, updated_at = NOW() WHERE ${field} = $2`,
    [newTime, oldDefault]
  );

  return { oldDefault, newDefault: newTime, updatedCount: result.rowCount };
}

// ─── Rate limiting ──────────────────────────────────────────────────

async function checkRateLimit(phone, maxMessages, windowSeconds) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const now = Math.floor(Date.now() / 1000);
    const { rows } = await client.query('SELECT * FROM rate_limit WHERE phone = $1 FOR UPDATE', [phone]);
    const row = rows[0];

    if (!row) {
      await client.query('INSERT INTO rate_limit (phone, last_message_at, message_count) VALUES ($1, $2, 1)', [phone, now]);
      await client.query('COMMIT');
      return { allowed: true, count: 1 };
    }

    const timeSinceFirst = now - row.last_message_at;

    if (timeSinceFirst > windowSeconds) {
      await client.query('UPDATE rate_limit SET last_message_at = $1, message_count = 1 WHERE phone = $2', [now, phone]);
      await client.query('COMMIT');
      return { allowed: true, count: 1 };
    }

    if (row.message_count >= maxMessages) {
      await client.query('COMMIT');
      return { allowed: false, count: row.message_count, resetIn: windowSeconds - timeSinceFirst };
    }

    await client.query('UPDATE rate_limit SET message_count = message_count + 1 WHERE phone = $1', [phone]);
    await client.query('COMMIT');
    return { allowed: true, count: row.message_count + 1 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function resetRateLimit(phone) {
  await query('DELETE FROM rate_limit WHERE phone = $1', [phone]);
}

// ─── Snooze operations ──────────────────────────────────────────────

async function getSnoozeCount(phone, type) {
  const today = time.getCurrentDate();
  const { rows } = await query(
    'SELECT count FROM snooze_state WHERE phone = $1 AND date = $2 AND type = $3',
    [phone, today, type]
  );
  return rows[0] ? rows[0].count : 0;
}

async function incrementSnooze(phone, type) {
  const today = time.getCurrentDate();
  await query(`
    INSERT INTO snooze_state (phone, date, type, count) VALUES ($1, $2, $3, 1)
    ON CONFLICT(phone, date, type) DO UPDATE SET count = snooze_state.count + 1
  `, [phone, today, type]);
  return getSnoozeCount(phone, type);
}

async function resetDailySnooze() {
  const today = time.getCurrentDate();
  await query('DELETE FROM snooze_state WHERE date < $1', [today]);
}

// ─── Database backup ────────────────────────────────────────────────

async function backupDatabase() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `reminder-${timestamp}.sql`);

    execSync(`pg_dump "${DATABASE_URL}" > "${backupPath}"`, { stdio: 'pipe' });
    console.log(`[DB] Backup created: ${backupPath}`);

    cleanOldBackups();
    return backupPath;
  } catch (err) {
    console.error('[DB] Backup failed:', err.message);
    return null;
  }
}

function cleanOldBackups(keepDays = 7) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const files = fs.readdirSync(BACKUP_DIR);
    const now = Date.now();
    const maxAge = keepDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith('reminder-')) continue;

      const filePath = path.join(BACKUP_DIR, file);
      const stats = fs.statSync(filePath);
      const age = now - stats.mtimeMs;

      if (age > maxAge) {
        fs.unlinkSync(filePath);
        console.log(`[DB] Deleted old backup: ${file}`);
      }
    }
  } catch (err) {
    console.error('[DB] Cleanup old backups failed:', err.message);
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  connect,
  close,
  query,
  getUser,
  upsertUser,
  getAllActiveUsers,
  getAllUsers,
  getAllAdmins,
  removeUser,
  updateUserSetting,
  setAdmin,
  isAdmin,
  getAdminPhone,
  getEffectiveReminderTime,
  getAttendanceToday,
  confirmAttendance,
  getAttendanceHistory,
  getAttendanceForDateRange,
  getWeeklyAttendanceSummary,
  addLeaveRequest,
  getActiveLeaves,
  getActiveLeavePhones,
  getAllLeaves,
  cancelLeave,
  addHoliday,
  isHoliday,
  getHoliday,
  getUpcomingHolidays,
  removeHoliday,
  syncNationalHolidays,
  getSetting,
  setSetting,
  getDefaultReminderPagi,
  getDefaultReminderSore,
  setDefaultReminderTime,
  checkRateLimit,
  resetRateLimit,
  getSnoozeCount,
  incrementSnooze,
  resetDailySnooze,
  backupDatabase,
  cleanOldBackups,
};
