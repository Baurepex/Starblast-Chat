const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.io
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Express CORS Middleware
app.use(cors());
app.use(express.json());

// Discord Webhook URLs from Environment Variables
const DISCORD_WEBHOOK_LOGS = process.env.DISCORD_WEBHOOK_LOGS;
const DISCORD_WEBHOOK_CHAT = process.env.DISCORD_WEBHOOK_CHAT;

// Discord Webhook Function
async function sendDiscordWebhook(webhookUrl, content, embed = null) {
    if (!webhookUrl) {
        console.log('⚠️  Discord Webhook URL not configured');
        return;
    }
    
    try {
        const payload = { content };
        if (embed) {
            payload.embeds = [embed];
        }
        
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            console.error('Discord Webhook Error:', response.status);
        }
    } catch (error) {
        console.error('Discord Webhook Error:', error.message);
    }
}

// Discord Log Functions
function discordLogSuccess(username, code) {
    const embed = {
        title: '✅ Successful Verification',
        description: `**${username}** has verified`,
        color: 0x00ff88,
        fields: [
            { name: 'Code', value: code, inline: true },
            { name: 'Time', value: new Date().toLocaleString('en-US'), inline: true }
        ],
        timestamp: new Date().toISOString()
    };
    sendDiscordWebhook(DISCORD_WEBHOOK_LOGS, null, embed);
}

function discordLogFailed(username, code) {
    const embed = {
        title: '❌ Failed Verification',
        description: `**${username}** tried invalid code`,
        color: 0xff0000,
        fields: [
            { name: 'Attempted Code', value: code, inline: true },
            { name: 'Time', value: new Date().toLocaleString('en-US'), inline: true }
        ],
        timestamp: new Date().toISOString()
    };
    sendDiscordWebhook(DISCORD_WEBHOOK_LOGS, null, embed);
}

function discordLogConnect(username, code) {
    const embed = {
        title: '🔌 User Connected',
        description: `**${username}** joined the chat`,
        color: 0x0099ff,
        fields: [
            { name: 'Code', value: code, inline: true },
            { name: 'Time', value: new Date().toLocaleString('en-US'), inline: true }
        ],
        timestamp: new Date().toISOString()
    };
    sendDiscordWebhook(DISCORD_WEBHOOK_LOGS, null, embed);
}

function discordLogDisconnect(username, code) {
    const embed = {
        title: '🔌 User Disconnected',
        description: `**${username}** left the chat`,
        color: 0x808080,
        fields: [
            { name: 'Code', value: code, inline: true },
            { name: 'Time', value: new Date().toLocaleString('en-US'), inline: true }
        ],
        timestamp: new Date().toISOString()
    };
    sendDiscordWebhook(DISCORD_WEBHOOK_LOGS, null, embed);
}

function discordLogChatMessage(username, message) {
    const content = `**${username}:** ${message}`;
    sendDiscordWebhook(DISCORD_WEBHOOK_CHAT, content);
}

// Paths for files
const WHITELIST_PATH = path.join(__dirname, 'whitelist.txt');

// ====== 🔒 SECURITY FEATURES ======

