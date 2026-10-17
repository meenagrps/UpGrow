require('dotenv').config(); 

// =========================================================
// 📱 CONFIGURE YOUR WHATSAPP NUMBER HERE 
// =========================================================
const LINKING_PHONE_NUMBER = process.env.PHONE;

if (!LINKING_PHONE_NUMBER) {
    console.error("⚠️ [WARNING] 'PHONE' secret is missing!");
}

const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, makeCacheableSignalKeyStore, isJidBroadcast } = require('@whiskeysockets/baileys');
const pino = require('pino');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fs = require('fs');       
const path = require('path'); 

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [ANTI-CRASH] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ [ANTI-CRASH] Uncaught Exception:', err);
});

// ADVANCED FIX: Silence hardcoded console.error / console.warn / console.log spam from internal libsignal decryption retries
const LIBSIGNAL_SPAM_PATTERNS = [
    'Bad MAC',
    'Failed to decrypt message with any known session',
    'Session error:',
    'verifyMAC',
    'doDecryptWhisperMessage',
    'decryptWithSessions',
    '_asyncQueueExecutor',
    'Closing open session in favor of incoming prekey bundle'
];

function isLibsignalSpam(args) {
    try {
        const msg = args.map(a => (typeof a === 'string' ? a : (a?.stack || a?.message || ''))).join(' ');
        return LIBSIGNAL_SPAM_PATTERNS.some(pattern => msg.includes(pattern));
    } catch (e) {
        return false;
    }
}

const origConsoleError = console.error;
console.error = function (...args) {
    if (isLibsignalSpam(args)) return;
    origConsoleError.apply(console, args);
};

const origConsoleWarn = console.warn;
console.warn = function (...args) {
    if (isLibsignalSpam(args)) return;
    origConsoleWarn.apply(console, args);
};

const origConsoleLog = console.log;
console.log = function (...args) {
    if (isLibsignalSpam(args)) return;
    origConsoleLog.apply(console, args);
};

// ==========================================
// 🔥 FIREBASE INIT (JSON File Support for msg.js)
// ==========================================
if (!admin.apps.length) {
    console.warn("⚠️ [SAFETY CATCH] Firebase Admin was not initialized prior. Initializing with credentials...");
    try {
        let serviceAccount;
        const localKeyPath = path.join(__dirname, 'firebaseAccountsKeys.json');
        
        if (fs.existsSync(localKeyPath)) {
            serviceAccount = require(localKeyPath);
            console.log("🔥 Loaded Firebase credentials from local firebaseAccountsKeys.json in msg.js");
        } else {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            console.log("🔥 Loaded Firebase credentials from Environment Variables in msg.js");
        }
        
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("🔥 Firebase Admin Initialized Successfully in msg.js");
    } catch (error) {
        console.error("❌ Firebase Admin Initialization Error in msg.js:", error.message);
    }
}
const db = admin.firestore();

let systemInitialized = false; 
let activeSocket = null; // Holds the Baileys socket for external functions
const messageQueue = {}; 
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const processedDocs = new Set(); 
setInterval(() => {
    processedDocs.clear();
    console.log("🧹 Cleared processedDocs cache to free memory.");
}, 12 * 60 * 60 * 1000); 

// --- LIGHTWEIGHT IN-MEMORY MESSAGE CACHE FOR MULTI-DEVICE RETRY HANDSHAKES ---
const recentSentMessagesCache = new Map();
function cacheMessageForRetry(key, messageContent) {
    if (!key || !key.id || !messageContent) return;
    recentSentMessagesCache.set(key.id, messageContent);
    if (recentSentMessagesCache.size > 500) {
        const oldestKey = recentSentMessagesCache.keys().next().value;
        recentSentMessagesCache.delete(oldestKey);
    }
}

// --- ADVANCED EDGE-CASE HELPERS: CONNECTION LOCK & WAIT FOR SOCKET ---
let isStartingClient = false;
let reconnectTimeout = null;
let badSessionStrikeCount = 0;
const MAX_BAD_SESSION_STRIKES = 4;

