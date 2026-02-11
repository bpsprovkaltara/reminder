const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const defaults = require('../config/defaults');
const time = require('../config/time');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'reminder.db');
const BACKUP_DIR = path.join(__dirname, '..', '..', 'data', 'backups');

let db;
let stmts = {};

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTables();
    prepareStatements();
    prepareTransactions();
  }
  return db;
}

function prepareStatements() {
  stmts = {
    // User operations
    getUser: db.prepare('SELECT * FROM users WHERE phone = ?'),
    upsertUser: db.prepare(`
      INSERT INTO users (phone, name, role) VALUES (?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET name = ?, updated_at = datetime('now', 'localtime')
    `),
    getAllActiveUsers: db.prepare('SELECT * FROM users WHERE is_active = 1'),
    getAllUsers: db.prepare('SELECT * FROM users ORDER BY created_at DESC'),
    getAllAdmins: db.prepare("SELECT * FROM users WHERE role = 'admin'"),
    deleteLeaveRequests: db.prepare('DELETE FROM leave_requests WHERE phone = ?'),
    deleteSnoozeState: db.prepare('DELETE FROM snooze_state WHERE phone = ?'),
    deleteAttendanceLog: db.prepare('DELETE FROM attendance_log WHERE phone = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE phone = ?'),
    setAdmin: db.prepare("UPDATE users SET role = 'admin', updated_at = datetime('now', 'localtime') WHERE phone = ?"),
    getAdminPhone: db.prepare("SELECT phone FROM users WHERE role = 'admin' LIMIT 1"),

    // Attendance operations
    getAttendanceToday: db.prepare('SELECT * FROM attendance_log WHERE phone = ? AND date = ? AND type = ?'),
    confirmAttendance: db.prepare(`
      INSERT INTO attendance_log (phone, date, type, confirmed_at, method)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone, date, type) DO NOTHING
    `),
    getAttendanceHistory: db.prepare('SELECT * FROM attendance_log WHERE phone = ? ORDER BY date DESC, type ASC LIMIT ?'),
    getAttendanceForDateRange: db.prepare('SELECT * FROM attendance_log WHERE phone = ? AND date >= ? AND date <= ? ORDER BY date, type'),
    getWeeklyAttendanceSummary: db.prepare(`
      SELECT
        u.phone, u.name,
        COUNT(CASE WHEN a.type = 'pagi' THEN 1 END) as pagi_count,
        COUNT(CASE WHEN a.type = 'sore' THEN 1 END) as sore_count
      FROM users u
      LEFT JOIN attendance_log a ON u.phone = a.phone
        AND a.date >= ? AND a.date <= ?
      WHERE u.is_active = 1 AND u.role != 'admin'
      GROUP BY u.phone, u.name
      ORDER BY u.name
    `),

    // Leave operations
    addLeaveRequest: db.prepare(`
      INSERT INTO leave_requests (phone, start_date, end_date, reason, status)
      VALUES (?, ?, ?, ?, 'approved')
    `),
    getActiveLeaves: db.prepare(`
      SELECT * FROM leave_requests
      WHERE phone = ? AND start_date <= ? AND end_date >= ? AND status = 'approved'
    `),
    getActiveLeavePhones: db.prepare(`
      SELECT DISTINCT phone FROM leave_requests
      WHERE start_date <= ? AND end_date >= ? AND status = 'approved'
    `),
    getAllLeaves: db.prepare('SELECT * FROM leave_requests WHERE phone = ? ORDER BY start_date DESC LIMIT 10'),
    cancelLeave: db.prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id = ? AND phone = ?"),

    // Holiday operations
    addHoliday: db.prepare('INSERT OR REPLACE INTO holidays (date, name, is_national, created_by) VALUES (?, ?, ?, ?)'),
    getHoliday: db.prepare('SELECT * FROM holidays WHERE date = ?'),
    getUpcomingHolidays: db.prepare('SELECT * FROM holidays WHERE date >= ? ORDER BY date ASC LIMIT ?'),
    removeHoliday: db.prepare('DELETE FROM holidays WHERE date = ? AND is_national = 0'),
    deleteNationalHolidays: db.prepare('DELETE FROM holidays WHERE is_national = 1'),
    insertNationalHoliday: db.prepare('INSERT OR IGNORE INTO holidays (date, name, is_national) VALUES (?, ?, 1)'),

    // Rate limiting
    getRateLimit: db.prepare('SELECT * FROM rate_limit WHERE phone = ?'),
    insertRateLimit: db.prepare('INSERT INTO rate_limit (phone, last_message_at, message_count) VALUES (?, ?, 1)'),
    resetRateLimitWindow: db.prepare('UPDATE rate_limit SET last_message_at = ?, message_count = 1 WHERE phone = ?'),
    incrementRateLimit: db.prepare('UPDATE rate_limit SET message_count = message_count + 1 WHERE phone = ?'),
    deleteRateLimit: db.prepare('DELETE FROM rate_limit WHERE phone = ?'),

    // Snooze operations
    getSnoozeCount: db.prepare('SELECT count FROM snooze_state WHERE phone = ? AND date = ? AND type = ?'),
    incrementSnooze: db.prepare(`
      INSERT INTO snooze_state (phone, date, type, count) VALUES (?, ?, ?, 1)
      ON CONFLICT(phone, date, type) DO UPDATE SET count = count + 1
    `),
    resetDailySnooze: db.prepare('DELETE FROM snooze_state WHERE date < ?'),
  };
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT,
      role TEXT DEFAULT 'user',
      reminder_pagi TEXT DEFAULT '${defaults.REMINDER_PAGI}',
      reminder_sore TEXT DEFAULT '${defaults.REMINDER_SORE}',
      jadwal_khusus TEXT DEFAULT '${defaults.DEFAULT_JADWAL_KHUSUS.replace(/'/g, "''")}',
      hari_kerja TEXT DEFAULT '${JSON.stringify(defaults.HARI_KERJA)}',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS attendance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('pagi', 'sore')),
      confirmed_at TEXT NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('manual', 'auto')),
      UNIQUE(phone, date, type),
      FOREIGN KEY (phone) REFERENCES users(phone)
    );

    CREATE TABLE IF NOT EXISTS snooze_state (
      phone TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('pagi', 'sore')),
      count INTEGER DEFAULT 0,
      PRIMARY KEY(phone, date, type)
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'approved' CHECK(status IN ('approved', 'cancelled')),
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      is_national INTEGER DEFAULT 1,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit (
      phone TEXT NOT NULL,
      last_message_at INTEGER NOT NULL,
      message_count INTEGER DEFAULT 1,
      PRIMARY KEY(phone)
    );
  `);

  // --- Indexes for query performance ---
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_attendance_phone_date ON attendance_log(phone, date);
    CREATE INDEX IF NOT EXISTS idx_leave_active ON leave_requests(phone, status, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);
  `);

  // --- Migrations for existing databases ---
  const columns = db.pragma('table_info(users)');
  const columnNames = columns.map((col) => col.name);

  // Migration: add role column
  if (!columnNames.includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
    console.log('[DB] Migration: kolom role ditambahkan.');
  }

  // Migration: add jadwal_khusus column
  if (!columnNames.includes('jadwal_khusus')) {
    db.exec(`ALTER TABLE users ADD COLUMN jadwal_khusus TEXT DEFAULT '${defaults.DEFAULT_JADWAL_KHUSUS.replace(/'/g, "''")}'`);
    db.exec(`UPDATE users SET jadwal_khusus = '${defaults.DEFAULT_JADWAL_KHUSUS.replace(/'/g, "''")}' WHERE jadwal_khusus IS NULL`);
    console.log('[DB] Migration: kolom jadwal_khusus ditambahkan.');
  }

  // Migration: add max_followups column
  if (!columnNames.includes('max_followups')) {
    db.exec(`ALTER TABLE users ADD COLUMN max_followups INTEGER DEFAULT ${defaults.DEFAULT_MAX_FOLLOWUPS}`);
    console.log('[DB] Migration: kolom max_followups ditambahkan.');
  }

  // Migration: update old default times
  db.exec(`UPDATE users SET reminder_pagi = '${defaults.REMINDER_PAGI}' WHERE reminder_pagi = '07:30'`);
  db.exec(`UPDATE users SET reminder_sore = '${defaults.REMINDER_SORE}' WHERE reminder_sore = '16:00'`);
}