// Feature 1: XSS-Schutz - HTML Escape
function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    
    return text.replace(/[&<>"']/g, m => map[m]);
}

function sanitizeMessage(message) {
    if (typeof message !== 'string') return null;
    
    message = message.trim();
    
    // Max 500 Zeichen
    if (message.length > 500) {
        message = message.substring(0, 500);
    }
    
    if (message.length === 0) {
        return null;
    }
    
    // Escape HTML (alle Zeichen erlaubt, aber HTML-escaped)
    return escapeHtml(message);
}

// Feature 2: Rate Limiting
const messageLimiter = new Map(); // socketId -> { count, resetTime }
const RATE_LIMIT_MESSAGES = 5;     // Max 5 Nachrichten
const RATE_LIMIT_WINDOW = 10000;   // pro 10 Sekunden

function checkRateLimit(socketId) {
    const now = Date.now();
    const limit = messageLimiter.get(socketId) || {
        count: 0,
        resetTime: now + RATE_LIMIT_WINDOW
    };
    
    // Zeit abgelaufen? Reset!
    if (now > limit.resetTime) {
        limit.count = 0;
        limit.resetTime = now + RATE_LIMIT_WINDOW;
    }
    
    // Zu viele Nachrichten?
    if (limit.count >= RATE_LIMIT_MESSAGES) {
        return false;
    }
    
    limit.count++;
    messageLimiter.set(socketId, limit);
    return true;
}

// Feature 3: Brute-Force Schutz
const failedAttempts = new Map(); // IP -> { count, blockedUntil }
const MAX_FAILED_ATTEMPTS = 5;
const BLOCK_DURATION = 5 * 60 * 1000; // 5 Minuten

function checkBruteForce(ip) {
    const now = Date.now();
    const attempts = failedAttempts.get(ip) || {
        count: 0,
        blockedUntil: 0
    };
    
    // Noch blockiert?
    if (now < attempts.blockedUntil) {
        const remainingSeconds = Math.ceil((attempts.blockedUntil - now) / 1000);
        return {
            blocked: true,
            remainingSeconds: remainingSeconds
        };
    }
    
    return { blocked: false };
}

function recordFailedAttempt(ip) {
    const now = Date.now();
    const attempts = failedAttempts.get(ip) || {
        count: 0,
        blockedUntil: 0
    };
    
    attempts.count++;
    
    if (attempts.count >= MAX_FAILED_ATTEMPTS) {
        attempts.blockedUntil = now + BLOCK_DURATION;
        attempts.count = 0;
        console.log(`🚫 IP ${ip} blocked for 5 minutes`);
    }
    
    failedAttempts.set(ip, attempts);
}

function clearFailedAttempts(ip) {
    failedAttempts.delete(ip);
}

// Feature 4: Input Validation
function isValidUsername(username) {
    if (typeof username !== 'string') return false;
    if (username.length < 2 || username.length > 20) return false;
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) return false;
    
    const blacklist = ['admin', 'system', 'mod', 'moderator', 'server'];
    if (blacklist.includes(username.toLowerCase())) return false;
    
    return true;
}

function isValidCodeFormat(code) {
    if (typeof code !== 'string') return false;
    if (code.length !== 9) return false;
    if (!/^[A-Z0-9]+$/.test(code.toUpperCase())) return false;
    
    return true;
}

// Code Masking für Logs
function maskCode(code) {
    if (!code || code.length !== 9) return '***';
    return code.substring(0, 2) + '*****' + code.substring(7);
}

// Whitelist and Code Tracking
let whitelist = new Set();
let codeUsage = {}; // { "CODE": ["username1", "username2"] }

// Load Whitelist
function loadWhitelist() {
    try {
        if (fs.existsSync(WHITELIST_PATH)) {
            const content = fs.readFileSync(WHITELIST_PATH, 'utf8');
            const lines = content.split('\n');
            
            whitelist.clear();
            lines.forEach(line => {
                const code = line.split('#')[0].trim().toUpperCase();
                if (code.length === 9) {
                    whitelist.add(code);
                }
            });
            
            console.log(`✅ Whitelist loaded: ${whitelist.size} codes`);
        } else {
            console.log('⚠️  whitelist.txt not found, creating empty file');
            fs.writeFileSync(WHITELIST_PATH, '# Enter codes here (9 digits)\n# Example: A3K9X7M2B # for Player1\n');
        }
    } catch (error) {
        console.error('❌ Error loading whitelist:', error);
    }
}

// Track code usage (only in memory)
function trackCodeUsage(code, username) {
    const upperCode = code.toUpperCase();
    
    if (!codeUsage[upperCode]) {
        codeUsage[upperCode] = [];
    }
    
    if (!codeUsage[upperCode].includes(username)) {
        codeUsage[upperCode].push(username);
        console.log(`📊 Code ${upperCode} is now also used by "${username}"`);
    }
}

