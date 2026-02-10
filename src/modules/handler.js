const db = require('../db/database');
const defaults = require('../config/defaults');
const time = require('../config/time');
const scheduler = require('./scheduler');
const wa = require('./whatsapp');

// Track which reminder type is currently active per user
// so we know if "1" or "2" reply refers to pagi/sore
const pendingReminders = new Map();

// Track users who are in the registration flow (awaiting name input)
const pendingRegistrations = new Map();

// Track users in leave/perjadin flow (awaiting end date)
// Map<phone, { type: 'cuti'|'perjadin', startDate: 'YYYY-MM-DD' }>
const pendingLeaveFlow = new Map();

// Commands that require admin role
const ADMIN_COMMANDS = ['#users', '#adduser', '#removeuser', '#test', '#waktu', '#broadcast', '#libur'];

function setPendingReminder(phone, type) {
  pendingReminders.set(phone, type);
}

function getCurrentReminderType(phone) {
  // Determine type based on pending context or time of day
  if (pendingReminders.has(phone)) {
    return pendingReminders.get(phone);
  }
  const hour = Number(time.getCurrentTime().split(':')[0]);
  return hour < 12 ? 'pagi' : 'sore';
}

async function handleMessage(message) {
  // Only handle private messages (not groups)
  if (message.from.endsWith('@g.us')) return;

  const body = message.body.trim();

  // Get contact info and normalize phone number
  const contact = await message.getContact();
  let phone = contact.number || contact.id?.user || message.from.replace(/@(c\.us|lid)$/, '');

  // Normalize: ensure it starts with country code (62 for Indonesia)
  if (phone.startsWith('0')) {
    phone = '62' + phone.slice(1);
  }

  // ─── Rate limiting ──────────────────────────────────────────────
  const rateCheck = db.checkRateLimit(
    phone,
    defaults.RATE_LIMIT_MAX_MESSAGES,
    defaults.RATE_LIMIT_WINDOW_SECONDS
  );

  if (!rateCheck.allowed) {
    console.log(`[RateLimit] ${phone} exceeded limit (${rateCheck.count} messages)`);
    const msg = defaults.MESSAGES.RATE_LIMIT_EXCEEDED
      .replace('{seconds}', rateCheck.resetIn);
    return message.reply(msg);
  }

  // ─── Registration flow ──────────────────────────────────────────
  // Check if user is in registration flow (awaiting name input)
  if (pendingRegistrations.has(phone)) {
    return handleRegistration(message, phone, body);
  }

  // ─── Leave/Perjadin flow ────────────────────────────────────────
  // Check if user is in leave flow (awaiting end date)
  if (pendingLeaveFlow.has(phone)) {
    return handleLeaveFlow(message, phone, body);
  }

  // Check if user exists in database
  const user = db.getUser(phone);
  if (!user) {
    // New user → start registration flow
    pendingRegistrations.set(phone, true);
    return message.reply(defaults.MESSAGES.REGISTRATION_WELCOME);
  }

  // ─── Existing registered user ──────────────────────────────────
  // Quick reply: "1" = Sudah Absen, "2" = Ingatkan Nanti, "3" = Cuti, "4" = Perjadin
  if (body === '1') {
    return handleConfirmAbsen(message, phone);
  }
  if (body === '2') {
    return handleSnooze(message, phone);
  }
  if (body === '3') {
    return handleQuickLeave(message, phone, 'Cuti');
  }
  if (body === '4') {
    return handleQuickLeave(message, phone, 'Perjadin');
  }

  // Command-based messages
  if (body.startsWith('#')) {
    return handleCommand(message, phone, body);
  }

  // Fallback: show help for unrecognized messages
  if (body.length > 0) {
    return message.reply('Ketik *#help* untuk melihat panduan perintah. 📋');
  }
}

// ─── Registration handler ─────────────────────────────────────────

async function handleRegistration(message, phone, body) {
  // Don't allow commands during registration
  if (body.startsWith('#')) {
    return message.reply(
      '⚠️ Silakan selesaikan pendaftaran terlebih dahulu.\n\n'
      + 'Kirimkan *nama lengkap* kamu.\n'
      + '_Contoh: Budi Santoso_'
    );
  }

  const name = body.trim();

  // Validate: min 2 chars, not purely numeric
  if (name.length < 2 || /^\d+$/.test(name)) {
    return message.reply(defaults.MESSAGES.REGISTRATION_INVALID);
  }

  // Register the user (check if it's primary admin)
  const role = phone === defaults.PRIMARY_ADMIN ? 'admin' : 'user';
  pendingRegistrations.delete(phone);
  db.upsertUser(phone, name, role);

  // Build welcome message with schedule info
  const welcomeLines = [
    '✅  *PENDAFTARAN BERHASIL!*',
    '━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `Hai *${name}*! 🎉`,
    role === 'admin' ? '_(Terdaftar sebagai Admin)_ 👑' : '',
    'Kamu terdaftar di Reminder Presensi BPS.',
    '',
    '⏰ *Jadwal reminder:*',
    `  ☀️ Pagi : ${defaults.REMINDER_PAGI}`,
    `  🌆 Sore : ${defaults.REMINDER_SORE}`,
    `  🌆 Jumat Sore : 16:35`,
    '  📅 Senin — Jumat',
    '',
    'Ketik *#help* untuk panduan perintah.',
  ].filter(Boolean); // remove empty strings

  return message.reply(welcomeLines.join('\n'));
}