// ─── Transactional helpers ──────────────────────────────────────────

let removeUserTx;
let syncNationalHolidaysTx;
let checkRateLimitTx;

function prepareTransactions() {
  removeUserTx = db.transaction((phone) => {
    stmts.deleteLeaveRequests.run(phone);
    stmts.deleteSnoozeState.run(phone);
    stmts.deleteAttendanceLog.run(phone);
    stmts.deleteUser.run(phone);
  });

  syncNationalHolidaysTx = db.transaction((holidays) => {
    stmts.deleteNationalHolidays.run();
    for (const h of holidays) {
      stmts.insertNationalHoliday.run(h.date, h.name);
    }
  });

  checkRateLimitTx = db.transaction((phone, maxMessages, windowSeconds) => {
    const now = Math.floor(Date.now() / 1000);
    const row = stmts.getRateLimit.get(phone);

    if (!row) {
      stmts.insertRateLimit.run(phone, now);
      return { allowed: true, count: 1 };
    }

    const timeSinceFirst = now - row.last_message_at;

    if (timeSinceFirst > windowSeconds) {
      stmts.resetRateLimitWindow.run(now, phone);
      return { allowed: true, count: 1 };
    }

    if (row.message_count >= maxMessages) {
      return { allowed: false, count: row.message_count, resetIn: windowSeconds - timeSinceFirst };
    }

    stmts.incrementRateLimit.run(phone);
    return { allowed: true, count: row.message_count + 1 };
  });
}