async function waitForSocketOpen(maxWaitMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        if (global.isSocketConnected && activeSocket) return activeSocket;
        await sleep(500);
    }
    return activeSocket;
}

// --- FIX: UNIVERSAL SAFE SENDING HELPER (BAILEYS EDITION) ---
async function safeSendMessage(sock, jid, message, agentName) {
    const liveSock = (global.isSocketConnected && activeSocket) ? activeSocket : await waitForSocketOpen(12000) || sock;
    try {
        // 1. Resolve the correct WhatsApp ID securely via Baileys
        let plainPhone = String(jid).replace(/\D/g, '');
        const results = await liveSock.onWhatsApp(plainPhone);
        const finalId = (results && results.length > 0) ? results[0].jid : `${plainPhone}@s.whatsapp.net`;

        // 2. Direct Send (Works instantly even if the chat isn't in recent memory)
        await liveSock.sendMessage(finalId, { text: message });
        console.log(`✅ Message successfully sent to ${agentName || jid}`);
        return true;
        
    } catch (error) {
        // 3. Ultimate Fallback: Try raw JID if serialization fails
        try {
            let fallbackId = String(jid).replace('@c.us', '@s.whatsapp.net');
            if (!fallbackId.includes('@s.whatsapp.net')) fallbackId = fallbackId.replace(/\D/g, '') + '@s.whatsapp.net';
            
            await liveSock.sendMessage(fallbackId, { text: message });
            console.log(`✅ Message successfully sent to ${agentName || jid} (via fallback)`);
            return true;
        } catch (finalErr) {
            console.error(`❌ Critical Failure: Could not reach ${agentName || jid}:`, finalErr.message);
            return false;
        }
    }
}

// --- MESSAGE TEMPLATES ---
function getRandomReminderTemplate(agentName, count, formattedAmount) {
    const draftWord = count === 1 ? 'draft' : 'drafts';
    const isAre = count === 1 ? 'is' : 'are';
    const itThem = count === 1 ? 'it' : 'them';
    const thisThese = count === 1 ? 'this' : 'these';

    const greetings = [
        `*UP FIELD REMINDER* 🏢\n\nHello *${agentName}*,`,
        `*UP FIELD ALERT* 🏢\n\nHi *${agentName}*,`,
        `*UP FIELD DRAFT ALERT* 🏢\n\nHello *${agentName}*,`
    ];

    const bodies = [
        `You currently have *${count} ${draftWord}* totaling *₹${formattedAmount}* waiting in your app.`,
        `We noticed you have *${count} pending ${draftWord}* worth *₹${formattedAmount}* securely saved in your account.`,
        `Our system shows *${count} ${draftWord}* with a total of *₹${formattedAmount}* pending your action.`
    ];

    const closings = [
        `Please ensure you submit ${itThem} to the admin queue before the end of your shift today.`,
        `Make sure to clear your drafts by submitting ${itThem} to the admin queue today.`,
        `Ensure ${thisThese} ${isAre} fully submitted so the admins can review ${itThem}.`
    ];
    
    const g = greetings[Math.floor(Math.random() * greetings.length)];
    const b = bodies[Math.floor(Math.random() * bodies.length)];
    const c = closings[Math.floor(Math.random() * closings.length)];
    return `${g}\n${b}\n\n${c}`;
}

function getRandomConfirmationTemplate(agentName, count, formattedAmount, timeNow) {
    const entryWord = count === 1 ? 'entry' : 'entries';
    const hasHave = count === 1 ? 'has' : 'have';

    const headings = [
        `*UP FIELD* 🏢\n*Submission Confirmed* ✅\n\n`,
        `*UP FIELD* 🏢\n*Successfully Submitted* ✅\n\n`
    ];

    const praises = [`Great job, *${agentName}*!`, `Excellent work, *${agentName}*!`, `Well done, *${agentName}*!`];

    const bodies = [
        `You have successfully submitted *${count} ${entryWord}* totaling *₹${formattedAmount}* to the pending queue at ${timeNow}.`,
        `*${count} ${entryWord}* totaling *₹${formattedAmount}* ${hasHave} been officially pushed to the pending queue at ${timeNow}.`
    ];
    
    const h = headings[Math.floor(Math.random() * headings.length)];
    const p = praises[Math.floor(Math.random() * praises.length)];
    const b = bodies[Math.floor(Math.random() * bodies.length)];
    return `${h}${p} ${b}`;
}