// ─── Quick reply handlers ─────────────────────────────────────────

async function handleConfirmAbsen(message, phone) {
  const type = getCurrentReminderType(phone);
  const user = db.getUser(phone);
  const name = user ? user.name : 'kamu';

  const existing = db.getAttendanceToday(phone, type);
  if (existing) {
    const text = defaults.MESSAGES.ALREADY_CONFIRMED
      .replace('{type}', type)
      .replace('{time}', existing.confirmed_at);
    return message.reply(text);
  }

  const record = db.confirmAttendance(phone, type, 'manual');
  pendingReminders.delete(phone);

  // Stop auto-resend since user has confirmed
  scheduler.stopAutoResend(phone, type);

  const text = defaults.MESSAGES.CONFIRMED
    .replace(/\{type\}/g, type)
    .replace(/\{name\}/g, name)
    .replace(/\{time\}/g, record.confirmed_at)
    .replace(/\{date\}/g, time.getDisplayDate());
  return message.reply(text);
}

async function handleSnooze(message, phone) {
  const type = getCurrentReminderType(phone);
  const user = db.getUser(phone);
  const name = user ? user.name : 'kamu';

  const existing = db.getAttendanceToday(phone, type);
  if (existing) {
    const text = defaults.MESSAGES.ALREADY_CONFIRMED
      .replace('{type}', type)
      .replace('{time}', existing.confirmed_at);
    return message.reply(text);
  }

  // Acknowledge — auto-resend handles the periodic reminders
  const text = defaults.MESSAGES.SNOOZED
    .replace(/\{name\}/g, name);
  return message.reply(text);
}

async function handleQuickLeave(message, phone, leaveType) {
  const user = db.getUser(phone);
  const name = user ? user.name : 'kamu';
  const startDate = time.getCurrentDate();

  // Set pending leave flow
  pendingLeaveFlow.set(phone, { type: leaveType, startDate });

  // Ask for end date
  const text = defaults.MESSAGES.LEAVE_ASK_END_DATE
    .replace(/\{type\}/g, leaveType)
    .replace(/\{name\}/g, name);

  return message.reply(text);
}

async function handleLeaveFlow(message, phone, body) {
  const leaveData = pendingLeaveFlow.get(phone);
  if (!leaveData) {
    pendingLeaveFlow.delete(phone);
    return message.reply('⚠️ Sesi expired. Silakan pilih opsi cuti/perjadin lagi.');
  }

  const { type: leaveType, startDate } = leaveData;
  const user = db.getUser(phone);
  const name = user ? user.name : 'kamu';

  let endDate;

  // Parse input
  const input = body.trim();

  if (input === '0') {
    // Today only
    endDate = startDate;
  } else if (input === '1') {
    // Tomorrow
    const tomorrow = new Date(startDate + 'T12:00:00');
    tomorrow.setDate(tomorrow.getDate() + 1);
    endDate = tomorrow.toISOString().slice(0, 10);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    // Full date format
    endDate = input;
  } else {
    // Invalid format
    return message.reply(defaults.MESSAGES.LEAVE_INVALID_DATE);
  }

  // Validate end date is not before start date
  if (endDate < startDate) {
    return message.reply('⚠️ Tanggal akhir tidak boleh sebelum tanggal mulai.\n\n_Silakan kirim tanggal yang valid._');
  }

  // Register leave request
  const reason = leaveType; // Use leave type as reason
  db.addLeaveRequest(phone, startDate, endDate, reason);

  // Stop auto-resend if active
  scheduler.stopAutoResend(phone, 'pagi');
  scheduler.stopAutoResend(phone, 'sore');

  // Clear pending state
  pendingLeaveFlow.delete(phone);
  pendingReminders.delete(phone);

  // Send confirmation
  const text = defaults.MESSAGES.LEAVE_REGISTERED
    .replace(/\{type\}/g, leaveType)
    .replace(/\{start\}/g, startDate)
    .replace(/\{end\}/g, endDate);

  return message.reply(text);
}

// ─── Command router ──────────────────────────────────────────────

