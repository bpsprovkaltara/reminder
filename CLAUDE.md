# Reminder Presensi BPS Kalimantan Utara - WhatsApp Bot

## Overview
Bot WhatsApp untuk mengirim reminder presensi (absen pagi & sore) kepada pegawai BPS Provinsi Kalimantan Utara. Dibangun menggunakan whatsapp-web.js dengan database PostgreSQL dan fitur-fitur enterprise-ready.

## Tech Stack
- **Runtime**: Node.js v20
- **WhatsApp**: whatsapp-web.js v1.34.6 (Puppeteer-based)
- **Database**: PostgreSQL 16 via pg (node-postgres)
- **Scheduler**: node-cron v4
- **Auth**: LocalAuth (session tersimpan di `.wwebjs_auth/`)
- **Deployment**: Docker + Docker Compose
- **Health Check**: HTTP server on port 3000

## Project Structure
```
src/
├── index.js # Entry point, health check server, boot sequence
├── config/
│ ├── defaults.js # Config, message templates, admin numbers
│ └── time.js # Time utility (real & simulated mode)
├── db/
│ └── database.js # PostgreSQL (users, attendance, leave, holidays, rate limit)
└── modules/
 ├── whatsapp.js # WhatsApp client, auto-reconnect, notifications
 ├── scheduler.js # Reminder scheduling, auto-resend, weekly recap, backup
 ├── handler.js # Command handler, registration flow, rate limiting
 └── holiday.js # Holiday API client (libur.deno.dev)
scripts/
├── import-users.js # Bulk import users from CSV/TXT
└── migrate-sqlite-to-pg.js # One-time migration from SQLite to PostgreSQL
data/
└── backups/ # Daily pg_dump backups
```

## Architecture Flow
1. **Boot**: Parse CLI → configure time → start health server → connect PostgreSQL → create WhatsApp client
2. **Auth**: QR code ditampilkan di terminal, scan dengan WhatsApp
3. **Registration**: User baru diminta kirim nama lengkap (pesan personal)
4. **Scheduler**: Saat client `ready`, aktifkan scheduler, backup, holiday sync
5. **Handler**: Route pesan masuk dengan rate limiting → command/registration/quick reply
6. **Auto-resend**: Fibonacci intervals dengan tiered messages (polite → direct → urgent)
7. **Auto-reconnect**: Deteksi disconnect → auto-reconnect dengan backoff
8. **Health Check**: HTTP `/health` endpoint untuk monitoring eksternal

## Database Schema
- **users**: phone (PK), name, role, reminder_pagi/sore, jadwal_khusus, hari_kerja, is_active, max_followups
- **attendance_log**: phone, date, type (pagi/sore), confirmed_at, method
- **leave_requests**: phone, start_date, end_date, reason, status (approved/cancelled)
- **holidays**: date (PK), name, is_national, created_by
- **snooze_state**: phone, date, type, count
- **rate_limit**: phone, last_message_at, message_count
- **settings**: key (PK), value, updated_at — Menyimpan konfigurasi dinamis (default_reminder_pagi, default_reminder_sore)

## Key Features

### 1. Personalized Registration Flow
- User baru diminta kirim nama lengkap sebelum terdaftar
- Semua pesan reminder menggunakan nama personal
- User bisa ubah nama dengan `#nama Nama Baru`
- Admin-added users skip registration flow

### 1b. User-configurable Follow-ups
- User bisa atur jumlah pengingat susulan (min: 1, max: 10)
- Command: `#maxpengingat <jumlah>` (contoh: `#maxpengingat 5`)
- Default: 10 pengingat susulan
- Disimpan di kolom `max_followups` per-user

### 2. Auto-resend (Fibonacci + Tiered Messages)
- **Intervals**: 5, 8, 13, 21, 34, 55, 89, 144, 233, 377 menit (10 follow-ups)
- **Tier 1** (1-2): Polite reminder
- **Tier 2** (3-5): Direct reminder
- **Tier 3** (6+): Urgent reminder (brief & bold)
- Stop otomatis saat user konfirmasi atau batas tercapai

### 3. Day-specific Schedules
- Default: Pagi 07:25, Sore 16:05, Jumat Sore 16:35
- Command: `#setwaktu sore 16:35 jumat` untuk set jadwal khusus
- Jadwal disimpan per-user di kolom `jadwal_khusus` (JSON)