// ---------------------------------------------------------
// 1. WHATSAPP CLIENT INITIALIZATION (BAILEYS EDITION)
// ---------------------------------------------------------
console.log("⏳ Initializing WhatsApp Engine...");

// Cross-Platform Browser Detector (Legacy preserved for structure, unused by Baileys)
const getBrowserPath = () => {
    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium'
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return undefined; 
};

let connectionRetries = 0;
const MAX_RETRIES = 10;

function scheduleSafeReconnect(delayMs) {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        startWhatsAppClient();
    }, delayMs);
}

async function startWhatsAppClient() {
    if (isStartingClient) {
        console.log("⏳ [GUARD] WhatsApp Client boot already in progress. Skipping duplicate call...");
        return;
    }
    isStartingClient = true;

    console.log(`🚀 Booting Baileys WhatsApp Client (Attempt ${connectionRetries + 1}/${MAX_RETRIES})...`);
    if (connectionRetries >= MAX_RETRIES) {
        console.error("❌ CRITICAL: Maximum connection retries exceeded. Resetting retry counter for cool-down recovery instead of crashing...");
        connectionRetries = 0;
        isStartingClient = false;
        scheduleSafeReconnect(60000);
        return;
    }
    
    try {
        // Safely clean up any dangling previous socket listeners before creating a new socket
        if (activeSocket) {
            try {
                activeSocket.ev.removeAllListeners('connection.update');
                activeSocket.ev.removeAllListeners('creds.update');
                activeSocket.ev.removeAllListeners();
                if (activeSocket.ws) activeSocket.ws.close();
                activeSocket.end(undefined);
            } catch (cleanupErr) {}
        }

        const { state, saveCreds } = await useMultiFileAuthState('whatsapp-session-baileys');
        const silentLogger = pino({ level: 'silent' });
        
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                // Cache Signal keys in memory to prevent slow disk I/O 'Stream Errored (ack)' (Status 500) on Render Free Tier
                keys: typeof makeCacheableSignalKeyStore === 'function'
                    ? makeCacheableSignalKeyStore(state.keys, silentLogger)
                    : state.keys
            },
            logger: silentLogger, 
            browser: Browsers.ubuntu('Chrome'), // Distinct browser fingerprint for Bot 2 (Original: Browsers.macOS('Desktop'))
            printQRInTerminal: false,
            keepAliveIntervalMs: 25000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            // ADVANCED FIX 1: Ignore status broadcasts & newsletters that trigger Bad MAC loops across multiple linked bots
            shouldIgnoreJid: (jid) => isJidBroadcast(jid) || (typeof jid === 'string' && (jid.includes('broadcast') || jid.endsWith('@newsletter'))),
            // ADVANCED FIX 2: Fulfill retry handshakes when companion devices/bots desync on Signal ratchets
            getMessage: async (key) => {
                if (key?.id && recentSentMessagesCache.has(key.id)) {
                    return recentSentMessagesCache.get(key.id);
                }
                return { conversation: '' };
            }
        });

        // Wrap sendMessage to automatically cache outgoing messages for multi-device retry requests
        const origSendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options) => {
            const sentMsg = await origSendMessage(jid, content, options);
            if (sentMsg?.key && sentMsg?.message) {
                cacheMessageForRetry(sentMsg.key, sentMsg.message);
            }
            return sentMsg;
        };

        // Cache incoming/synced messages for retry handshakes
        sock.ev.on('messages.upsert', ({ messages }) => {
            if (Array.isArray(messages)) {
                for (const m of messages) {
                    if (m?.key && m?.message) {
                        cacheMessageForRetry(m.key, m.message);
                    }
                }
            }
        });

        activeSocket = sock;
        isStartingClient = false;

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('🔄 Authentication required. Generating QR code string for UI...');
                global.globalQRString = qr;
                global.isRestoringSession = false;
            }

            if (connection === 'close') {
                global.isSocketConnected = false;
                global.lastConnectedTimestamp = 0;
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorMessage = lastDisconnect?.error?.message || '';

                // Track consecutive 500 (badSession / Stream Errored) strikes in case session files are genuinely corrupted
                if (statusCode === 500 || statusCode === DisconnectReason.badSession) {
                    badSessionStrikeCount++;
                } else {
                    badSessionStrikeCount = 0;
                }

                // ONLY treat explicit logouts (401), forbidden (403), multidevice mismatch (411), or repeated unrecoverable 500 loops as fatal
                const isFatal = 
                    statusCode === DisconnectReason.loggedOut || 
                    statusCode === 401 || 
                    statusCode === 403 || 
                    statusCode === DisconnectReason.multideviceMismatch ||
                    (statusCode === 500 && badSessionStrikeCount >= MAX_BAD_SESSION_STRIKES);
                
                console.log('❌ WhatsApp Disconnected. Reason:', lastDisconnect?.error, 'Status:', statusCode);
                
                // Cleanly destroy the closed socket instance to prevent ghost listeners and overlapping file writes
                try {
                    sock.ev.removeAllListeners();
                    if (sock.ws) sock.ws.close();
                    sock.end(undefined);
                } catch (e) {}

                if (!isFatal) {
                    // Edge Case 1: QR Code timed out (Status 408) while waiting for scan - don't burn retry attempts
                    if (statusCode === DisconnectReason.timedOut || statusCode === 408 || errorMessage.includes('QR refs attempts ended')) {
                        console.log('⏳ QR/Connection timed out (408). Refreshing socket cleanly without burning retry limit...');
                        scheduleSafeReconnect(5000);
                        return;
                    }

                    // Edge Case 2: Connection Replaced (Status 440) - Another instance took over; wait longer to avoid conflict loop
                    if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
                        console.warn('⚠️ Connection replaced by another instance (Status 440). Backing off for 45s...');
                        scheduleSafeReconnect(45000);
                        return;
                    }

                    // Edge Case 3: Stream Errored (ack) (Status 500) or Restart Required (Status 515) - Fast reconnect with existing creds
                    if (statusCode === 500 || statusCode === DisconnectReason.restartRequired || statusCode === 515) {
                        console.log(`🔄 Stream/Restart disconnect (Status ${statusCode}, Strike ${badSessionStrikeCount}/${MAX_BAD_SESSION_STRIKES}). Reconnecting quickly without wiping session...`);
                        connectionRetries++;
                        scheduleSafeReconnect(3500);
                        return;
                    }

                    // Standard transient network disconnect backoff
                    connectionRetries++;
                    const retryDelay = Math.min(15000 * connectionRetries, 60000); 
                    console.log(`🔄 Temporary disconnect (Status ${statusCode}). Reconnecting in ${retryDelay / 1000}s...`);
                    scheduleSafeReconnect(retryDelay);
                } else {
                    console.log('⚠️ Session expired or logged out. Requesting new QR...');
                    badSessionStrikeCount = 0;
                    global.isSessionExpired = true;
                    global.sessionExpiredMessage = "Your WhatsApp session was logged out. Please link again.";
                    global.hasTriedRootBackup = true;
                    global.globalQRString = null;

                    try {
                        fs.rmSync('./whatsapp-session-baileys', { recursive: true, force: true });
                    } catch (rmErr) {
                        console.error('⚠️ Failed to remove session directory:', rmErr.message);
                    }
                    try {
                        const backupPath = path.join(__dirname, 'whatsapp-session.json');
                        if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
                    } catch (e) {}

                    connectionRetries = 0;
                    scheduleSafeReconnect(2000);
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp Web Client is READY and CONNECTED!');
                connectionRetries = 0;
                badSessionStrikeCount = 0;
                global.isSocketConnected = true;
                global.globalQRString = null;
                global.isSessionExpired = false;
                global.isRestoringSession = false;
                global.lastConnectedTimestamp = Date.now();

                if (!systemInitialized) {
                    setupScheduledJobs();
                    setupFirestoreListener();
                    systemInitialized = true;
                }
                
                // Cleanup legacy QR physical file if it exists
                try { if (fs.existsSync('qr-code.png')) fs.unlinkSync('qr-code.png'); } catch (fsErr) {}
                
                // ==========================================
                // 5. EXTERNAL REQUIRE CHECK (Re-binds socket on connect)
                // ==========================================
                if (fs.existsSync('./check.js')) {
                    try {
                        // Clear require cache so listener binds to the fresh socket on reconnects
                        delete require.cache[require.resolve('./check.js')];
                        require('./check.js')(sock); 
                        console.log("🔍 check.js external script executed successfully.");
                    } catch (error) {
                        console.error("❌ Failed to execute check.js:", error.message);
                    }
                }
            }
        });

        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds();
            } catch (credErr) {
                console.error("⚠️ Failed to save Baileys credentials:", credErr.message);
            }
        });

    } catch (err) {
        isStartingClient = false;
        console.error("❌ WhatsApp Engine Failed to Start:", err.message);
        connectionRetries++;
        const retryDelay = Math.min(15000 * connectionRetries, 60000); 
        scheduleSafeReconnect(retryDelay);
    }
}
startWhatsAppClient();