// Validate code
function isValidCode(code) {
    return whitelist.has(code.toUpperCase());
}

// Store connected clients
const clients = new Map();
const messageHistory = [];
const MAX_HISTORY = 50;

// Broadcast Online Count to all clients
function broadcastOnlineCount() {
    const verifiedUsers = Array.from(clients.values())
        .filter(c => c.verified && c.username);
    
    const onlineCount = verifiedUsers.length;
    const usernames = verifiedUsers.map(c => c.username);
    
    io.emit('onlineCountUpdate', {
        count: onlineCount,
        users: usernames
    });
    
    console.log(`📊 Broadcasting online count: ${onlineCount} users`);
}

// Initial load
loadWhitelist();

// Reload whitelist (manual trigger via endpoint)
app.get('/reload-whitelist', (req, res) => {
    loadWhitelist();
    res.json({ 
        success: true, 
        message: 'Whitelist reloaded',
        totalCodes: whitelist.size 
    });
});

// Code Usage Endpoint (for overview)
app.get('/admin/code-usage', (req, res) => {
    res.json({
        success: true,
        timestamp: new Date().toISOString(),
        codeUsage: codeUsage,
        totalCodes: Object.keys(codeUsage).length,
        totalUsers: Object.values(codeUsage).flat().length
    });
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'Server running', 
        version: '2.0-secure',
        time: new Date().toISOString(),
        connectedClients: clients.size,
        whitelistedCodes: whitelist.size,
        trackedCodes: Object.keys(codeUsage).length,
        security: {
            xssProtection: true,
            rateLimiting: true,
            bruteForceProtection: true,
            inputValidation: true
        },
        discordWebhooksConfigured: {
            logs: !!DISCORD_WEBHOOK_LOGS,
            chat: !!DISCORD_WEBHOOK_CHAT
        }
    });
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);
    
    // Store client (unverified)
    clients.set(socket.id, {
        id: socket.id,
        username: null,
        verified: false,
        code: null,
        connectedAt: new Date()
    });
    
    // Request verification
    socket.emit('verifyRequired', {
        message: 'Please verify with /verify CODE'
    });
    
    // Code verification
socket.on('verifyCode', (data) => {
    const { code, username } = data;
    const client = clients.get(socket.id);
    
    if (!client) return;
    
    const ip = socket.handshake.address;
    
    // 🔒 FEATURE 3: Brute-Force Check
    const bruteForceCheck = checkBruteForce(ip);
    if (bruteForceCheck.blocked) {
        socket.emit('verifyFailed', {
            message: `🚫 Too many failed attempts. Try again in ${bruteForceCheck.remainingSeconds}s`,
            blocked: true
        });
        return;
    }
    
    // 🔒 FEATURE 4: Username Validation
    if (!isValidUsername(username)) {
        socket.emit('verifyFailed', {
            message: 'Invalid username format (2-20 chars, alphanumeric)'
        });
        return;
    }
    
    // 🔒 FEATURE 4: Code Format Validation
    if (!isValidCodeFormat(code)) {
        recordFailedAttempt(ip);
        socket.emit('verifyFailed', {
            message: 'Authentication failed'
        });
        return;
    }
    
    console.log(`🔐 Verification attempt from ${username}`);
    
    if (isValidCode(code)) {
        // Code ist gültig!
        client.verified = true;
        client.code = code.toUpperCase();
        client.username = username;
        
        trackCodeUsage(code, username);
        clearFailedAttempts(ip);
        
        console.log(`✅ ${username} verified successfully`);
        discordLogSuccess(username, maskCode(code.toUpperCase()));
        
        socket.emit('verifySuccess', {
            message: 'Verification successful! Welcome to the chat.'
        });
        
        socket.emit('welcome', {
            history: messageHistory,
            onlineUsers: Array.from(clients.values())
                .filter(c => c.verified && c.username)
                .map(c => c.username)
        });
        
        discordLogConnect(username, maskCode(code.toUpperCase()));
        
        socket.broadcast.emit('userJoined', {
            username: username,
            message: `${username} joined the chat`,
            timestamp: new Date().toISOString()
        });
        
        broadcastOnlineCount();
        
    } else {
        // Code ungültig
        recordFailedAttempt(ip);
        
        console.log(`❌ Invalid code attempt`);
        discordLogFailed(username, maskCode(code));
        
        socket.emit('verifyFailed', {
            message: 'Authentication failed'
        });
    }
});
    
    // Set username (only for verified users)
    socket.on('setUsername', (username) => {
        const client = clients.get(socket.id);
        if (client && client.verified) {
            client.username = username;
            console.log(`👤 Username updated for ${socket.id}: ${username}`);
        }
    });
    
    // Receive message (only from verified users)
