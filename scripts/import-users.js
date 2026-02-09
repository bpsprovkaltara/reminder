#!/usr/bin/env node

/**
 * Script Import User — Reminder Presensi BPS
 * 
 * Format file (CSV/TXT):
 *   Nama Lengkap,Nomor HP
 *   Nama Lengkap;Nomor HP
 *   Nama Lengkap - Nomor HP
 *   Nama Lengkap  08xxxxxxxxxx
 * 
 * Nomor HP otomatis dinormalisasi:
 *   08xxx  → 628xxx
 *   +62xxx → 628xxx
 *   62xxx  → 62xxx (tetap)
 * 
 * Usage:
 *   node scripts/import-users.js <file>
 *   node scripts/import-users.js data/pegawai.csv
 *   node scripts/import-users.js data/pegawai.csv --dry-run
 *   node scripts/import-users.js data/pegawai.csv --role admin
 */

const fs = require('fs');
const path = require('path');

// Resolve project root for database module
const projectRoot = path.join(__dirname, '..');
const db = require(path.join(projectRoot, 'src', 'db', 'database'));

// ─── CLI Arguments ────────────────────────────────────────────────
const args = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const roleFlag = args.indexOf('--role');
const role = roleFlag !== -1 && args[roleFlag + 1] ? args[roleFlag + 1] : 'user';

if (!filePath) {
  console.log(`
╔══════════════════════════════════════════════════════╗
║        📥  Import User — Reminder Presensi BPS      ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  Usage:                                              ║
║    node scripts/import-users.js <file> [options]     ║
║                                                      ║
║  Options:                                            ║
║    --dry-run     Simulasi tanpa menyimpan ke DB      ║
║    --role <role> Set role (default: user)             ║
║                                                      ║
║  Format file (CSV/TXT):                              ║
║    Nama Lengkap,08xxxxxxxxxx                         ║
║    Nama Lengkap;08xxxxxxxxxx                         ║
║    Nama Lengkap - 08xxxxxxxxxx                       ║
║    Nama Lengkap  08xxxxxxxxxx                        ║
║                                                      ║
║  Contoh:                                             ║
║    node scripts/import-users.js data/pegawai.csv     ║
║    node scripts/import-users.js data/list.txt        ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
`);
  process.exit(1);
}

// ─── Phone Number Normalization ───────────────────────────────────
function normalizePhone(phone) {
  // Hapus spasi, tanda hubung, titik, kurung
  let cleaned = phone.replace(/[\s\-\.\(\)\+]/g, '');

  // Validasi: hanya angka
  if (!/^\d+$/.test(cleaned)) return null;

  // Konversi format
  if (cleaned.startsWith('08')) {
    cleaned = '62' + cleaned.slice(1);
  } else if (cleaned.startsWith('8') && cleaned.length >= 10) {
    cleaned = '62' + cleaned;
  }

  // Validasi panjang (minimal 62 + 9 digit = 11, max 62 + 13 digit = 15)
  if (cleaned.length < 11 || cleaned.length > 15) return null;

  // Harus diawali 62
  if (!cleaned.startsWith('62')) return null;

  return cleaned;
}

