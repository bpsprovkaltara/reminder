# Fitur Baru - Reminder Presensi BPS

## 1. User-Configurable Max Follow-ups

### Deskripsi
Pengguna dapat mengatur berapa banyak pengingat susulan yang ingin diterima setelah reminder utama.

### Spesifikasi
- **Minimal**: 1 pengingat (reminder utama + 1 susulan)
- **Maksimal**: 10 pengingat
- **Default**: 10 pengingat susulan
- **Penyimpanan**: Kolom `max_followups` di tabel `users`

### Command
```
#maxpengingat              → Lihat setting saat ini
#maxpengingat 5            → Set max 5 pengingat susulan
```

### Contoh Output
```
🔔 Jumlah Pengingat Susulan

Saat ini: 10 pengingat
(1 reminder utama + 10 pengingat susulan)

Untuk mengubah:
#maxpengingat <jumlah>

Minimal: 1 (reminder utama + 1 susulan)
Maksimal: 10

Contoh: #maxpengingat 5
```

Setelah diubah:
```
✅ Jumlah pengingat susulan diatur ke 5.

Kamu akan menerima:
  • 1 reminder utama
  • 5 pengingat susulan

Interval: Fibonacci (5, 8, 13, 21, ... menit)
```

### Cara Kerja
1. User set `#maxpengingat 3`
2. Database update kolom `max_followups = 3`
3. Scheduler membaca setting user saat start auto-resend
4. Auto-resend berhenti setelah 3 pengingat (atau Fibonacci intervals habis, mana yang lebih dulu)
5. Footer pesan disesuaikan: "Pengingat ke-2/3" bukan "ke-2/10"

---

## 2. Quick Leave/Perjadin Action

### Deskripsi
Pengguna dapat langsung melaporkan cuti atau perjalanan dinas dari pesan reminder tanpa perlu ketik command manual.

### Quick Reply Baru
Di setiap pesan reminder (pagi & sore), ada 4 opsi quick reply:
```
━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Balas 1 — Sudah Absen
  ⏰ Balas 2 — Ingatkan Nanti
  🏖️ Balas 3 — Cuti
  ✈️ Balas 4 — Perjadin
━━━━━━━━━━━━━━━━━━━━━━━
```

### Interactive Flow

#### Step 1: User balas `3` (Cuti) atau `4` (Perjadin)
Bot kirim:
```
🏖️ Cuti

Baik, Budi.
Sampai tanggal berapa?

📅 Kirim tanggal akhir:
  • Hari ini saja — ketik 0
  • Besok — ketik 1
  • Tanggal tertentu — YYYY-MM-DD

Contoh: 2026-02-15 atau ketik 0
```

#### Step 2: User kirim tanggal akhir
User bisa kirim:
- `0` → Cuti hari ini saja
- `1` → Cuti sampai besok
- `2026-02-15` → Cuti sampai tanggal tertentu

#### Step 3: Bot konfirmasi & register leave
```
✅ Cuti tercatat

📅 Periode: 2026-02-07 s/d 2026-02-15

Reminder otomatis dinonaktifkan
untuk periode tersebut.

Selamat beristirahat! 🌴
```

### Validasi
- Tanggal akhir tidak boleh sebelum tanggal mulai
- Format tanggal harus `YYYY-MM-DD` atau `0`/`1`
- Jika invalid, bot minta ulang dengan pesan error

### Error Handling
Jika format salah:
```
⚠️ Format tanggal tidak valid.

Silakan kirim:
  • 0 untuk hari ini saja
  • 1 untuk besok
  • YYYY-MM-DD untuk tanggal tertentu

Contoh: 2026-02-15
```

### Dampak ke Sistem
1. **Auto-stop reminder susulan**: Saat cuti/perjadin terdaftar, auto-resend langsung stop
2. **Reminder skip**: Scheduler tidak kirim reminder di tanggal cuti
3. **Status detection**: `#status` menampilkan "IZIN/CUTI" jika hari ini cuti
4. **Leave database**: Tersimpan di tabel `leave_requests` dengan `status='approved'`

---

## Database Changes

### Migration: Add max_followups Column
```sql
ALTER TABLE users ADD COLUMN max_followups INTEGER DEFAULT 10;
```

Migrasi otomatis dijalankan saat boot aplikasi jika kolom belum ada.

### Updated users Table Schema
```sql
CREATE TABLE users (
  phone TEXT PRIMARY KEY,
  name TEXT,
  role TEXT DEFAULT 'user',
  reminder_pagi TEXT DEFAULT '07:25',
  reminder_sore TEXT DEFAULT '16:05',
  jadwal_khusus TEXT DEFAULT '{"5":{"sore":"16:35"}}',
  hari_kerja TEXT DEFAULT '[1,2,3,4,5]',
  is_active INTEGER DEFAULT 1,
  max_followups INTEGER DEFAULT 10,  -- NEW
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);
```

---

## Technical Implementation

### 1. Scheduler Updates
- `startAutoResend()`: Membaca `user.max_followups` dari database
- `scheduleNextResend()`: Cek `state.index >= maxFollowups` sebelum schedule next
- Footer message: Gunakan `Math.min(maxFollowups, intervals.length)` sebagai total
- Stop condition: `state.index < maxFollowups && state.index < intervals.length`

### 2. Handler Updates
- **New Map**: `pendingLeaveFlow` untuk track user yang sedang dalam flow cuti/perjadin
- **New handlers**:
  - `handleQuickLeave(message, phone, leaveType)` - Handle quick reply 3/4
  - `handleLeaveFlow(message, phone, body)` - Handle input tanggal akhir