// RAM GUARD OPTIMIZED FOR V8 (Replaces old Puppeteer page clear)
setInterval(async () => {
    try {
        const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024;
        if (memoryUsage > 450) {
            console.log(`⚠️ High Memory Detected (${Math.round(memoryUsage)}MB). Purging WhatsApp caches...`);
            recentSentMessagesCache.clear();
            if (global.gc) {
                global.gc();
            }
        }
    } catch (memErr) {}
}, 300000); 

// ---------------------------------------------------------
// 2. FETCH AGENT DETAILS (UPDATED: Queries 'users' collection)
// ---------------------------------------------------------
const userCache = new Map(); 
setInterval(() => { userCache.clear(); }, 24 * 60 * 60 * 1000); 

async function getAgentDetails(uid) {
    if (userCache.has(uid)) return userCache.get(uid);

    try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return null;
        
        const data = userDoc.data();
        if (!data.phone) return null;

        let cleanNumber = data.phone.replace(/\D/g, ''); 
        if (cleanNumber.length === 10) cleanNumber = '91' + cleanNumber;
        // Adapted to Baileys formatting
        let formattedPhone = cleanNumber + '@s.whatsapp.net';
        
        const details = { name: data.name || 'Agent', phone: formattedPhone };
        userCache.set(uid, details);
        return details;
    } catch (e) {
        console.error(`Error fetching user ${uid} from Auth:`, e.message);
        return null;
    }
}

