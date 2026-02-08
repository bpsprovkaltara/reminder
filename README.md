# Reminder Presensi BPS Kalimantan Utara

Bot WhatsApp otomatis untuk mengingatkan pegawai BPS Provinsi Kalimantan Utara melakukan presensi pagi dan sore.

## Fitur Utama

✅ **Reminder Otomatis** — Kirim pengingat absen pagi & sore sesuai jadwal  
🔄 **Auto-resend Fibonacci** — Follow-up bertingkat (polite → urgent) setiap 5-377 menit  
📅 **Jadwal Per-Hari** — Atur waktu khusus per hari (misal Jumat sore jam 16:35)  
📝 **Manajemen Izin** — User lapor cuti/izin/sakit, reminder auto-pause  
🎉 **Hari Libur Nasional** — Auto-sync dari API, skip reminder pada tanggal merah  
📊 **Rekap Mingguan** — Otomatis kirim rekap setiap Jumat sore  
🔌 **Auto-reconnect** — Otomatis reconnect WhatsApp jika disconnect  
💚 **Health Check** — HTTP endpoint untuk monitoring uptime  
💾 **Auto Backup** — Backup database otomatis setiap hari  
🛡️ **Rate Limiting** — Cegah spam (max 10 msg/menit)  

## Quick Start

### Deployment dengan Docker (Recommended)

```bash
# 1. Clone/download project
cd reminder

# 2. Build dan jalankan
docker compose up -d --build

# 3. Lihat logs dan scan QR code WhatsApp
docker compose logs -f

# 4. Scan QR code dengan WhatsApp (nomor 628134247343)

# 5. Bot siap! Admin utama (6285155228104) akan dapat notifikasi
```

### Local Development

```bash
# 1. Install dependencies
npm install

# 2. Jalankan
npm start

# 3. Scan QR code

# 4. Test commands
npm run test:pagi  # Simulasi reminder pagi
npm run test:sore  # Simulasi reminder sore
```

## Configuration

### Admin & Bot Phone
Di `src/config/defaults.js`:
- **PRIMARY_ADMIN**: `6285155228104` — Admin utama (full access)
- **BOT_PHONE**: `628134247343` — Nomor bot (receive-only)

### Timezone
Di `docker-compose.yml`:
- **TZ**: `Asia/Makassar` (WITA/UTC+8)

### Health Check Port
Default: 3000, custom via `--port`:
```bash
node src/index.js --port 8080
```

## Usage

### User Commands
```
#help          — Panduan lengkap
#status        — Status absen hari ini
#jadwal        — Lihat jadwal reminder + libur
#setwaktu pagi 07:25 — Atur waktu
#setwaktu sore 16:35 jumat — Atur khusus Jumat
#hari 1,2,3,4,5 — Set hari kerja
#nama Nama Baru — Ubah nama
#izin 2026-02-10 Sakit — Lapor izin 1 hari
#izin 2026-02-10..15 Cuti — Lapor izin rentang
#pause / #resume — Kontrol reminder
#riwayat       — Riwayat absen
```

### Admin Commands
```
#users         — Daftar semua user
#adduser 628xxx Nama — Tambah user
#removeuser 628xxx — Hapus user
#libur 2026-02-14 Cuti Bersama — Tambah libur kantor
#broadcast pesan — Broadcast ke semua
#test pagi/sore — Trigger manual
#waktu         — Info waktu sistem
```

### Quick Replies
Saat terima reminder, balas:
- **1** — Sudah absen
- **2** — Ingatkan nanti

## Monitoring

### Health Check Endpoint
```bash
# Check status
curl http://localhost:3000/health

# Response (healthy):
{
  "status": "healthy",
  "whatsapp": "connected",
  "time": "07:30",
  "date": "2026-02-08",
  "uptime": 3600,
  "version": "2.0.0"
}
```

### Logs
```bash
# Real-time logs
docker compose logs -f

# Last 100 lines
docker compose logs --tail=100
```

### Database Backup
- Auto backup setiap hari jam 2 AM WITA
- Lokasi: `data/backups/reminder-YYYY-MM-DDTHH-MM-SS.db`
- Auto-cleanup: hapus backup > 7 hari

## Troubleshooting

### Bot tidak kirim reminder
1. Cek logs: `docker compose logs -f`
2. Cek health: `curl http://localhost:3000/health`
3. Cek timezone container: `docker exec bpsprovkaltara-reminder-presensi-bps date`
4. Cek apakah hari libur: kirim `#status` akan tampilkan info libur

### WhatsApp disconnect
1. Bot akan auto-reconnect (max 5 attempts)
2. Admin akan dapat notifikasi disconnect/reconnect
3. Jika tetap gagal, scan QR ulang: `docker compose restart`

### Database recovery
```bash
# Restore dari backup
cp data/backups/reminder-2026-02-07T02-00-00.db data/reminder.db
docker compose restart
```

## File Structure

```
.
├── Dockerfile              # Multi-stage Docker build
├── docker-compose.yml      # Deployment config
├── .dockerignore          # Exclude files from build
├── .gitignore             # Git ignore rules
├── package.json           # Dependencies
├── CLAUDE.md              # Technical documentation
├── README.md              # User guide (this file)
├── src/
│   ├── index.js           # Entry point
│   ├── config/            # Configuration
│   ├── db/                # Database layer
│   └── modules/           # Core modules
├── data/
│   ├── reminder.db        # SQLite database
│   └── backups/           # Daily backups
├── .wwebjs_auth/          # WhatsApp session (gitignored)
└── .wwebjs_cache/         # WhatsApp cache (gitignored)
```

## Tech Details

See [CLAUDE.md](./CLAUDE.md) for:
- Architecture deep-dive
- Database schema
- API integration details
- Development guide
- Testing & simulation

## License

ISC

---

**BPS Provinsi Kalimantan Utara**  
Reminder Presensi v2.0.0
