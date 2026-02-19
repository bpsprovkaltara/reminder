#!/usr/bin/env node

/**
 * Migrasi Data: SQLite → PostgreSQL
 * 
 * Script ini membaca data dari database SQLite lama (data/reminder.db)
 * dan menginsert ke PostgreSQL baru.
 * 
 * Prerequisite:
 *   - PostgreSQL sudah running (docker compose up postgres)
 *   - Tabel sudah dibuat (otomatis oleh database.js connect)
 *   - File SQLite ada di data/reminder.db
 * 
 * Usage:
 *   DATABASE_URL=postgresql://reminder:reminder_secret@localhost:5432/reminder \
 *     node scripts/migrate-sqlite-to-pg.js
 * 
 *   # Dari dalam Docker container:
 *   docker exec -it bpsprovkaltara-reminder-presensi-bps \
 *     node scripts/migrate-sqlite-to-pg.js
 * 
 *   # Dry run (hanya tampilkan data, tidak insert):
 *   node scripts/migrate-sqlite-to-pg.js --dry-run
 */

const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const SQLITE_PATH = path.join(__dirname, '..', 'data', 'reminder.db');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://reminder:reminder_secret@localhost:5432/reminder';
const dryRun = process.argv.includes('--dry-run');

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  console.error('❌ better-sqlite3 tidak ditemukan.');
  console.error('   Install sementara: npm install better-sqlite3');
  console.error('   Atau jalankan dari environment yang masih punya better-sqlite3.');
  process.exit(1);
}