// ---------------------------------------------------------
// 3. CRON JOB: 5 PM & 10 PM DRAFT REMINDER (UPDATED: daily_logs)
// ---------------------------------------------------------
function setupScheduledJobs() {
    const runAlerts = async () => {
        const timeNow = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
        console.log(`[${timeNow}] ⏰ Running Draft Alert Check...`);
        
        try {
            const snap = await db.collection('daily_logs').get();
            if (snap.empty) return;

            const agentStats = {}; 
            
            snap.forEach(doc => {
                const uid = doc.id.split('_')[0]; // Extract UID from document name
                if (!uid) return;
                
                const data = doc.data();
                Object.keys(data).forEach(key => {
                    if (key !== 'activeCustomers' && data[key] && data[key].status === 'pending') {
                        if (!agentStats[uid]) agentStats[uid] = { count: 0, totalAmount: 0 };
                        agentStats[uid].count++;
                        agentStats[uid].totalAmount += parseFloat(data[key].amount || 0);
                    }
                });
            });

            for (const [uid, stats] of Object.entries(agentStats)) {
                if(stats.count > 0 && activeSocket) {
                    const agent = await getAgentDetails(uid);
                    if (agent && agent.phone) {
                        const formattedAmount = stats.totalAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
                        const msg = getRandomReminderTemplate(agent.name, stats.count, formattedAmount);
                        await sleep(500); 
                        await safeSendMessage(activeSocket, agent.phone, msg, agent.name);
                    }
                }
            }
        } catch (error) {
            console.error('Error in Cron:', error);
        }
    };

    cron.schedule('0 17 * * *', runAlerts, { scheduled: true, timezone: "Asia/Kolkata" });
    cron.schedule('0 22 * * *', runAlerts, { scheduled: true, timezone: "Asia/Kolkata" });
}

