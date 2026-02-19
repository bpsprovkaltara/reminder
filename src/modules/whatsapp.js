const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const defaults = require('../config/defaults');
const time = require('../config/time');

let client = null;
let isReady = false;
let adminPhone = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 30000; // 30 seconds
let reconnectTimer = null;

function createClient() {
  // Puppeteer launch options
  const puppeteerOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-features=LockProfileCookieDatabase',
    ],
  };

  // Use system Chromium when available (Docker deployment)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log(`[WhatsApp] Menggunakan Chromium: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
  }

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'reminder-presensi-bps',
      dataPath: path.join(__dirname, '..', '..', '.wwebjs_auth'),
    }),
    puppeteer: puppeteerOpts,
  });

  setupEventHandlers();

  return client;
}

function setupEventHandlers() {
  client.on('qr', (qr) => {
    console.log('\n========================================');
    console.log('  Scan QR Code berikut dengan WhatsApp');
    console.log('========================================\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('[WhatsApp] Autentikasi berhasil.');
    reconnectAttempts = 0; // Reset on successful auth
  });

  client.on('auth_failure', (msg) => {
    console.error('[WhatsApp] Autentikasi gagal:', msg);
  });

  client.on('ready', async () => {
    isReady = true;
    reconnectAttempts = 0; // Reset on ready
    
    // Get the phone number of the authenticated user
    try {
      const info = client.info;
      if (info && info.wid && info.wid.user) {
        adminPhone = info.wid.user;
        console.log(`[WhatsApp] Client phone: ${adminPhone}`);
      }
    } catch (err) {
      console.warn('[WhatsApp] Gagal mendapatkan client phone:', err.message);
    }
    
    console.log('[WhatsApp] Client siap. Bot aktif.');
    
    // Send startup notification to primary admin
    await notifyAdmins('BOT_STARTED');
  });

  client.on('disconnected', async (reason) => {
    const wasReady = isReady;
    isReady = false;
    console.warn(`[WhatsApp] Terputus: ${reason}`);
    
    // Notify admins if bot was running
    if (wasReady) {
      await notifyAdmins('BOT_STOPPED');
    }
    
    // Auto-reconnect
    attemptReconnect();
  });

  client.on('change_state', (state) => {
    console.log('[WhatsApp] State changed:', state);
  });
}

function attemptReconnect() {
  // Clear any existing reconnect timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`[WhatsApp] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
    return;
  }

  reconnectAttempts++;
  console.log(`[WhatsApp] Attempting reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${RECONNECT_DELAY_MS / 1000}s...`);

  reconnectTimer = setTimeout(async () => {
    try {
      console.log('[WhatsApp] Reconnecting...');
      await client.initialize();
      
      // Wait for ready state
      const readyPromise = new Promise((resolve) => {
        const checkReady = setInterval(() => {
          if (isReady) {
            clearInterval(checkReady);
            resolve();
          }
        }, 1000);
        
        // Timeout after 60s
        setTimeout(() => {
          clearInterval(checkReady);
          resolve();
        }, 60000);
      });
      
      await readyPromise;
      
      if (isReady) {
        console.log('[WhatsApp] Reconnect successful!');
        await notifyAdmins('BOT_RECONNECTED');
      } else {
        console.warn('[WhatsApp] Reconnect timed out, will retry...');
        attemptReconnect();
      }
    } catch (err) {
      console.error('[WhatsApp] Reconnect failed:', err.message);
      attemptReconnect();
    }
  }, RECONNECT_DELAY_MS);
}

/**
 * Send notification to all admins
 * @param {string} type - Notification type (BOT_STARTED, BOT_STOPPED, BOT_RECONNECTED)
 */
async function notifyAdmins(type) {
  if (!defaults.MESSAGES[type]) return;
  
  const currentTime = time.getCurrentTime();
  const message = defaults.MESSAGES[type].replace('{time}', currentTime);
  
  // Send to primary admin only
  const primaryAdmin = defaults.PRIMARY_ADMIN;
  
  // Wait a bit to ensure client is ready
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  try {
    await sendMessage(primaryAdmin, message);
    console.log(`[WhatsApp] Notified admin (${type}): ${primaryAdmin}`);
  } catch (err) {
    console.error(`[WhatsApp] Failed to notify admin:`, err.message);
  }
}

function getClient() {
  if (!client) throw new Error('WhatsApp client belum diinisialisasi');
  return client;
}

function getIsReady() {
  return isReady;
}

async function sendMessage(phone, text) {
  if (!isReady) {
    console.warn('[WhatsApp] Client belum siap, pesan tidak dikirim ke', phone);
    return null;
  }
  
  // Always use @c.us format with actual phone number (not LID)
  // phone should already be normalized (e.g., 6285155228104)
  const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
  
  try {
    return await client.sendMessage(chatId, text);
  } catch (err) {
    console.error('[WhatsApp] Gagal kirim pesan ke', chatId, ':', err.message);
    return null;
  }
}

/**
 * Post a text message to WhatsApp Status (Story).
 * Uses the special 'status@broadcast' chat ID.
 * @param {string} text - The status text to post
 * @returns {Promise<object|null>} The sent message or null on failure
 */
async function sendStatus(text) {
  if (!isReady) {
    console.warn('[WhatsApp] Client belum siap, status tidak diposting.');
    return null;
  }

  try {
    const result = await client.sendMessage('status@broadcast', text);
    console.log('[WhatsApp] Status berhasil diposting.');
    return result;
  } catch (err) {
    console.error('[WhatsApp] Gagal posting status:', err.message);
    return null;
  }
}

function getAdminPhone() {
  return adminPhone;
}

module.exports = {
  createClient,
  getClient,
  getIsReady,
  getAdminPhone,
  sendMessage,
  sendStatus,
};