async function migrate() {
  // Check SQLite file exists
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`❌ File SQLite tidak ditemukan: ${SQLITE_PATH}`);
    process.exit(1);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🔄  Migrasi Data: SQLite → PostgreSQL');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  📄 Source  : ${SQLITE_PATH}`);
  console.log(`  🐘 Target  : ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  if (dryRun) console.log('  ⚠️  Mode    : DRY RUN');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pg = new Pool({ connectionString: DATABASE_URL });

  const counts = {
    users: 0,
    attendance_log: 0,
    leave_requests: 0,
    holidays: 0,
    snooze_state: 0,
    settings: 0,
  };

  try {
    // ─── Create tables in PG (same as database.js initTables) ─────
    if (!dryRun) {
      const db = require(path.join(__dirname, '..', 'src', 'db', 'database'));
      await db.connect();
    }

    // ─── Migrate users ──────────────────────────────────────────────
    console.log('📋 Migrating users...');
    const users = sqlite.prepare('SELECT * FROM users').all();

    for (const u of users) {
      if (dryRun) {
        console.log(`   [DRY] ${u.phone} - ${u.name} (${u.role})`);
      } else {
        await pg.query(`
          INSERT INTO users (phone, name, role, reminder_pagi, reminder_sore, jadwal_khusus, hari_kerja, max_followups, is_active, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT(phone) DO UPDATE SET
            name = $2, role = $3, reminder_pagi = $4, reminder_sore = $5,
            jadwal_khusus = $6, hari_kerja = $7, max_followups = $8,
            is_active = $9, updated_at = $11
        `, [
          u.phone,
          u.name,
          u.role || 'user',
          u.reminder_pagi || '07:25',
          u.reminder_sore || '16:05',
          u.jadwal_khusus || '{"5":{"sore":"16:35"}}',
          u.hari_kerja || '[1,2,3,4,5]',
          u.max_followups || 2,
          u.is_active === 1 || u.is_active === true,
          u.created_at ? new Date(u.created_at) : new Date(),
          u.updated_at ? new Date(u.updated_at) : new Date(),
        ]);
      }
      counts.users++;
    }
    console.log(`   ✅ ${counts.users} users`);

    // ─── Migrate attendance_log ─────────────────────────────────────
    console.log('📋 Migrating attendance_log...');
    let attendanceLogs;
    try {
      attendanceLogs = sqlite.prepare('SELECT * FROM attendance_log').all();
    } catch {
      attendanceLogs = [];
      console.log('   ⚠️  Tabel attendance_log tidak ada di SQLite, skip.');
    }

    for (const a of attendanceLogs) {
      if (dryRun) {
        console.log(`   [DRY] ${a.phone} ${a.date} ${a.type} ${a.confirmed_at}`);
      } else {
        try {
          await pg.query(`
            INSERT INTO attendance_log (phone, date, type, confirmed_at, method)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT(phone, date, type) DO NOTHING
          `, [a.phone, a.date, a.type, a.confirmed_at, a.method || 'manual']);
          counts.attendance_log++;
        } catch (err) {
          console.error(`   ⚠️ Skip attendance ${a.phone} ${a.date} ${a.type}: ${err.message}`);
        }
      }
    }
    if (!dryRun) console.log(`   ✅ ${counts.attendance_log} records`);
    else { counts.attendance_log = attendanceLogs.length; console.log(`   ✅ ${counts.attendance_log} records`); }

    // ─── Migrate leave_requests ─────────────────────────────────────
    console.log('📋 Migrating leave_requests...');
    let leaveRequests;
    try {
      leaveRequests = sqlite.prepare('SELECT * FROM leave_requests').all();
    } catch {
      leaveRequests = [];
      console.log('   ⚠️  Tabel leave_requests tidak ada di SQLite, skip.');
    }

    for (const l of leaveRequests) {
      if (dryRun) {
        console.log(`   [DRY] ${l.phone} ${l.start_date}..${l.end_date} ${l.reason}`);
      } else {
        try {
          await pg.query(`
            INSERT INTO leave_requests (phone, start_date, end_date, reason, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            l.phone, l.start_date, l.end_date, l.reason,
            l.status || 'approved',
            l.created_at ? new Date(l.created_at) : new Date(),
          ]);
          counts.leave_requests++;
        } catch (err) {
          console.error(`   ⚠️ Skip leave ${l.phone}: ${err.message}`);
        }
      }
    }
    if (!dryRun) console.log(`   ✅ ${counts.leave_requests} records`);
    else { counts.leave_requests = leaveRequests.length; console.log(`   ✅ ${counts.leave_requests} records`); }

    // ─── Migrate holidays ───────────────────────────────────────────
    console.log('📋 Migrating holidays...');
    let holidays;
    try {
      holidays = sqlite.prepare('SELECT * FROM holidays').all();
    } catch {
      holidays = [];
      console.log('   ⚠️  Tabel holidays tidak ada di SQLite, skip.');
    }

    for (const h of holidays) {
      if (dryRun) {
        console.log(`   [DRY] ${h.date} - ${h.name} (${h.is_national ? 'national' : 'office'})`);
      } else {
        try {
          await pg.query(`
            INSERT INTO holidays (date, name, is_national, created_by, created_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT(date) DO UPDATE SET name = $2, is_national = $3
          `, [
            h.date, h.name,
            h.is_national === 1 || h.is_national === true,
            h.created_by || null,
            h.created_at ? new Date(h.created_at) : new Date(),
          ]);
          counts.holidays++;
        } catch (err) {
          console.error(`   ⚠️ Skip holiday ${h.date}: ${err.message}`);
        }
      }
    }
    if (!dryRun) console.log(`   ✅ ${counts.holidays} records`);
    else { counts.holidays = holidays.length; console.log(`   ✅ ${counts.holidays} records`); }

    // ─── Migrate settings ───────────────────────────────────────────
    console.log('📋 Migrating settings...');
    let settings;
    try {
      settings = sqlite.prepare('SELECT * FROM settings').all();
    } catch {
      settings = [];
    }

    for (const s of settings) {
      if (dryRun) {
        console.log(`   [DRY] ${s.key} = ${s.value}`);
      } else {
        try {
          await pg.query(`
            INSERT INTO settings (key, value) VALUES ($1, $2)
            ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = NOW()
          `, [s.key, s.value]);
          counts.settings++;
        } catch (err) {
          console.error(`   ⚠️ Skip setting ${s.key}: ${err.message}`);
        }
      }
    }
    if (!dryRun) console.log(`   ✅ ${counts.settings} records`);
    else { counts.settings = settings.length; console.log(`   ✅ ${counts.settings} records`); }

    // ─── Summary ────────────────────────────────────────────────────
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  📊 Ringkasan Migrasi:');
    console.log(`     👥 Users          : ${counts.users}`);
    console.log(`     📋 Attendance Log : ${counts.attendance_log}`);
    console.log(`     📝 Leave Requests : ${counts.leave_requests}`);
    console.log(`     🎉 Holidays       : ${counts.holidays}`);
    console.log(`     ⚙️  Settings       : ${counts.settings}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (dryRun) {
      console.log('');
      console.log('💡 Jalankan tanpa --dry-run untuk melakukan migrasi.');
    } else {
      console.log('');
      console.log('✅ Migrasi selesai! Database PostgreSQL siap digunakan.');
    }

    console.log('');

  } catch (err) {
    console.error('❌ Migration error:', err);
  } finally {
    sqlite.close();
    await pg.end();
  }
}

migrate().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
