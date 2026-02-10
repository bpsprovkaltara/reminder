# Test Plan - Fitur Baru

## Preparation
```bash
# Backup database
cp data/reminder.db data/reminder.db.backup

# Start bot
npm start
```

## Test 1: Max Follow-ups Command

### 1.1 View Current Setting
```
User → #maxpengingat
Expected:
  🔔 Jumlah Pengingat Susulan
  Saat ini: 10 pengingat
  ...
```

### 1.2 Set Valid Value
```
User → #maxpengingat 5
Expected:
  ✅ Jumlah pengingat susulan diatur ke 5.
  Kamu akan menerima:
    • 1 reminder utama
    • 5 pengingat susulan
```

### 1.3 Invalid Values
```
User → #maxpengingat 0
Expected: ⚠️ error (Minimal: 1)

User → #maxpengingat 15
Expected: ⚠️ error (Maksimal: 10)

User → #maxpengingat abc
Expected: ⚠️ error (format tidak valid)
```

### 1.4 Verify Database
```bash
sqlite3 data/reminder.db "SELECT phone, max_followups FROM users WHERE phone='6285155228104';"
Expected: 6285155228104|5
```

---

## Test 2: Auto-resend Respects Max Follow-ups

### 2.1 Setup
```
User → #maxpengingat 2
User → #setwaktu pagi 13:30
# Wait until 13:30 without confirming
```

### 2.2 Expected Timeline (Real Time)
```
13:30 - REMINDER ABSEN PAGI (reminder utama)
13:35 - PENGINGAT #1 (interval: 5 mnt)
13:43 - PENGINGAT #2 (interval: 8 mnt) - TERAKHIR
[No more reminders after this]
```

### 2.3 Verify
- Check footer: "Pengingat ke-1/2" bukan "ke-1/10"
- Last message footer: "⚠️ Ini adalah pengingat terakhir (2/2)"
- No 3rd reminder sent

---

## Test 3: Quick Leave - Cuti (Today Only)

### 3.1 Trigger
```
# Wait for reminder or use #test pagi
User → 3
```

### 3.2 Expected Response
```
🏖️ Cuti

Baik, [Your Name].
Sampai tanggal berapa?

📅 Kirim tanggal akhir:
  • Hari ini saja — ketik 0
  • Besok — ketik 1
  • Tanggal tertentu — YYYY-MM-DD
```

### 3.3 Complete Flow
```
User → 0
Expected:
  ✅ Cuti tercatat
  📅 Periode: 2026-02-07 s/d 2026-02-07
  Reminder otomatis dinonaktifkan...
```

### 3.4 Verify
```bash
sqlite3 data/reminder.db "SELECT * FROM leave_requests WHERE phone='6285155228104' ORDER BY id DESC LIMIT 1;"
# Check: start_date = end_date = today
# Check: reason = 'Cuti'
# Check: status = 'approved'
```

### 3.5 Verify Auto-resend Stopped
```
# If auto-resend was active, check logs
Expected: [AutoResend] Dihentikan untuk [phone] pagi.
```

---

## Test 4: Quick Leave - Date Range

### 4.1 Trigger
```
User → #test sore
User → 3
```

### 4.2 Input Tomorrow
```
User → 1
Expected:
  ✅ Cuti tercatat
  📅 Periode: 2026-02-07 s/d 2026-02-08
```

### 4.3 Input Specific Date
```
User → #test pagi
User → 3
User → 2026-02-15
Expected:
  📅 Periode: 2026-02-07 s/d 2026-02-15
```

---

## Test 5: Quick Leave - Perjadin

### 5.1 Trigger
```
User → #test pagi
User → 4
```

### 5.2 Expected
```
✈️ Perjadin

Baik, [Name].
Sampai tanggal berapa?
...
```

### 5.3 Complete
```
User → 2026-02-10
Expected:
  ✅ Perjadin tercatat
  📅 Periode: 2026-02-07 s/d 2026-02-10
```