// ─── Parse Line ───────────────────────────────────────────────────
function parseLine(line) {
  // Skip baris kosong dan komentar
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;

  // Skip header (jika baris pertama mengandung kata "nama" dan "nomor/hp/phone")
  const lower = trimmed.toLowerCase();
  if (lower.includes('nama') && (lower.includes('nomor') || lower.includes('hp') || lower.includes('phone') || lower.includes('telepon'))) {
    return null;
  }

  let name, phone;

  // Coba parsing dengan berbagai delimiter
  // 1. Comma: "Nama,08xxx"
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map(p => p.trim());
    if (parts.length >= 2) {
      // Deteksi mana nama dan mana nomor
      const [a, b] = parts;
      if (/^\+?\d[\d\s\-\.()]+$/.test(b.replace(/\s/g, ''))) {
        name = a;
        phone = b;
      } else if (/^\+?\d[\d\s\-\.()]+$/.test(a.replace(/\s/g, ''))) {
        name = b;
        phone = a;
      } else {
        name = a;
        phone = b;
      }
    }
  }
  // 2. Semicolon: "Nama;08xxx"
  else if (trimmed.includes(';')) {
    const parts = trimmed.split(';').map(p => p.trim());
    if (parts.length >= 2) {
      const [a, b] = parts;
      if (/^\+?\d[\d\s\-\.()]+$/.test(b.replace(/\s/g, ''))) {
        name = a;
        phone = b;
      } else {
        name = b;
        phone = a;
      }
    }
  }
  // 3. Dash separator: "Nama - 08xxx"
  else if (trimmed.includes(' - ')) {
    const parts = trimmed.split(' - ').map(p => p.trim());
    if (parts.length >= 2) {
      const [a, b] = parts;
      if (/^\+?\d[\d\s\-\.()]+$/.test(b.replace(/\s/g, ''))) {
        name = a;
        phone = b;
      } else {
        name = b;
        phone = a;
      }
    }
  }
  // 4. Tab: "Nama\t08xxx"
  else if (trimmed.includes('\t')) {
    const parts = trimmed.split('\t').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const [a, b] = parts;
      if (/^\+?\d[\d\s\-\.()]+$/.test(b.replace(/\s/g, ''))) {
        name = a;
        phone = b;
      } else {
        name = b;
        phone = a;
      }
    }
  }
  // 5. Space-separated: deteksi nomor di akhir
  else {
    const match = trimmed.match(/^(.+?)\s+([\+]?\d[\d\s\-\.()]{8,})$/);
    if (match) {
      name = match[1].trim();
      phone = match[2].trim();
    } else {
      // Coba deteksi nomor di awal
      const match2 = trimmed.match(/^([\+]?\d[\d\s\-\.()]{8,})\s+(.+)$/);
      if (match2) {
        phone = match2[1].trim();
        name = match2[2].trim();
      }
    }
  }

  if (!name || !phone) return null;

  // Clean name
  name = name.replace(/^["']|["']$/g, '').trim();
  phone = phone.replace(/^["']|["']$/g, '').trim();

  return { name, phone };
}

// ─── Main ─────────────────────────────────────────────────────────
function main() {
  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`❌ File tidak ditemukan: ${resolvedPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const lines = content.split(/\r?\n/);

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  📥  Import User — Reminder Presensi BPS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  📄 File  : ${resolvedPath}`);
  console.log(`  📝 Baris : ${lines.length}`);
  console.log(`  👤 Role  : ${role}`);
  if (dryRun) console.log('  ⚠️  Mode  : DRY RUN (tidak disimpan)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const results = {
    success: [],
    skipped: [],
    errors: [],
    duplicates: [],
  };

  const seenPhones = new Set();

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Parse line
    const parsed = parseLine(line);
    if (!parsed) {
      if (line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('//')) {
        const lower = line.trim().toLowerCase();
        const isHeader = lower.includes('nama') && (lower.includes('nomor') || lower.includes('hp') || lower.includes('phone'));
        if (!isHeader) {
          results.errors.push({ line: lineNum, text: line.trim(), reason: 'Format tidak dikenali' });
        }
      }
      continue;
    }

    // Normalize phone
    const normalizedPhone = normalizePhone(parsed.phone);
    if (!normalizedPhone) {
      results.errors.push({ line: lineNum, text: line.trim(), reason: `Nomor HP tidak valid: "${parsed.phone}"` });
      continue;
    }

    // Check duplicate in file
    if (seenPhones.has(normalizedPhone)) {
      results.duplicates.push({ line: lineNum, name: parsed.name, phone: normalizedPhone });
      continue;
    }
    seenPhones.add(normalizedPhone);

    // Validate name
    if (parsed.name.length < 2) {
      results.errors.push({ line: lineNum, text: line.trim(), reason: 'Nama terlalu pendek' });
      continue;
    }

    // Check if user already exists in DB
    const existing = db.getUser(normalizedPhone);
    if (existing) {
      results.skipped.push({ line: lineNum, name: parsed.name, phone: normalizedPhone, existingName: existing.name });
      continue;
    }

    // Insert user
    if (!dryRun) {
      try {
        db.upsertUser(normalizedPhone, parsed.name, role);
        results.success.push({ line: lineNum, name: parsed.name, phone: normalizedPhone });
      } catch (err) {
        results.errors.push({ line: lineNum, text: line.trim(), reason: err.message });
      }
    } else {
      results.success.push({ line: lineNum, name: parsed.name, phone: normalizedPhone });
    }
  }

  // ─── Report ───────────────────────────────────────────────────────
  if (results.success.length > 0) {
    console.log(`✅ Berhasil ${dryRun ? '(simulasi)' : 'diimport'}: ${results.success.length} user`);
    for (const u of results.success) {
      console.log(`   ├─ ${u.name} (${u.phone})`);
    }
    console.log('');
  }

  if (results.skipped.length > 0) {
    console.log(`⏭️  Dilewati (sudah terdaftar): ${results.skipped.length} user`);
    for (const u of results.skipped) {
      console.log(`   ├─ ${u.phone} — sudah terdaftar sebagai "${u.existingName}"`);
    }
    console.log('');
  }

  if (results.duplicates.length > 0) {
    console.log(`🔄 Duplikat di file: ${results.duplicates.length}`);
    for (const u of results.duplicates) {
      console.log(`   ├─ Baris ${u.line}: ${u.name} (${u.phone})`);
    }
    console.log('');
  }

  if (results.errors.length > 0) {
    console.log(`❌ Error: ${results.errors.length}`);
    for (const e of results.errors) {
      console.log(`   ├─ Baris ${e.line}: ${e.reason}`);
      console.log(`   │  "${e.text}"`);
    }
    console.log('');
  }

  // Summary
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  📊 Ringkasan:`);
  console.log(`     ✅ Berhasil  : ${results.success.length}`);
  console.log(`     ⏭️  Dilewati  : ${results.skipped.length}`);
  console.log(`     🔄 Duplikat  : ${results.duplicates.length}`);
  console.log(`     ❌ Error     : ${results.errors.length}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (dryRun && results.success.length > 0) {
    console.log('');
    console.log('💡 Jalankan tanpa --dry-run untuk menyimpan ke database.');
  }

  console.log('');
}

main();