async function handleCommand(message, phone, body) {
  const parts = body.toLowerCase().split(/\s+/);
  const cmd = parts[0];

  // Check if command requires admin role
  if (ADMIN_COMMANDS.includes(cmd)) {
    if (!db.isAdmin(phone)) {
      return message.reply('⛔ Perintah ini hanya bisa digunakan oleh *Admin*.\n\nKetik *#help* untuk melihat perintah yang tersedia.');
    }
  }

  switch (cmd) {
    case '#help':
      return cmdHelp(message, phone);

    case '#status':
      return cmdStatus(message, phone);

    case '#jadwal':
      return cmdJadwal(message, phone);

    case '#setwaktu':
      return cmdSetWaktu(message, phone, parts);

    case '#hari':
      return cmdHari(message, phone, parts);

    case '#nama':
      return cmdNama(message, phone, body);

    case '#izin':
      return cmdIzin(message, phone, body);

    case '#maxpengingat':
      return cmdMaxPengingat(message, phone, parts);

    case '#pause':
      return cmdPause(message, phone);

    case '#resume':
      return cmdResume(message, phone);

    case '#riwayat':
      return cmdRiwayat(message, phone);

    // Admin-only commands
    case '#users':
      return cmdUsers(message);

    case '#adduser':
      return cmdAddUser(message, phone, parts, body);

    case '#removeuser':
      return cmdRemoveUser(message, phone, parts);

    case '#libur':
      return cmdLibur(message, phone, body);

    case '#test':
      return cmdTest(message, phone, parts);

    case '#waktu':
      return cmdWaktu(message);

    case '#broadcast':
      return cmdBroadcast(message, phone, body);

    default:
      return message.reply('Perintah tidak dikenal. Ketik *#help* untuk panduan. 📋');
  }
}

// ─── User Commands ──────────────────────────────────────────────────

async function cmdHelp(message, phone) {
  const isAdminUser = db.isAdmin(phone);
  const user = db.getUser(phone);

  const lines = [
    '📋  *PANDUAN REMINDER BPS*',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `👤 *${user ? user.name : '-'}* ${isAdminUser ? '_(Admin 👑)_' : '_(User)_'}`,
    '',
    '📌 *Perintah Utama*',
    '• *#status* — Cek status absen',
    '• *#jadwal* — Lihat jadwal reminder',
    '• *#riwayat* — Riwayat absen 7 hari',
    '',
    '⏰ *Atur Jadwal*',
    '• *#setwaktu pagi 07:25*',
    '• *#setwaktu sore 16:05*',
    '• *#setwaktu sore 16:35 jumat*',
    '  ↳ _Atur khusus hari tertentu_',
    '• *#setwaktu sore reset jumat*',
    '  ↳ _Kembalikan ke default_',
    '',
    '📅 *Hari Kerja & Cuti*',
    '• *#hari* — Lihat hari kerja',
    '• *#hari 1,2,3,4,5*',
    '  ↳ _(1=Sen, 2=Sel, ..., 7=Min)_',
    '• *#izin tanggal alasan*',
    '  ↳ _Lapor cuti/izin/sakit_',
    '  ↳ _Contoh: #izin 2026-02-10 Sakit_',
    '  ↳ _Rentang: #izin 2026-02-10..15 Cuti_',
    '',
    '🔔 *Pengaturan Reminder*',
    '• *#maxpengingat* — Lihat/atur',
    '  ↳ _jumlah pengingat susulan_',
    '  ↳ _Minimal: 1, Maksimal: 10_',
    '  ↳ _Contoh: #maxpengingat 5_',
    '',
    '👤 *Profil*',
    '• *#nama* — Lihat nama kamu',
    '• *#nama Nama Baru*',
    '  ↳ _Ubah nama_',
    '',
    '⏸️ *Kontrol*',
    '• *#pause* — Nonaktifkan reminder',
    '• *#resume* — Aktifkan reminder',
  ];

  if (isAdminUser) {
    lines.push(
      '',
      '🔧 *Perintah Admin*',
      '• *#users* — Daftar user terdaftar',
      '• *#adduser 628xxx Nama*',
      '  ↳ _Tambah user baru_',
      '• *#removeuser 628xxx*',
      '  ↳ _Hapus user_',
      '• *#libur tanggal keterangan*',
      '  ↳ _Tambah hari libur kantor_',
      '  ↳ _Contoh: #libur 2026-02-14 Cuti Bersama_',
      '• *#broadcast pesan*',
      '  ↳ _Kirim ke semua user aktif_',
      '• *#test pagi/sore*',
      '  ↳ _Trigger reminder manual_',
      '• *#waktu* — Info waktu sistem',
    );
  }

  lines.push(
    '',
    '❓ *#help* — Tampilkan panduan ini',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '💬 *Quick Reply di Reminder:*',
    '_• Balas *1* = Sudah Absen_',
    '_• Balas *2* = Ingatkan Nanti_',
    '_• Balas *3* = Cuti_',
    '_• Balas *4* = Perjadin_',
  );

  return message.reply(lines.join('\n'));
}