### 4. Leave Management
- **Command-based**: `#izin 2026-02-10 Sakit` — Lapor cuti/izin/sakit
- **Quick action**: Balas `3` (Cuti) atau `4` (Perjadin) di pesan reminder
- **Interactive flow**: Bot minta tanggal akhir setelah quick action
  - Ketik `0` untuk hari ini saja
  - Ketik `1` untuk besok
  - Ketik `YYYY-MM-DD` untuk tanggal tertentu
- `#izin 2026-02-10..15 Cuti` — Rentang tanggal
- Reminder otomatis pause di tanggal izin
- View dengan `#izin` (tanpa parameter)
- Auto-stop reminder susulan saat cuti/perjadin terdaftar

### 5. Holiday Management
- **National holidays**: Auto-sync dari https://libur.deno.dev/ API (daily at 3 AM)
- **Office holidays**: Admin bisa tambah dengan `#libur 2026-02-14 Cuti Bersama`
- Reminder otomatis skip pada hari libur
- Tampil di `#jadwal` dan `#status`

### 6. Weekly Recap (Friday Sore)
- Otomatis kirim rekap mingguan setelah user konfirmasi absen sore Jumat
- Menampilkan:
  - Jumlah absen pagi & sore (Sen-Jum)
  - Persentase kepatuhan
  - Status (Luar biasa / Bagus / Semangat)

### 7. Auto-reconnect WhatsApp
- Deteksi disconnect otomatis
- Retry up to 5 attempts with 30s delay
- Notify primary admin saat disconnect & reconnect
- Logs state changes untuk debugging

### 8. Health Check Monitoring
- HTTP server on port 3000 (customizable via `--port`)
- Endpoint: `GET /health`
- Response: `{ status, whatsapp, time, date, uptime, version }`
- Status codes: 200 (healthy) / 503 (unhealthy)
- Untuk uptime monitoring (UptimeRobot, Pingdom, etc)

### 9. Admin Notifications
- Primary admin dapat notifikasi otomatis:
  - Bot started (saat ready)
  - Bot stopped (disconnect)
  - Bot reconnected (setelah recovery)

### 10. Daily Database Backup
- Otomatis backup via `pg_dump` setiap hari jam 2 AM WITA
- Simpan ke `data/backups/` sebagai `.sql` dengan timestamp
- Auto-cleanup: hapus backup > 7 hari

### 11. Rate Limiting
- Max 10 messages per 60 seconds per user
- Cegah spam dan abuse
- Auto-reset setelah window expired

### 12. WhatsApp Status (Story)
- Otomatis posting WhatsApp Status 2x sehari pada jam default reminder
- **Pagi**: Saat jam `default_reminder_pagi` (default 07:25)
- **Sore**: Saat jam `default_reminder_sore` (default 16:05)
- Skip otomatis pada hari libur dan weekend
- Status di-post hanya 1x per type per hari (dedup)
- Menggunakan `status@broadcast` via whatsapp-web.js

## Admin Configuration
- **Primary Admin**: `6285155228104` (can send & receive, full permissions)
- **Bot Phone**: `628134247343` (receive-only, no reminders)
- WhatsApp authenticated phone juga otomatis jadi admin

## Default Schedule (WITA Timezone)
- **Pagi**: 07:25 (Senin-Jumat)
- **Sore**: 16:05 (Senin-Kamis)
- **Jumat Sore**: 16:35
- Timezone: Asia/Makassar (WITA/UTC+8)

## Commands

### All Users
- `#help` — Panduan (menampilkan nama & role)
- `#status` — Status absen hari ini (deteksi libur/izin)
- `#jadwal` — Jadwal reminder + hari libur mendatang
- `#setwaktu pagi/sore HH:MM [hari]` — Atur jadwal
- `#hari [1,2,3,4,5]` — Lihat/atur hari kerja
- `#nama [Nama Baru]` — Lihat/ubah nama
- `#izin [tanggal alasan]` — Lapor cuti/izin/sakit
- `#maxpengingat [jumlah]` — Atur jumlah pengingat susulan (min: 1, max: 10)
- `#pause` / `#resume` — Kontrol reminder
- `#riwayat` — Riwayat absen 7 hari
- Quick reply: `1` (konfirmasi), `2` (snooze), `3` (cuti), `4` (perjadin)

### Admin Only
- `#users` — Daftar semua user
- `#adduser 628xxx Nama` — Tambah user
- `#removeuser 628xxx` — Hapus user
- `#setdefault pagi/sore HH:MM` — Ubah jam default reminder (berlaku untuk semua user yang pakai waktu default)
- `#libur [tanggal keterangan]` — Tambah/lihat libur kantor
- `#broadcast pesan` — Broadcast ke semua
- `#test pagi/sore` — Trigger manual
- `#waktu` — Info sistem

