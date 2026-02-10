// Default configuration for Reminder Presensi BPS

module.exports = {
  // Default reminder times (HH:mm format, WITA)
  REMINDER_PAGI: '07:25',
  REMINDER_SORE: '16:05',

  // Default day-specific schedule overrides (JS day: 0=Min, 1=Sen, ..., 6=Sab)
  // Format: { "dayNumber": { "pagi": "HH:MM", "sore": "HH:MM" } }
  DEFAULT_JADWAL_KHUSUS: JSON.stringify({
    '5': { sore: '16:35' }, // Jumat sore
  }),

  // Default active work days (0=Sunday, 1=Monday, ..., 6=Saturday)
  HARI_KERJA: [1, 2, 3, 4, 5], // Senin - Jumat

  // Auto-resend intervals in minutes (Fibonacci sequence)
  // After initial reminder, follow-ups are sent at these intervals
  FIBONACCI_INTERVALS: [5, 8, 13, 21, 34, 55, 89, 144, 233, 377],

  // Default max follow-ups (user-configurable, min 1)
  DEFAULT_MAX_FOLLOWUPS: 10, // Max 10 follow-ups after initial reminder

  // Admin configuration
  PRIMARY_ADMIN: '6285155228104', // Admin utama (can send & receive)
  BOT_PHONE: '628134247343', // Bot phone (receive only)

  // Rate limiting
  RATE_LIMIT_MAX_MESSAGES: 10, // Max messages per window
  RATE_LIMIT_WINDOW_SECONDS: 60, // Time window in seconds

  // Backup schedule
  BACKUP_HOUR: 2, // Daily backup at 2 AM WITA
  BACKUP_MINUTE: 0,

  // Holiday API sync
  HOLIDAY_SYNC_ENABLED: true,

  // Day name constants
  HARI_NAMES: ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'],
  HARI_NAMES_FULL: ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'],

  // Indonesian day name → JS day number mapping
  HARI_MAP: {
    minggu: 0, min: 0,
    senin: 1, sen: 1,
    selasa: 2, sel: 2,
    rabu: 3, rab: 3,
    kamis: 4, kam: 4,
    jumat: 5, jum: 5,
    sabtu: 6, sab: 6,
  },

  // ─── Message templates ───────────────────────────────────────────
  // {name} placeholder will be replaced with user's registered name
  MESSAGES: {
    // Initial reminders (friendly & informative)
    REMINDER_PAGI: [
      '☀️  *REMINDER ABSEN PAGI*',
      '━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      'Selamat pagi, *{name}*! 👋',
      'Waktunya absen kehadiran.',
      '',
      '📱 Buka *Presensi BPS* dan',
      'lakukan absen sekarang ya.',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━',
      '  ✅ Balas *1* — Sudah Absen',
      '  ⏰ Balas *2* — Ingatkan Nanti',
      '  🏖️ Balas *3* — Cuti',
      '  ✈️ Balas *4* — Perjadin',
      '━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '_⏳ Otomatis diingatkan jika belum konfirmasi_',
    ].join('\n'),

    REMINDER_SORE: [
      '🌆  *REMINDER ABSEN SORE*',
      '━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      'Hai *{name}*! Sudah waktunya pulang 🏠',
      'Jangan lupa absen kepulangan.',
      '',
      '📱 Buka *Presensi BPS* dan',
      'lakukan absen sekarang ya.',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━',
      '  ✅ Balas *1* — Sudah Absen',
      '  ⏰ Balas *2* — Ingatkan Nanti',
      '  🏖️ Balas *3* — Cuti',
      '  ✈️ Balas *4* — Perjadin',
      '━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '_⏳ Otomatis diingatkan jika belum konfirmasi_',
    ].join('\n'),

    // Tiered follow-up messages (progressively more urgent)
    // Tier 1: Follow-up 1-2 (polite reminder)
    FOLLOWUP_TIER1: [
      '🔔 *PENGINGAT #{count} — ABSEN {TYPE}*',
      '',
      'Hai *{name}*, kamu belum konfirmasi',
      'absen {type}. Segera absen ya! 🙏',
      '',
      '📱 Buka *Presensi BPS* sekarang.',
      '',
      '✅ Balas *1* — Sudah Absen',
      '',
      '{footer}',
    ].join('\n'),

    // Tier 2: Follow-up 3-5 (more direct)
    FOLLOWUP_TIER2: [
      '🔔 *PENGINGAT #{count} — ABSEN {TYPE}*',
      '',
      '*{name}*, kamu belum absen {type}.',
      'Mohon segera lakukan absen! ⚠️',
      '',
      '✅ Balas *1* setelah absen',
      '',
      '{footer}',
    ].join('\n'),

    // Tier 3: Follow-up 6+ (urgent & brief)
    FOLLOWUP_TIER3: [
      '⚠️ *URGENT — ABSEN {TYPE}*',
      '',
      '*{name}*, SEGERA ABSEN {type}!',
      'Pengingat ke-{count} dari {max}.',
      '',
      '✅ Balas *1* jika sudah',
      '',
      '{footer}',
    ].join('\n'),

    CONFIRMED: [
      '✅ *Absen {type} dikonfirmasi!*',
      '',
      'Terima kasih, *{name}*! 💪',
      '',
      '⏰ Waktu   : *{time}*',
      '📅 Tanggal : *{date}*',
    ].join('\n'),

    SNOOZED: [
      '⏰ Baik *{name}*, akan diingatkan',
      'kembali otomatis.',
      '',
      '_Balas *1* kapan saja setelah absen._',
    ].join('\n'),

    ALREADY_CONFIRMED: '✅ Absen {type} hari ini sudah dikonfirmasi.\n\n⏰ Waktu: *{time}*',

    // ─── Registration messages ──────────────────────────────────────
    REGISTRATION_WELCOME: [
      '👋  *SELAMAT DATANG!*',
      '━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      'Halo! Terima kasih telah menghubungi',
      '*Reminder Presensi BPS* 🏢',
      '',
      'Untuk memulai, silakan kirimkan',
      '*nama lengkap* kamu.',
      '',
      '_Contoh: Budi Santoso_',
    ].join('\n'),

    REGISTRATION_INVALID: [
      '⚠️ Nama tidak valid.',
      '',
      'Silakan kirimkan *nama lengkap* kamu.',
      '_Minimal 2 karakter dan bukan angka saja._',
      '',
      '_Contoh: Budi Santoso_',
    ].join('\n'),

    // ─── Quick leave/perjadin flow ───────────────────────────────────
    LEAVE_ASK_END_DATE: [
      '🏖️ *{type}*',
      '',
      'Baik, *{name}*.',
      'Sampai tanggal berapa?',
      '',
      '📅 Kirim tanggal akhir:',
      '  • *Hari ini saja* — ketik *0*',
      '  • *Besok* — ketik *1*',
      '  • *Tanggal tertentu* — YYYY-MM-DD',
      '',
      '_Contoh: 2026-02-15 atau ketik 0_',
    ].join('\n'),

    LEAVE_REGISTERED: [
      '✅ *{type} tercatat*',
      '',
      '📅 Periode: *{start}* s/d *{end}*',
      '',
      'Reminder otomatis dinonaktifkan',
      'untuk periode tersebut.',
      '',
      '_Selamat beristirahat! 🌴_',
    ].join('\n'),

    LEAVE_INVALID_DATE: [
      '⚠️ Format tanggal tidak valid.',
      '',
      'Silakan kirim:',
      '  • *0* untuk hari ini saja',
      '  • *1* untuk besok',
      '  • *YYYY-MM-DD* untuk tanggal tertentu',
      '',
      '_Contoh: 2026-02-15_',
    ].join('\n'),

    // ─── Weekly recap ────────────────────────────────────────────────
    WEEKLY_RECAP_HEADER: [
      '📊  *REKAP MINGGUAN*',
      '━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      'Periode: {start} — {end}',
      '',
    ].join('\n'),

    WEEKLY_RECAP_PERSONAL: [
      '👤 *{name}*',
      '',
      '✅ Absen Pagi  : *{pagi}/{expected}* hari',
      '✅ Absen Sore  : *{sore}/{expected}* hari',
      '📈 Kepatuhan   : *{percentage}%*',
      '',
      '{status}',
    ].join('\n'),

    // ─── Rate limit ──────────────────────────────────────────────────
    RATE_LIMIT_EXCEEDED: [
      '⏳ *Terlalu banyak pesan*',
      '',
      'Kamu mengirim terlalu banyak pesan',
      'dalam waktu singkat.',
      '',
      'Silakan tunggu *{seconds} detik* lagi.',
    ].join('\n'),

    // ─── System notifications ─────────────────────────────────────────
    BOT_STARTED: [
      '✅ *Bot Online*',
      '',
      'Reminder Presensi BPS telah aktif.',
      'Waktu: {time}',
      '',
      '_Semua layanan berjalan normal._',
    ].join('\n'),

    BOT_STOPPED: [
      '⚠️ *Bot Offline*',
      '',
      'Reminder Presensi BPS terputus.',
      'Waktu: {time}',
      '',
      '_Sedang mencoba reconnect..._',
    ].join('\n'),

    BOT_RECONNECTED: [
      '✅ *Bot Reconnected*',
      '',
      'Koneksi berhasil dipulihkan.',
      'Waktu: {time}',
      '',
      '_Layanan kembali normal._',
    ].join('\n'),
  },

  // Help message is now built dynamically in handler.js
};