// ---------------------------------------------------------
// 4. FIRESTORE LISTENER (UPDATED: Watches daily_logs for 'submitted')
// ---------------------------------------------------------
function setupFirestoreListener() {
    let isInitialLoad = true;

    db.collection('daily_logs').onSnapshot(async (snapshot) => {
        if (isInitialLoad) {
            isInitialLoad = false;
            console.log(`✅ Initial Firestore sync complete. Now watching for fresh submissions...`);
            return;
        }

        const submissionsByAgent = {};

        snapshot.docChanges().forEach((change) => {
            if (change.type === 'added' || change.type === 'modified') {
                const data = change.doc.data();
                const uid = change.doc.id.split('_')[0];
                
                Object.keys(data).forEach(key => {
                    if (key !== 'activeCustomers' && data[key] && data[key].status === 'submitted') {
                        const uniqueId = `${change.doc.id}_${key}`; // Ensure we only message once per submitted item
                        if (processedDocs.has(uniqueId)) return;
                        processedDocs.add(uniqueId);
                        
                        if (data[key].submittedBySystem) return; // Ignore cron job submits
                        
                        if (!submissionsByAgent[uid]) submissionsByAgent[uid] = { count: 0, totalAmount: 0 };
                        submissionsByAgent[uid].count++;
                        submissionsByAgent[uid].totalAmount += parseFloat(data[key].amount || 0);
                    }
                });
            }
        });

        for (const [uid, stats] of Object.entries(submissionsByAgent)) {
            if (!messageQueue[uid]) {
                messageQueue[uid] = { count: 0, totalAmount: 0, timer: null };
            }
            
            messageQueue[uid].count += stats.count;
            messageQueue[uid].totalAmount += stats.totalAmount;

            if (messageQueue[uid].timer) clearTimeout(messageQueue[uid].timer);

            messageQueue[uid].timer = setTimeout(async () => {
                const finalStats = { count: messageQueue[uid].count, totalAmount: messageQueue[uid].totalAmount };
                delete messageQueue[uid];
                
                const agent = await getAgentDetails(uid);
                if (agent && agent.phone && activeSocket) {
                    const timeNow = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
                    const formattedAmount = finalStats.totalAmount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
                    const msg = getRandomConfirmationTemplate(agent.name, finalStats.count, formattedAmount, timeNow);
                    
                    await sleep(500); 
                    await safeSendMessage(activeSocket, agent.phone, msg, agent.name);
                }
            }, 3400); 
        }
    }, (error) => {
        console.error("❌ Firestore Listener Error:", error);
    });
}

module.exports = {
    restartClient: async () => {
        badSessionStrikeCount = 0;
        connectionRetries = 0;
        isStartingClient = false;
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
        try {
            if (activeSocket) {
                activeSocket.ev.removeAllListeners();
                if (activeSocket.ws) activeSocket.ws.close();
                activeSocket.end(undefined);
            }
        } catch(e) {}
        try { if (fs.existsSync('qr-code.png')) fs.unlinkSync('qr-code.png'); } catch (fsErr) {}
        
        fs.rmSync('./whatsapp-session-baileys', { recursive: true, force: true });
        scheduleSafeReconnect(2000);
    }
};