## Development

```bash
# Local development
npm start # Production mode
npm run dev # Watch mode
npm run test:pagi # Simulasi reminder pagi
npm run test:sore # Simulasi reminder sore
npm run test:sore:jumat # Simulasi Jumat sore
npm run test:fast # Fast-forward 60x

# Docker deployment
docker compose up -d --build # Build & start
docker compose logs -f # View logs & QR code
docker compose ps # Status
docker compose down # Stop
docker compose restart # Restart

# Custom simulation
node src/index.js --time 07:24 --speed 60
node src/index.js --time 16:34 --day 5 --port 3001
```

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string (default: `postgresql://reminder:reminder_secret@localhost:5432/reminder`)
- `PUPPETEER_EXECUTABLE_PATH` — Path to Chromium (auto-set in Docker)
- `TZ` — Timezone (set to Asia/Makassar)
- `PORT` — Health check port (default: 3000)

## Persistent Data (Docker Volumes)
- `pgdata` — PostgreSQL data (named Docker volume)
- `.wwebjs_auth/` — WhatsApp session (persist login)
- `.wwebjs_cache/` — WhatsApp cache (faster reconnect)
- `data/` — pg_dump backups

## Cron Jobs (Automated Tasks)
- **Every minute**: Check reminders (skip if holiday/leave/weekend)
- **Daily 00:00**: Cleanup snooze state & auto-resend timers
- **Daily 02:00**: Database backup
- **Daily 03:00**: Sync national holidays from API

## Important Notes
- Jangan commit `.wwebjs_auth/`, `.wwebjs_cache/`, `data/` (berisi sensitive data)
- `getCurrentDate()` menggunakan waktu lokal (WITA), bukan UTC
- Semua database functions bersifat `async` — selalu gunakan `await`
- Auto-resend timers di memory (hilang saat restart) tapi scheduler re-trigger otomatis
- `pendingRegistrations` Map hilang saat restart; user kirim ulang untuk registrasi
- Primary admin & bot phone di-hardcode di `defaults.js`
- WhatsApp authenticated phone otomatis jadi admin
- Health check berguna untuk uptime monitoring dan container orchestration
- PostgreSQL harus running sebelum bot start (diatur via `depends_on` + healthcheck di docker-compose)

## Troubleshooting

### Bot tidak kirim pesan
- Cek `docker compose logs` untuk error
- Pastikan WhatsApp session masih valid (scan QR jika perlu)
- Cek health endpoint: `curl http://localhost:3000/health`

### Reminder tidak trigger
- Cek timezone container: `docker exec bpsprovkaltara-reminder-presensi-bps date`
- Cek apakah hari ini libur: perintah `#status` akan show "HARI LIBUR"
- Cek jadwal user: `#jadwal`

### WhatsApp disconnect terus-menerus
- Cek `shm_size` di docker-compose (minimal 512MB)
- Cek logs Chromium/Puppeteer
- Pastikan tidak ada session ganda (logout di device lain)

### Database corrupt
- Restore dari backup: `psql "$DATABASE_URL" < data/backups/reminder-YYYY-MM-DDTHH-MM-SS.sql`
- Restart: `docker compose restart`

## API Integration

### Holiday API (libur.deno.dev)
- Auto-sync national holidays daily
- Check endpoint: `GET https://libur.deno.dev/api/today`
- Fallback: manual `#libur` command jika API down

### Health Check
- `GET http://localhost:3000/health`
- Response 200 = healthy, 503 = unhealthy
- Monitor dengan UptimeRobot, Pingdom, etc

## Security
- Rate limiting: max 10 msg/60s per user
- Admin-only commands protected by role check
- No API keys exposed (holiday API is public)
- PostgreSQL database di named volume terpisah

## Performance
- Fibonacci intervals mencegah spam (escalating delays)
- Rate limiting pada handler level
- Connection pooling via pg Pool
- Auto-cleanup old data (snooze, backups)

## Version History
- **v1.0.0**: Initial release (basic reminders)
- **v2.0.0**: Enterprise features (leave, holidays, auto-reconnect, health check, backup, weekly recap, rate limiting, tiered messages)
- **v3.0.0**: Database migration from SQLite to PostgreSQL (async, connection pooling, pg_dump backups)