// ─── User operations ────────────────────────────────────────────────

function getUser(phone) {
  getDb();
  return stmts.getUser.get(phone);
}

function upsertUser(phone, name, role = 'user') {
  getDb();
  stmts.upsertUser.run(phone, name, role, name);
  return stmts.getUser.get(phone);
}

function getAllActiveUsers() {
  getDb();
  return stmts.getAllActiveUsers.all();
}

function getAllUsers() {
  getDb();
  return stmts.getAllUsers.all();
}

function getAllAdmins() {
  getDb();
  return stmts.getAllAdmins.all();
}

function removeUser(phone) {
  getDb();
  removeUserTx(phone);
}

function updateUserSetting(phone, field, value) {
  const allowed = ['reminder_pagi', 'reminder_sore', 'jadwal_khusus', 'hari_kerja', 'is_active', 'role', 'max_followups'];
  if (!allowed.includes(field)) throw new Error(`Invalid field: ${field}`);
  // Dynamic field — can't be pre-prepared
  getDb().prepare(`UPDATE users SET ${field} = ?, updated_at = datetime('now', 'localtime') WHERE phone = ?`).run(value, phone);
  return stmts.getUser.get(phone);
}

function setAdmin(phone) {
  getDb();
  stmts.setAdmin.run(phone);
  return stmts.getUser.get(phone);
}

function isAdmin(phone) {
  const user = getUser(phone);
  return user && user.role === 'admin';
}