async function cmdStatus(message, phone) {
  const user = db.getUser(phone);
  const pagi = db.getAttendanceToday(phone, 'pagi');
  const sore = db.getAttendanceToday(phone, 'sore');
  const today = time.getDisplayDate();
  const todayDate = time.getCurrentDate();

  const lines = [
    '📊  *STATUS ABSEN HARI INI*',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `👤 *${user ? user.name : '-'}*`,
    `📅 ${today}`,
    '',
  ];

  // Check if today is holiday
  if (db.isHoliday(todayDate)) {
    const holiday = db.getHoliday(todayDate);
    lines.push(`🎉 *HARI LIBUR*`);
    lines.push(`_${holiday.name}_`);
    lines.push('');
    lines.push('Tidak ada reminder hari ini.');
    return message.reply(lines.join('\n'));
  }

  // Check if on leave
  const leaves = db.getActiveLeaves(phone, todayDate);
  if (leaves.length > 0) {
    lines.push(`📝 *IZIN/CUTI*`);
    lines.push(`_${leaves[0].reason}_`);
    lines.push('');
    lines.push('Reminder dinonaktifkan untuk hari ini.');
    return message.reply(lines.join('\n'));
  }

  lines.push(
    `☀️ Pagi : ${pagi ? `✅ ${pagi.confirmed_at} _(${pagi.method})_` : '❌ Belum absen'}`,
    `🌆 Sore : ${sore ? `✅ ${sore.confirmed_at} _(${sore.method})_` : '❌ Belum absen'}`,
  );

  // Show auto-resend status if active
  const pagiResend = scheduler.isAutoResendActive(phone, 'pagi');
  const soreResend = scheduler.isAutoResendActive(phone, 'sore');
  if (pagiResend || soreResend) {
    lines.push('');
    if (pagiResend) lines.push('🔔 _Auto-reminder pagi aktif_');
    if (soreResend) lines.push('🔔 _Auto-reminder sore aktif_');
  }

  return message.reply(lines.join('\n'));
}

async function cmdJadwal(message, phone) {
  const user = db.getUser(phone);
  if (!user) return message.reply('Data user tidak ditemukan. Kirim pesan apapun untuk mendaftar.');

  const hariKerja = JSON.parse(user.hari_kerja);
  const hariDisplay = hariKerja.map((d) => defaults.HARI_NAMES[d]).join(', ');

  const lines = [
    '📅  *JADWAL REMINDER*',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '⏰ *Waktu Default*',
    `  ☀️ Pagi : *${user.reminder_pagi}*`,
    `  🌆 Sore : *${user.reminder_sore}*`,
  ];

  // Show day-specific overrides
  try {
    const jadwalKhusus = JSON.parse(user.jadwal_khusus || '{}');
    const overrides = Object.entries(jadwalKhusus);

    if (overrides.length > 0) {
      lines.push('', '📋 *Jadwal Khusus*');
      for (const [dayStr, times] of overrides) {
        const dayNum = Number(dayStr);
        const dayName = defaults.HARI_NAMES_FULL[dayNum];
        if (times.pagi) {
          lines.push(`  ☀️ ${dayName} Pagi : *${times.pagi}*`);
        }
        if (times.sore) {
          lines.push(`  🌆 ${dayName} Sore : *${times.sore}*`);
        }
      }
    }
  } catch (err) {
    // Ignore parse errors
  }

  lines.push(
    '',
    '📅 *Hari Kerja*',
    `  ${hariDisplay}`,
    '',
    `${user.is_active ? '🟢' : '🔴'} Status: *${user.is_active ? 'Aktif' : 'Nonaktif'}*`,
  );

  // Show upcoming holidays
  const upcomingHolidays = db.getUpcomingHolidays(5);
  if (upcomingHolidays.length > 0) {
    lines.push('', '🎉 *Hari Libur Mendatang*');
    for (const h of upcomingHolidays) {
      lines.push(`  • ${h.date} — ${h.name}`);
    }
  }

  lines.push(
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '_Atur waktu: *#setwaktu pagi/sore HH:MM*_',
    '_Khusus hari: *#setwaktu sore 16:35 jumat*_',
  );

  return message.reply(lines.join('\n'));
}

