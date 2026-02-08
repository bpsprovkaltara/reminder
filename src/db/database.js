const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const defaults = require('../config/defaults');
const time = require('../config/time');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'reminder.db');
const BACKUP_DIR = path.join(__dirname, '..', '..', 'data', 'backups');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTables();
  }
  return db;
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

  // Migration: update old default times
  db.exec(`UPDATE users SET reminder_pagi = '${defaults.REMINDER_PAGI}' WHERE reminder_pagi = '07:30'`);
  db.exec(`UPDATE users SET reminder_sore = '${defaults.REMINDER_SORE}' WHERE reminder_sore = '16:00'`);
}

// ─── User operations ────────────────────────────────────────────────

function getUser(phone) {
  return getDb().prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

function upsertUser(phone, name, role = 'user') {
  const stmt = getDb().prepare(`
    INSERT INTO users (phone, name, role) VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET name = ?, updated_at = datetime('now', 'localtime')
  `);
  stmt.run(phone, name, role, name);
  return getUser(phone);
}

function getAllActiveUsers() {
  return getDb().prepare('SELECT * FROM users WHERE is_active = 1').all();
}

function getAllUsers() {
  return getDb().prepare('SELECT * FROM users ORDER BY created_at DESC').all();
}

function getAllAdmins() {
  return getDb().prepare("SELECT * FROM users WHERE role = 'admin'").all();
}

function removeUser(phone) {
  getDb().prepare('DELETE FROM leave_requests WHERE phone = ?').run(phone);
  getDb().prepare('DELETE FROM snooze_state WHERE phone = ?').run(phone);
  getDb().prepare('DELETE FROM attendance_log WHERE phone = ?').run(phone);
  getDb().prepare('DELETE FROM users WHERE phone = ?').run(phone);
}

function updateUserSetting(phone, field, value) {
  const allowed = ['reminder_pagi', 'reminder_sore', 'jadwal_khusus', 'hari_kerja', 'is_active', 'role'];
  if (!allowed.includes(field)) throw new Error(`Invalid field: ${field}`);
  getDb().prepare(`UPDATE users SET ${field} = ?, updated_at = datetime('now', 'localtime') WHERE phone = ?`).run(value, phone);
  return getUser(phone);
}

function setAdmin(phone) {
  getDb().prepare(`UPDATE users SET role = 'admin', updated_at = datetime('now', 'localtime') WHERE phone = ?`).run(phone);
  return getUser(phone);
}

function isAdmin(phone) {
  const user = getUser(phone);
  return user && user.role === 'admin';
}

function getAdminPhone() {
  const admin = getDb().prepare("SELECT phone FROM users WHERE role = 'admin' LIMIT 1").get();
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
  const today = time.getCurrentDate();
  return getDb().prepare(
    'SELECT * FROM attendance_log WHERE phone = ? AND date = ? AND type = ?'
  ).get(phone, today, type);
}

function confirmAttendance(phone, type, method = 'manual') {
  const today = time.getCurrentDate();
  const now = time.getConfirmationTime();
  const stmt = getDb().prepare(`
    INSERT INTO attendance_log (phone, date, type, confirmed_at, method)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(phone, date, type) DO NOTHING
  `);
  stmt.run(phone, today, type, now, method);
  return getAttendanceToday(phone, type);
}

function getAttendanceHistory(phone, limit = 14) {
  return getDb().prepare(
    'SELECT * FROM attendance_log WHERE phone = ? ORDER BY date DESC, type ASC LIMIT ?'
  ).all(phone, limit);
}

function getAttendanceForDateRange(phone, startDate, endDate) {
  return getDb().prepare(
    'SELECT * FROM attendance_log WHERE phone = ? AND date >= ? AND date <= ? ORDER BY date, type'
  ).all(phone, startDate, endDate);
}

function getWeeklyAttendanceSummary(startDate, endDate) {
  return getDb().prepare(`
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
  `).all(startDate, endDate);
}

// ─── Leave request operations ───────────────────────────────────────

function addLeaveRequest(phone, startDate, endDate, reason) {
  const stmt = getDb().prepare(`
    INSERT INTO leave_requests (phone, start_date, end_date, reason, status)
    VALUES (?, ?, ?, ?, 'approved')
  `);
  const result = stmt.run(phone, startDate, endDate, reason);
  return result.lastInsertRowid;
}

function getActiveLeaves(phone, date) {
  return getDb().prepare(
    `SELECT * FROM leave_requests 
     WHERE phone = ? AND start_date <= ? AND end_date >= ? AND status = 'approved'`
  ).all(phone, date, date);
}

function getAllLeaves(phone) {
  return getDb().prepare(
    'SELECT * FROM leave_requests WHERE phone = ? ORDER BY start_date DESC LIMIT 10'
  ).all(phone);
}

function cancelLeave(leaveId, phone) {
  getDb().prepare(
    'UPDATE leave_requests SET status = \'cancelled\' WHERE id = ? AND phone = ?'
  ).run(leaveId, phone);
}

// ─── Holiday operations ─────────────────────────────────────────────

function addHoliday(date, name, isNational = false, createdBy = null) {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO holidays (date, name, is_national, created_by)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(date, name, isNational ? 1 : 0, createdBy);
}

function isHoliday(date) {
  const row = getDb().prepare('SELECT * FROM holidays WHERE date = ?').get(date);
  return !!row;
}

function getHoliday(date) {
  return getDb().prepare('SELECT * FROM holidays WHERE date = ?').get(date);
}

function getUpcomingHolidays(limit = 10) {
  const today = time.getCurrentDate();
  return getDb().prepare(
    'SELECT * FROM holidays WHERE date >= ? ORDER BY date ASC LIMIT ?'
  ).all(today, limit);
}

function removeHoliday(date) {
  getDb().prepare('DELETE FROM holidays WHERE date = ? AND is_national = 0').run(date);
}

function syncNationalHolidays(holidays) {
  // Clear old national holidays
  getDb().prepare('DELETE FROM holidays WHERE is_national = 1').run();
  
  // Insert new national holidays
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO holidays (date, name, is_national)
    VALUES (?, ?, 1)
  `);

  for (const holiday of holidays) {
    stmt.run(holiday.date, holiday.name);
  }
}

// ─── Rate limiting ──────────────────────────────────────────────────

function checkRateLimit(phone, maxMessages, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const row = getDb().prepare('SELECT * FROM rate_limit WHERE phone = ?').get(phone);

  if (!row) {
    // First message
    getDb().prepare('INSERT INTO rate_limit (phone, last_message_at, message_count) VALUES (?, ?, 1)')
      .run(phone, now);
    return { allowed: true, count: 1 };
  }

  const timeSinceFirst = now - row.last_message_at;

  if (timeSinceFirst > windowSeconds) {
    // Window expired, reset
    getDb().prepare('UPDATE rate_limit SET last_message_at = ?, message_count = 1 WHERE phone = ?')
      .run(now, phone);
    return { allowed: true, count: 1 };
  }

  if (row.message_count >= maxMessages) {
    // Rate limit exceeded
    return { allowed: false, count: row.message_count, resetIn: windowSeconds - timeSinceFirst };
  }

  // Increment count
  getDb().prepare('UPDATE rate_limit SET message_count = message_count + 1 WHERE phone = ?')
    .run(phone);
  return { allowed: true, count: row.message_count + 1 };
}

function resetRateLimit(phone) {
  getDb().prepare('DELETE FROM rate_limit WHERE phone = ?').run(phone);
}

// ─── Snooze operations ──────────────────────────────────────────────

function getSnoozeCount(phone, type) {
  const today = time.getCurrentDate();
  const row = getDb().prepare(
    'SELECT count FROM snooze_state WHERE phone = ? AND date = ? AND type = ?'
  ).get(phone, today, type);
  return row ? row.count : 0;
}

function incrementSnooze(phone, type) {
  const today = time.getCurrentDate();
  getDb().prepare(`
    INSERT INTO snooze_state (phone, date, type, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(phone, date, type) DO UPDATE SET count = count + 1
  `).run(phone, today, type);
  return getSnoozeCount(phone, type);
}

function resetDailySnooze() {
  const today = time.getCurrentDate();
  getDb().prepare('DELETE FROM snooze_state WHERE date < ?').run(today);
}

// ─── Database backup ────────────────────────────────────────────────

function backupDatabase() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `reminder-${timestamp}.db`);
    
    // Close WAL mode temporarily for clean backup
    db.pragma('wal_checkpoint(TRUNCATE)');
    
    // Copy database file
    fs.copyFileSync(DB_PATH, backupPath);
    
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