function getAdminPhone() {
  getDb();
  const admin = stmts.getAdminPhone.get();
  return admin ? admin.phone : null;
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

function getAttendanceToday(phone, type) {
  getDb();
  const today = time.getCurrentDate();
  return stmts.getAttendanceToday.get(phone, today, type);
}

function confirmAttendance(phone, type, method = 'manual') {
  getDb();
  const today = time.getCurrentDate();
  const now = time.getConfirmationTime();
  stmts.confirmAttendance.run(phone, today, type, now, method);
  return stmts.getAttendanceToday.get(phone, today, type);
}

function getAttendanceHistory(phone, limit = 14) {
  getDb();
  return stmts.getAttendanceHistory.all(phone, limit);
}

function getAttendanceForDateRange(phone, startDate, endDate) {
  getDb();
  return stmts.getAttendanceForDateRange.all(phone, startDate, endDate);
}

function getWeeklyAttendanceSummary(startDate, endDate) {
  getDb();
  return stmts.getWeeklyAttendanceSummary.all(startDate, endDate);
}

// ─── Leave request operations ───────────────────────────────────────

function addLeaveRequest(phone, startDate, endDate, reason) {
  getDb();
  const result = stmts.addLeaveRequest.run(phone, startDate, endDate, reason);
  return result.lastInsertRowid;
}

function getActiveLeaves(phone, date) {
  getDb();
  return stmts.getActiveLeaves.all(phone, date, date);
}

function getActiveLeavePhones(date) {
  getDb();
  const rows = stmts.getActiveLeavePhones.all(date, date);
  return new Set(rows.map(r => r.phone));
}

function getAllLeaves(phone) {
  getDb();
  return stmts.getAllLeaves.all(phone);
}

function cancelLeave(leaveId, phone) {
  getDb();
  stmts.cancelLeave.run(leaveId, phone);
}

// ─── Holiday operations ─────────────────────────────────────────────

function addHoliday(date, name, isNational = false, createdBy = null) {
  getDb();
  stmts.addHoliday.run(date, name, isNational ? 1 : 0, createdBy);
}

function isHoliday(date) {
  getDb();
  return !!stmts.getHoliday.get(date);
}

function getHoliday(date) {
  getDb();
  return stmts.getHoliday.get(date);
}

function getUpcomingHolidays(limit = 10) {
  getDb();
  const today = time.getCurrentDate();
  return stmts.getUpcomingHolidays.all(today, limit);
}

function removeHoliday(date) {
  getDb();
  stmts.removeHoliday.run(date);
}

function syncNationalHolidays(holidays) {
  getDb();
  syncNationalHolidaysTx(holidays);
}

// ─── Rate limiting ──────────────────────────────────────────────────

function checkRateLimit(phone, maxMessages, windowSeconds) {
  getDb();
  return checkRateLimitTx(phone, maxMessages, windowSeconds);
}

function resetRateLimit(phone) {
  getDb();
  stmts.deleteRateLimit.run(phone);
}

// ─── Snooze operations ──────────────────────────────────────────────

function getSnoozeCount(phone, type) {
  getDb();
  const today = time.getCurrentDate();
  const row = stmts.getSnoozeCount.get(phone, today, type);
  return row ? row.count : 0;
}

function incrementSnooze(phone, type) {
  getDb();
  const today = time.getCurrentDate();
  stmts.incrementSnooze.run(phone, today, type);
  return getSnoozeCount(phone, type);
}

function resetDailySnooze() {
  getDb();
  const today = time.getCurrentDate();
  stmts.resetDailySnooze.run(today);
}

// ─── Database backup ────────────────────────────────────────────────

async function backupDatabase() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `reminder-${timestamp}.db`);

    // Use native better-sqlite3 backup API (atomic, WAL-safe)
    await db.backup(backupPath);

    console.log(`[DB] Backup created: ${backupPath}`);

    // Clean old backups (keep last 7 days)
    cleanOldBackups();

    return backupPath;
  } catch (err) {
    console.error('[DB] Backup failed:', err.message);
    return null;
  }
}

function cleanOldBackups(keepDays = 7) {
  try {
    const files = fs.readdirSync(BACKUP_DIR);
    const now = Date.now();
    const maxAge = keepDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith('reminder-') || !file.endsWith('.db')) continue;
      
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

module.exports = {
  getDb,
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
  checkRateLimit,
  resetRateLimit,
  getSnoozeCount,
  incrementSnooze,
  resetDailySnooze,
  backupDatabase,
  cleanOldBackups,
};