async function cmdSetWaktu(message, phone, parts) {
  if (parts.length < 3) {
    return message.reply(
      '📝 *Format:*\n\n'
      + '• *#setwaktu pagi HH:MM*\n'
      + '  ↳ Atur waktu default pagi\n\n'
      + '• *#setwaktu sore HH:MM*\n'
      + '  ↳ Atur waktu default sore\n\n'
      + '• *#setwaktu sore 16:35 jumat*\n'
      + '  ↳ Atur khusus hari tertentu\n\n'
      + '• *#setwaktu sore reset jumat*\n'
      + '  ↳ Hapus jadwal khusus'
    );
  }

  const type = parts[1];
  const timeStr = parts[2];
  const dayName = parts[3]; // optional

  if (!['pagi', 'sore'].includes(type)) {
    return message.reply('⚠️ Tipe harus *pagi* atau *sore*.');
  }

  // If day name is provided → day-specific schedule
  if (dayName) {
    const dayNum = defaults.HARI_MAP[dayName];
    if (dayNum === undefined) {
      const validDays = Object.keys(defaults.HARI_MAP)
        .filter((k) => k.length > 3)
        .join(', ');
      return message.reply(`⚠️ Nama hari tidak valid.\n\nGunakan: ${validDays}`);
    }

    const user = db.getUser(phone);
    const jadwalKhusus = JSON.parse(user.jadwal_khusus || '{}');
    const dayStr = String(dayNum);
    const dayFullName = defaults.HARI_NAMES_FULL[dayNum];

    // Handle reset/default
    if (timeStr === 'reset' || timeStr === 'default') {
      if (jadwalKhusus[dayStr]) {
        delete jadwalKhusus[dayStr][type];
        // Remove day entry if empty
        if (Object.keys(jadwalKhusus[dayStr]).length === 0) {
          delete jadwalKhusus[dayStr];
        }
      }
      db.updateUserSetting(phone, 'jadwal_khusus', JSON.stringify(jadwalKhusus));
      return message.reply(`✅ Jadwal ${type} hari *${dayFullName}* dikembalikan ke default (*${type === 'pagi' ? user.reminder_pagi : user.reminder_sore}*).`);
    }

    // Validate time format
    if (!/^\d{2}:\d{2}$/.test(timeStr)) {
      return message.reply('⚠️ Format waktu harus *HH:MM* (contoh: 07:25)');
    }
    const [h, m] = timeStr.split(':').map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return message.reply('⚠️ Jam tidak valid. Gunakan format 24 jam (00:00 - 23:59).');
    }

    // Set day-specific override
    if (!jadwalKhusus[dayStr]) {
      jadwalKhusus[dayStr] = {};
    }
    jadwalKhusus[dayStr][type] = timeStr;

    db.updateUserSetting(phone, 'jadwal_khusus', JSON.stringify(jadwalKhusus));
    return message.reply(`✅ Jadwal ${type} hari *${dayFullName}* diatur ke *${timeStr}*.`);
  }

  // No day name → set default time
  if (timeStr === 'reset' || timeStr === 'default') {
    const defaultTime = type === 'pagi' ? defaults.REMINDER_PAGI : defaults.REMINDER_SORE;
    const field = type === 'pagi' ? 'reminder_pagi' : 'reminder_sore';
    db.updateUserSetting(phone, field, defaultTime);
    return message.reply(`✅ Waktu default ${type} dikembalikan ke *${defaultTime}*.`);
  }

  // Validate time format
  if (!/^\d{2}:\d{2}$/.test(timeStr)) {
    return message.reply('⚠️ Format waktu harus *HH:MM* (contoh: 07:25)');
  }
  const [h, m] = timeStr.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    return message.reply('⚠️ Jam tidak valid. Gunakan format 24 jam (00:00 - 23:59).');
  }

  const field = type === 'pagi' ? 'reminder_pagi' : 'reminder_sore';
  db.updateUserSetting(phone, field, timeStr);
  return message.reply(`✅ Waktu default reminder ${type} diatur ke *${timeStr}*.`);
}

async function cmdHari(message, phone, parts) {
  const user = db.getUser(phone);

  // If just "#hari" - show current setting
  if (parts.length < 2) {
    const hariKerja = JSON.parse(user.hari_kerja);
    const display = hariKerja.map((d) => defaults.HARI_NAMES[d]).join(', ');
    return message.reply(
      `📅 *Hari kerja aktif:* ${display}\n\n`
      + 'Untuk mengubah:\n'
      + '*#hari 1,2,3,4,5*\n'
      + '_(1=Sen, 2=Sel, 3=Rab, 4=Kam, 5=Jum, 6=Sab, 7=Min)_'
    );
  }

  // Parse: #hari 1,2,3,4,5
  const input = parts[1].split(',').map(Number);
  const valid = input.every((n) => n >= 1 && n <= 7);
  if (!valid) {
    return message.reply('⚠️ Format: *#hari 1,2,3,4,5*\n_(1=Sen, 2=Sel, ..., 7=Min)_');
  }

  // Convert user input (1=Mon..7=Sun) to JS day (0=Sun..6=Sat)
  const jsDays = input.map((n) => (n === 7 ? 0 : n));
  db.updateUserSetting(phone, 'hari_kerja', JSON.stringify(jsDays));

  const display = jsDays.map((d) => defaults.HARI_NAMES[d]).join(', ');
  return message.reply(`✅ Hari kerja diatur ke: *${display}*`);
}