socket.on('chatMessage', (data) => {
    const client = clients.get(socket.id);
    
    if (!client || !client.verified || !client.username) {
        socket.emit('verifyRequired', {
            message: 'You must be verified to send messages'
        });
        return;
    }
    
    // 🔒 FEATURE 2: Rate Limiting
    if (!checkRateLimit(socket.id)) {
        socket.emit('rateLimitError', {
            message: '⏱️ Slow down! Too many messages.'
        });
        return;
    }
    
    // 🔒 FEATURE 1 & 4: Sanitize Message (XSS-Schutz)
    const sanitized = sanitizeMessage(data.message);
    
    if (!sanitized) {
        return; // Leere/ungültige Nachricht ignorieren
    }
    
    const message = {
        id: Date.now() + Math.random(),
        username: client.username,
        message: sanitized,
        timestamp: new Date().toISOString(),
        type: 'user'
    };
    
    // Add to history
    messageHistory.push(message);
    if (messageHistory.length > MAX_HISTORY) {
        messageHistory.shift();
    }
    
    // Send to all VERIFIED clients
    io.emit('newMessage', message);
    
    console.log(`💬 ${message.username}: ${message.message}`);
    
    // Discord Log: Chat message
    discordLogChatMessage(message.username, message.message);
});
    
    // Request client list
    socket.on('requestUserList', () => {
        const client = clients.get(socket.id);
        if (client && client.verified) {
            socket.emit('userList', {
                users: Array.from(clients.values())
                    .filter(c => c.verified && c.username)
                    .map(c => ({
                        username: c.username,
                        connectedAt: c.connectedAt
                    }))
            });
        }
    });
    
    // Connection closed
    socket.on('disconnect', () => {
    const client = clients.get(socket.id);
    if (client && client.verified && client.username) {
        console.log(`🔌 Client disconnected: ${client.username}`);
        
        // 🔒 Cleanup Rate Limiter
        messageLimiter.delete(socket.id);
        
        discordLogDisconnect(client.username, maskCode(client.code));
        
        socket.broadcast.emit('userLeft', {
            username: client.username,
            message: `${client.username} left the chat`,
            timestamp: new Date().toISOString()
        });
        
        clients.delete(socket.id);
        
        broadcastOnlineCount();
        
    } else {
        console.log(`🔌 Unverified client disconnected: ${socket.id}`);
        messageLimiter.delete(socket.id);
        clients.delete(socket.id);
    }
});
    
    // Ping/Pong for connection check
    socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📋 Whitelist: ${whitelist.size} codes loaded`);
    console.log(`📊 Code Usage Tracking: Active`);
    console.log(`🔔 Discord Webhooks: ${DISCORD_WEBHOOK_LOGS ? '✅' : '❌'} Logs | ${DISCORD_WEBHOOK_CHAT ? '✅' : '❌'} Chat`);
});