### 5.4 Verify DB
```bash
sqlite3 data/reminder.db "SELECT reason FROM leave_requests WHERE phone='6285155228104' ORDER BY id DESC LIMIT 1;"
Expected: Perjadin
```

---

## Test 6: Invalid Date Input

### 6.1 Invalid Format
```
User → #test pagi
User → 3
User → invalid_text
Expected:
  ⚠️ Format tanggal tidak valid.
  Silakan kirim:
    • 0 untuk hari ini saja
    • 1 untuk besok
    • YYYY-MM-DD untuk tanggal tertentu
```

### 6.2 User Still in Flow
```
User → 1
Expected: ✅ Cuti tercatat (flow completed successfully)
```

---

## Test 7: Date Validation

### 7.1 End Date Before Start Date
```
User → #test pagi
User → 3
User → 2026-02-01 (past date)
Expected:
  ⚠️ Tanggal akhir tidak boleh sebelum tanggal mulai.
  Silakan kirim tanggal yang valid.
```

---

## Test 8: Help Command Update

### 8.1 Check Help
```
User → #help
Expected: Should include:
  - Section "🔔 Pengaturan Reminder"
  - Line "• #maxpengingat — Lihat/atur"
  - Quick Reply section shows:
    _• Balas 1 = Sudah Absen_
    _• Balas 2 = Ingatkan Nanti_
    _• Balas 3 = Cuti_
    _• Balas 4 = Perjadin_
```

---

## Test 9: Reminder Message Update

### 9.1 Check Reminder Contains New Options
```
User → #test pagi
Expected message contains:
  ━━━━━━━━━━━━━━━━━━━━━━━
    ✅ Balas 1 — Sudah Absen
    ⏰ Balas 2 — Ingatkan Nanti
    🏖️ Balas 3 — Cuti
    ✈️ Balas 4 — Perjadin
  ━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Test 10: Integration - Full Flow

### 10.1 Scenario
1. User belum set max follow-ups (default: 10)
2. Set to 3: `#maxpengingat 3`
3. Trigger reminder: `#test pagi`
4. Don't confirm
5. Receive 3 follow-ups
6. On 2nd follow-up, balas `3` (Cuti)
7. Input `1` (tomorrow)
8. Verify auto-resend stops
9. Next day: No reminder sent (on leave)

---

## Regression Tests

### R1. Existing Quick Replies Still Work
```
User → #test pagi
User → 1 (Sudah Absen)
Expected: ✅ Absen pagi dikonfirmasi!

User → #test sore
User → 2 (Ingatkan Nanti)
Expected: ⏰ Baik [Name], akan diingatkan kembali otomatis.
```

### R2. Existing Commands Work
```
User → #jadwal
User → #status
User → #hari
User → #izin 2026-02-20 Sakit
All should work as before
```

### R3. Auto-resend Without Max Setting
```
# Create new user (won't have max_followups set initially)
# Trigger reminder
# Verify: Falls back to DEFAULT_MAX_FOLLOWUPS (10)
```

---

## Performance Tests

### P1. Database Migration
```bash
# Check migration runs only once
npm start
# Check logs: Should see "[DB] Migration: kolom max_followups ditambahkan."
# Restart
npm start
# Should NOT see migration message again
```

### P2. Leave Flow Timeout
```
User → #test pagi
User → 3
# Wait 5 minutes without responding
# User sends regular command
User → #help
Expected: Help message shown (not treated as date input)
Note: pendingLeaveFlow may still be active - this is known limitation
```

---

## Cleanup After Tests
```bash
# Restore backup
cp data/reminder.db.backup data/reminder.db

# Or keep new DB if tests passed
rm data/reminder.db.backup
```

---

## Success Criteria

✅ All test cases pass
✅ No errors in logs
✅ Database schema updated correctly
✅ Existing functionality not broken
✅ Help message shows new features
✅ Reminder messages show 4 quick reply options
✅ Max follow-ups setting persisted correctly
✅ Auto-resend respects user's max setting
✅ Leave flow completes successfully
✅ Auto-resend stops when leave registered