async function cmdNama(message, phone, body) {
  // Extract name from original body (preserves casing)
  const nameStr = body.slice(body.toLowerCase().indexOf('#nama') + '#nama'.length).trim();

  if (!nameStr) {
    const user = db.getUser(phone);
    return message.reply(`👤 Nama kamu saat ini: *${user ? user.name : '-'}*\n\nUntuk mengubah: *#nama Nama Baru*`);
  }

  if (nameStr.length < 2) {
    return message.reply('⚠️ Nama minimal 2 karakter.');
  }

  db.upsertUser(phone, nameStr);
  return message.reply(`✅ Nama diperbarui ke *${nameStr}*.`);
}

async function cmdMaxPengingat(message, phone, parts) {
  const user = db.getUser(phone);
  const current = user.max_followups || defaults.DEFAULT_MAX_FOLLOWUPS;

  // Show current setting
  if (parts.length < 2) {
    return message.reply(
      `🔔 *Jumlah Pengingat Susulan*\n\n`
      + `Saat ini: *${current} pengingat*\n`
      + `(1 reminder utama + ${current} pengingat susulan)\n\n`
      + `Untuk mengubah:\n`
      + `*#maxpengingat <jumlah>*\n\n`
      + `_Minimal: 1 (reminder utama + 1 susulan)_\n`
      + `_Maksimal: 10_\n\n`
      + `_Contoh: #maxpengingat 5_`
    );
  }

  const newMax = Number(parts[1]);

  // Validate
  if (isNaN(newMax) || newMax < 1 || newMax > 10) {
    return message.reply('⚠️ Jumlah tidak valid.\n\n_Minimal: 1, Maksimal: 10_\n\n_Contoh: #maxpengingat 5_');
  }

  // Update
  db.updateUserSetting(phone, 'max_followups', newMax);

  return message.reply(
    `✅ Jumlah pengingat susulan diatur ke *${newMax}*.\n\n`
    + `Kamu akan menerima:\n`
    + `  • 1 reminder utama\n`
    + `  • ${newMax} pengingat susulan\n\n`
    + `_Interval: Fibonacci (5, 8, 13, 21, ... menit)_`
  );
}

async function cmdIzin(message, phone, body) {
  // Format:
  //   #izin 2026-02-10 Sakit             → single day
  //   #izin 2026-02-10..15 Cuti tahunan  → date range
  //   #izin 2026-02-10..2026-02-15 Cuti → date range with full dates

  const text = body.slice('#izin'.length).trim();
  if (!text) {
    // Show current leaves
    const leaves = db.getAllLeaves(phone);
    if (leaves.length === 0) {
      return message.reply(
        '📝 *Belum ada izin/cuti tercatat*\n\n'
        + '*Format:*\n'
        + '• *#izin 2026-02-10 Sakit*\n'
        + '  ↳ _Izin 1 hari_\n\n'
        + '• *#izin 2026-02-10..15 Cuti*\n'
        + '  ↳ _Izin rentang tanggal_'
      );
    }

    const lines = ['📝 *Izin/Cuti Tercatat*', ''];
    for (const leave of leaves) {
      const status = leave.status === 'approved' ? '✅' : '❌';
      if (leave.start_date === leave.end_date) {
        lines.push(`${status} ${leave.start_date} — ${leave.reason}`);
      } else {
        lines.push(`${status} ${leave.start_date} s/d ${leave.end_date} — ${leave.reason}`);
      }
    }
    return message.reply(lines.join('\n'));
  }

  // Parse input
  const parts = text.split(/\s+/);
  const dateInput = parts[0];
  const reason = parts.slice(1).join(' ');

  if (!reason) {
    return message.reply('⚠️ Alasan harus diisi.\n\n_Contoh: #izin 2026-02-10 Sakit_');
  }

  // Parse date(s)
  let startDate, endDate;
  
  if (dateInput.includes('..')) {
    // Range: 2026-02-10..15 or 2026-02-10..2026-02-15
    const [start, end] = dateInput.split('..');
    startDate = start;
    
    if (end.includes('-')) {
      endDate = end; // Full date
    } else {
      // Day only, use same year-month as start
      const [year, month] = start.split('-');
      endDate = `${year}-${month}-${end.padStart(2, '0')}`;
    }
  } else {
    // Single date
    startDate = dateInput;
    endDate = dateInput;
  }

  // Validate dates
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return message.reply('⚠️ Format tanggal tidak valid.\n\n_Gunakan: YYYY-MM-DD_\n_Contoh: 2026-02-10_');
  }

  // Add leave request
  db.addLeaveRequest(phone, startDate, endDate, reason);

  if (startDate === endDate) {
    return message.reply(`✅ Izin/cuti tercatat untuk *${startDate}*.\n\nAlasan: ${reason}\n\nReminder otomatis dinonaktifkan.`);
  } else {
    return message.reply(`✅ Izin/cuti tercatat untuk *${startDate}* s/d *${endDate}*.\n\nAlasan: ${reason}\n\nReminder otomatis dinonaktifkan.`);
  }
}