- **Updated quick replies**: Tambah handling untuk `body === '3'` dan `body === '4'`
- **New command**: `cmdMaxPengingat(message, phone, parts)` - Handle `#maxpengingat`

### 3. Message Templates
**New messages in `defaults.js`:**
- `LEAVE_ASK_END_DATE` - Minta tanggal akhir
- `LEAVE_REGISTERED` - Konfirmasi cuti terdaftar
- `LEAVE_INVALID_DATE` - Error format tanggal
- **Updated**: `REMINDER_PAGI` dan `REMINDER_SORE` dengan opsi 3 & 4

---

## User Experience Flow

### Scenario 1: User set max 3 pengingat
```
User: #maxpengingat 3
Bot: ✅ Jumlah pengingat susulan diatur ke 3.
     Kamu akan menerima:
       • 1 reminder utama
       • 3 pengingat susulan
     Interval: Fibonacci (5, 8, 13, 21, ... menit)

[Reminder pagi tidak dikonfirmasi]

Menit 0:  🔔 REMINDER ABSEN PAGI (reminder utama)
Menit 5:  🔔 PENGINGAT #1 — ABSEN PAGI
Menit 13: 🔔 PENGINGAT #2 — ABSEN PAGI
Menit 26: 🔔 PENGINGAT #3 — ABSEN PAGI (TERAKHIR)
[Stop - tidak ada pengingat ke-4]
```

### Scenario 2: User balas "3" untuk cuti
```
Bot: ☀️ REMINDER ABSEN PAGI
     ...
     ✅ Balas 1 — Sudah Absen
     ⏰ Balas 2 — Ingatkan Nanti
     🏖️ Balas 3 — Cuti
     ✈️ Balas 4 — Perjadin

User: 3

Bot: 🏖️ Cuti

     Baik, Budi.
     Sampai tanggal berapa?

     📅 Kirim tanggal akhir:
       • Hari ini saja — ketik 0
       • Besok — ketik 1
       • Tanggal tertentu — YYYY-MM-DD

     Contoh: 2026-02-15 atau ketik 0

User: 2026-02-10

Bot: ✅ Cuti tercatat

     📅 Periode: 2026-02-07 s/d 2026-02-10

     Reminder otomatis dinonaktifkan
     untuk periode tersebut.

     Selamat beristirahat! 🌴
```

---

## Testing

### Test Case 1: Max Follow-ups Setting
1. User kirim `#maxpengingat`
2. Verify: Tampil current setting (default: 10)
3. User kirim `#maxpengingat 5`
4. Verify: Setting berubah ke 5
5. User kirim `#maxpengingat 0` (invalid)
6. Verify: Error "Minimal: 1"
7. User kirim `#maxpengingat 15` (invalid)
8. Verify: Error "Maksimal: 10"

### Test Case 2: Auto-resend Respects Max Follow-ups
1. Set user `max_followups = 2`
2. Trigger reminder (don't confirm)
3. Wait for follow-ups
4. Verify: Only 2 follow-ups sent, then stop
5. Verify: Footer shows "Pengingat ke-X/2" not "ke-X/10"

### Test Case 3: Quick Leave Flow (Happy Path)
1. User receive reminder
2. User balas `3` (Cuti)
3. Verify: Bot ask for end date
4. User kirim `0` (today only)
5. Verify: Leave registered, auto-resend stopped
6. Check next day: No reminder sent

### Test Case 4: Quick Leave Flow (Date Range)
1. User balas `3`
2. User kirim `2026-02-15`
3. Verify: Leave registered with correct date range
4. Check DB: `start_date = today, end_date = 2026-02-15`

### Test Case 5: Quick Leave Flow (Invalid Input)
1. User balas `3`
2. User kirim `invalid` (not a date)
3. Verify: Error message shown
4. User still in flow (can retry)
5. User kirim `1` (tomorrow)
6. Verify: Leave registered successfully

### Test Case 6: Perjadin Flow
1. User balas `4` (Perjadin)
2. Verify: Same flow as Cuti but with "Perjadin" label
3. Verify: Reason saved as "Perjadin" in DB

---

## Backward Compatibility

✅ **Existing users**: Auto-migration menambahkan `max_followups = 10` (default)
✅ **Existing commands**: Semua command lama tetap berfungsi
✅ **Quick replies 1 & 2**: Tetap berfungsi seperti sebelumnya
✅ **Auto-resend**: Jika `max_followups` NULL, fallback ke `DEFAULT_MAX_FOLLOWUPS`

---

## Known Limitations

1. **Pending flow state hilang saat restart**: Jika bot restart saat user di tengah leave flow, user harus ulang balas 3/4
2. **No edit leave**: Setelah cuti terdaftar, tidak bisa edit tanggal (harus hapus via `#izin` command)
3. **No cancel quick leave**: Jika user salah balas 3/4, harus selesaikan flow atau tunggu timeout

---

## Future Enhancements

1. **Cancel flow**: Tambah opsi "Batal" di leave flow
2. **Edit leave**: Command untuk edit tanggal cuti yang sudah terdaftar
3. **Custom max per type**: Beda max follow-ups untuk pagi vs sore
4. **Progressive intervals**: User bisa pilih interval pattern (Fibonacci, Linear, Custom)
5. **Leave approval**: Admin approve/reject leave request before auto-disable

---

## Version
- **Added**: v2.1.0 (2026-02-07)
- **By**: Fachri
- **Status**: ✅ Implemented & Ready for Testing
