const http = require('http');
const fs = require('fs');
const path = require('path');
const time = require('./config/time');
const defaults = require('./config/defaults');

// --- Parse CLI arguments ---
const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--time' && args[i + 1])  { opts.time  = args[++i]; continue; }
  if (args[i] === '--date' && args[i + 1])  { opts.date  = args[++i]; continue; }
  if (args[i] === '--day'  && args[i + 1])  { opts.day   = args[++i]; continue; }
  if (args[i] === '--speed' && args[i + 1]) { opts.speed  = args[++i]; continue; }
  if (args[i] === '--port' && args[i + 1])  { opts.port  = args[++i]; continue; }
  if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Reminder Presensi BPS - WhatsApp Bot

Usage:
  node src/index.js [options]

Options:
  --time HH:MM     Set simulated start time (e.g. --time 07:29)
  --date YYYY-MM-DD Set simulated date (e.g. --date 2026-02-06)
  --day  0-6       Set simulated day (0=Min, 1=Sen, ..., 6=Sab)
  --speed N        Speed multiplier (e.g. --speed 60 = 1 jam per menit)
  --port N         Health check HTTP port (default: 3000)
  --help           Show this help

Examples:
  node src/index.js --time 07:24
      → Start 1 menit sebelum reminder pagi (07:25)

  node src/index.js --time 07:20 --speed 60
      → Fast-forward: 1 menit simulasi = 1 detik real

  node src/index.js --time 16:04
      → Simulasi 1 menit sebelum reminder sore (16:05)

  node src/index.js --time 16:34 --day 5
      → Simulasi Jumat sore (reminder 16:35)

  node src/index.js --time 16:04 --date 2026-02-09 --day 1
      → Simulasi Senin sore, 1 menit sebelum reminder sore

  node src/index.js
      → Production mode (waktu real)
`);
    process.exit(0);
  }
}

// Configure simulated time (must happen before any module uses time)
try {
  time.configure(opts);
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}

// --- Cleanup stale Chromium lock files ---
// Prevents "profile in use by another process" error after Docker rebuild
const authBaseDir = path.join(__dirname, '..', '.wwebjs_auth');
const lockFileNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
function cleanupLockFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        cleanupLockFiles(fullPath);
      } else if (lockFileNames.includes(entry.name)) {
        fs.unlinkSync(fullPath);
        console.log(`[Cleanup] Removed stale lock: ${fullPath}`);
      }
    }
  } catch (err) {
    // Ignore if can't read/remove
  }
}
cleanupLockFiles(authBaseDir);

// --- Boot application ---
const wa = require('./modules/whatsapp');
const db = require('./db/database');
const scheduler = require('./modules/scheduler');
const handler = require('./modules/handler');

console.log('==========================================');
console.log('  Reminder Presensi BPS Kalimantan Utara');
console.log('  v2.0.0');
console.log('==========================================');
console.log(`  Mode: ${time.getStatusLabel()}`);
console.log('');

// --- Health check HTTP server ---
const HEALTH_PORT = opts.port || process.env.PORT || 3000;
let healthServer = null;

function startHealthServer() {
  healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const isWhatsAppReady = wa.getIsReady();
      const statusCode = isWhatsAppReady ? 200 : 503;
      
      const response = {
        status: isWhatsAppReady ? 'healthy' : 'unhealthy',
        whatsapp: isWhatsAppReady ? 'connected' : 'disconnected',
        time: time.getCurrentTime(),
        date: time.getCurrentDate(),
        uptime: process.uptime(),
        version: '2.0.0',
      };
      
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response, null, 2));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  healthServer.listen(HEALTH_PORT, () => {
    console.log(`[Health] HTTP server listening on port ${HEALTH_PORT}`);
    console.log(`[Health] Endpoint: http://localhost:${HEALTH_PORT}/health`);
  });
}

startHealthServer();

// --- Initialize WhatsApp client ---
const client = wa.createClient();

// Register message handler
client.on('message', async (msg) => {
  try {
    await handler.handleMessage(msg);
  } catch (err) {
    console.error('[Handler] Error:', err.message);
  }
});

// Connect scheduler → handler for pending reminder context
scheduler.onReminderSent((phone, type) => {
  handler.setPendingReminder(phone, type);
});

// Connect scheduler → handler for daily cleanup (midnight)
scheduler.onDailyCleanup(() => {
  handler.clearPendingStates();
});

// Start scheduler when WhatsApp is ready
client.on('ready', () => {
  // Register primary admin (hardcoded)
  const primaryAdmin = defaults.PRIMARY_ADMIN;
  let existingPrimary = db.getUser(primaryAdmin);
  if (existingPrimary) {
    db.setAdmin(primaryAdmin);
  } else {
    db.upsertUser(primaryAdmin, 'Admin Utama', 'admin');
  }
  console.log(`[App] Primary admin registered: ${primaryAdmin}`);

  // Register bot phone (receive-only)
  const botPhone = defaults.BOT_PHONE;
  let existingBot = db.getUser(botPhone);
  if (!existingBot) {
    db.upsertUser(botPhone, 'Bot Receiver', 'admin');
    db.updateUserSetting(botPhone, 'is_active', 0); // No reminders for bot
    console.log(`[App] Bot phone registered: ${botPhone}`);
  }

  // Register WhatsApp authenticated phone as admin if different
  const authPhone = wa.getAdminPhone();
  if (authPhone && authPhone !== primaryAdmin && authPhone !== botPhone) {
    const existing = db.getUser(authPhone);
    if (existing) {
      db.setAdmin(authPhone);
    } else {
      db.upsertUser(authPhone, 'Admin', 'admin');
    }
    console.log(`[App] WhatsApp auth phone registered as admin: ${authPhone}`);
  }

  scheduler.startScheduler();
  if (time.isSimulated()) {
    console.log(`[App] Simulated time: ${time.getCurrentTime()} | Date: ${time.getCurrentDate()}`);
    console.log('[App] Reminder akan trigger saat waktu simulasi cocok dengan jadwal user.');
  }
});

// Graceful shutdown
const shutdown = async () => {
  console.log('\n[App] Shutting down...');
  scheduler.stopScheduler();
  
  if (healthServer) {
    healthServer.close(() => {
      console.log('[Health] HTTP server closed.');
    });
  }
  
  await client.destroy();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the client
client.initialize();