async function cmdPause(message, phone) {
  db.updateUserSetting(phone, 'is_active', 0);

  // Stop any active auto-resend
  scheduler.stopAutoResend(phone, 'pagi');
  scheduler.stopAutoResend(phone, 'sore');

  return message.reply('⏸️ Reminder dinonaktifkan.\n\nKetik *#resume* untuk mengaktifkan kembali.');
}

async function cmdResume(message, phone) {
  db.updateUserSetting(phone, 'is_active', 1);
  return message.reply('▶️ Reminder diaktifkan kembali! 🎉');
}

async function cmdRiwayat(message, phone) {
  const history = db.getAttendanceHistory(phone, 14);
  if (history.length === 0) {
    return message.reply('📭 Belum ada riwayat absen tercatat.');
  }

  const lines = [
    '📜  *RIWAYAT ABSEN*',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ];

  let currentDate = '';
  for (const entry of history) {
    if (entry.date !== currentDate) {
      currentDate = entry.date;
      // Format date nicely
      const dateObj = new Date(entry.date + 'T12:00:00');
      const dayName = defaults.HARI_NAMES_FULL[dateObj.getDay()];
      lines.push(`📅 *${dayName}, ${entry.date}*`);
    }
    const icon = entry.type === 'pagi' ? '☀️' : '🌆';
    lines.push(`  ${icon} ${entry.type}: *${entry.confirmed_at}* _(${entry.method})_`);
  }

  return message.reply(lines.join('\n'));
}

// ─── Admin-only Commands ────────────────────────────────────────────

async function cmdUsers(message) {
  const users = db.getAllUsers();
  if (users.length === 0) {
    return message.reply('📭 Belum ada user terdaftar.');
  }

  const lines = [
    `👥  *DAFTAR USER (${users.length})*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ];

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const status = u.is_active ? '🟢' : '🔴';
    const hari = JSON.parse(u.hari_kerja).map((d) => defaults.HARI_NAMES[d]).join(',');
    const roleLabel = u.role === 'admin' ? ' 👑' : '';
    lines.push(
      `*${i + 1}. ${u.name || '-'}*${roleLabel}`,
      `   📱 ${u.phone}`,
      `   ⏰ Pagi: ${u.reminder_pagi} | Sore: ${u.reminder_sore}`,
      `   📅 ${hari}`,
      `   ${status} ${u.is_active ? 'Aktif' : 'Nonaktif'} | Sejak: ${u.created_at}`,
      '',
    );
  }

  lines.push(
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '_Tambah: *#adduser 628xxx Nama*_',
    '_Hapus: *#removeuser 628xxx*_',
  );

  return message.reply(lines.join('\n'));
}

async function cmdAddUser(message, phone, parts, body) {
  // #adduser 6281234567890 Nama Pegawai
  if (parts.length < 3) {
    return message.reply(
      '📝 *Format:*\n'
      + '*#adduser 628xxxxxxxxxx Nama Pegawai*\n\n'
      + '_Contoh: #adduser 6281234567890 Budi Santoso_'
    );
  }

  let targetPhone = parts[1];
  // Normalize: remove +, leading 0 → 62
  targetPhone = targetPhone.replace(/^\+/, '');
  if (targetPhone.startsWith('0')) {
    targetPhone = '62' + targetPhone.slice(1);
  }

  if (!/^62\d{8,13}$/.test(targetPhone)) {
    return message.reply('⚠️ Nomor tidak valid. Gunakan format *62xxx*.\n\n_Contoh: 6281234567890_');
  }

  // Extract name from original body to preserve casing
  const bodyParts = body.trim().split(/\s+/);
  const name = bodyParts.slice(2).join(' ');

  const existing = db.getUser(targetPhone);
  db.upsertUser(targetPhone, name, 'user');

  if (existing) {
    return message.reply(`✅ User *${name}* (${targetPhone}) diperbarui.`);
  }
  return message.reply(
    `✅ User *${name}* (${targetPhone}) berhasil ditambahkan.\n\n`
    + `⏰ Jadwal default:\n`
    + `  ☀️ Pagi: ${defaults.REMINDER_PAGI}\n`
    + `  🌆 Sore: ${defaults.REMINDER_SORE}\n`
    + `  🌆 Jumat Sore: 16:35\n`
    + `  📅 Sen—Jum`
  );
}

async function cmdRemoveUser(message, phone, parts) {
  // #removeuser 6281234567890
  if (parts.length < 2) {
    return message.reply('📝 *Format:* *#removeuser 628xxxxxxxxxx*');
  }

  let targetPhone = parts[1].replace(/^\+/, '');
  if (targetPhone.startsWith('0')) {
    targetPhone = '62' + targetPhone.slice(1);
  }

  const existing = db.getUser(targetPhone);
  if (!existing) {
    return message.reply(`⚠️ User ${targetPhone} tidak ditemukan.`);
  }

  if (existing.role === 'admin') {
    return message.reply('⛔ Tidak bisa menghapus akun Admin.');
  }

  // Stop auto-resend for removed user
  scheduler.stopAutoResend(targetPhone, 'pagi');
  scheduler.stopAutoResend(targetPhone, 'sore');

  db.removeUser(targetPhone);
  return message.reply(`✅ User *${existing.name || targetPhone}* (${targetPhone}) dihapus beserta semua datanya.`);
}

async function cmdLibur(message, phone, body) {
  // Format: #libur 2026-02-14 Cuti Bersama
  const text = body.slice('#libur'.length).trim();
  
  if (!text) {
    // Show upcoming holidays
    const holidays = db.getUpcomingHolidays(10);
    if (holidays.length === 0) {
      return message.reply(
        '📅 *Belum ada hari libur tercatat*\n\n'
        + '*Format:*\n'
        + '*#libur 2026-02-14 Cuti Bersama*'
      );
    }

    const lines = ['🎉 *Hari Libur Mendatang*', ''];
    for (const h of holidays) {
      const icon = h.is_national ? '🇮🇩' : '🏢';
      lines.push(`${icon} ${h.date} — ${h.name}`);
    }
    return message.reply(lines.join('\n'));
  }

  const parts = text.split(/\s+/);
  const date = parts[0];
  const name = parts.slice(1).join(' ');

  if (!name) {
    return message.reply('⚠️ Keterangan harus diisi.\n\n_Contoh: #libur 2026-02-14 Cuti Bersama_');
  }

  // Validate date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return message.reply('⚠️ Format tanggal tidak valid.\n\n_Gunakan: YYYY-MM-DD_\n_Contoh: 2026-02-14_');
  }

  // Add holiday (non-national)
  db.addHoliday(date, name, false, phone);
  return message.reply(`✅ Hari libur kantor ditambahkan.\n\n📅 *${date}*\n${name}\n\nReminder otomatis dinonaktifkan.`);
}

async function cmdTest(message, phone, parts) {
  // #test pagi  → manually trigger pagi reminder
  // #test sore  → manually trigger sore reminder
  const user = db.getUser(phone);
  const type = parts[1] || (Number(time.getCurrentTime().split(':')[0]) < 12 ? 'pagi' : 'sore');
  if (!['pagi', 'sore'].includes(type)) {
    return message.reply('📝 *Format:* *#test pagi* atau *#test sore*');
  }
  await scheduler.sendReminder(phone, type, user ? user.name : 'kamu');
  scheduler.startAutoResend(phone, type, user ? user.name : 'kamu');
  setPendingReminder(phone, type);
  return null; // reminder message itself is the reply
}

async function cmdWaktu(message) {
  const lines = [
    '🕐  *INFO WAKTU SISTEM*',
    '━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `⏰ Waktu   : *${time.getCurrentTime()}*`,
    `📅 Tanggal : *${time.getCurrentDate()}*`,
    `📆 Hari    : *${time.getDisplayDate()}*`,
    `🔧 Mode    : ${time.isSimulated() ? '🧪 ' : '🟢 '}${time.getStatusLabel()}`,
  ];
  return message.reply(lines.join('\n'));
}

async function cmdBroadcast(message, phone, body) {
  // #broadcast <pesan>
  const text = body.slice('#broadcast'.length).trim();
  if (!text) {
    return message.reply('📝 *Format:* *#broadcast Pesan yang ingin dikirim*\n\n_Pesan akan dikirim ke semua user aktif._');
  }

  const users = db.getAllActiveUsers();
  if (users.length === 0) {
    return message.reply('📭 Tidak ada user aktif untuk menerima broadcast.');
  }

  let sent = 0;
  let failed = 0;

  for (const user of users) {
    // Don't send to the admin who's sending the broadcast or bot phone
    if (user.phone === phone || user.phone === defaults.BOT_PHONE) continue;

    try {
      await wa.sendMessage(user.phone, `📢 *[BROADCAST]*\n\n${text}`);
      sent++;
    } catch (err) {
      console.error(`[Broadcast] Gagal kirim ke ${user.phone}:`, err.message);
      failed++;
    }
  }

  return message.reply(`✅ Broadcast selesai.\n\n📤 Terkirim: ${sent}\n❌ Gagal: ${failed}`);
}

module.exports = {
  handleMessage,
  setPendingReminder,
};
