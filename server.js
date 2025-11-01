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
        time: new Date().toISOString(),
        connectedClients: clients.size,
        whitelistedCodes: whitelist.size,
        trackedCodes: Object.keys(codeUsage).length,
        discordWebhooksConfigured: {
            logs: !!DISCORD_WEBHOOK_LOGS,
            chat: !!DISCORD_WEBHOOK_CHAT
        }
    });
});

// Store connected clients
const clients = new Map();
const messageHistory = [];
const MAX_HISTORY = 50;

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
        
        console.log(`🔐 Verification attempt from ${socket.id} (${username}): ${code}`);
        
        if (isValidCode(code)) {
            // Code is valid
            client.verified = true;
            client.code = code.toUpperCase();
            client.username = username;
            
            // Track code usage
            trackCodeUsage(code, username);
            
            console.log(`✅ ${username} successfully verified with code ${code.toUpperCase()}`);
            
            // Discord Log: Successful verification
            discordLogSuccess(username, code.toUpperCase());
            
            // Send success to client
            socket.emit('verifySuccess', {
                message: 'Verification successful! Welcome to the chat.'
            });
            
            // Now send chat history
            socket.emit('welcome', {
                history: messageHistory,
                onlineUsers: Array.from(clients.values())
                    .filter(c => c.verified && c.username)
                    .map(c => c.username)
            });
            
            // Discord Log: User Connected
            discordLogConnect(username, code.toUpperCase());
            
            // Notify other users
            socket.broadcast.emit('userJoined', {
                username: username,
                message: `${username} joined the chat`,
                timestamp: new Date().toISOString()
            });
            
        } else {
            // Code is invalid
            console.log(`❌ Invalid code from ${username}: ${code}`);
            
            // Discord Log: Failed verification
            discordLogFailed(username, code);
            
            socket.emit('verifyFailed', {
                message: 'Code invalid, please try again'
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
        
        const message = {
            id: Date.now() + Math.random(),
            username: client.username,
            message: data.message,
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
            console.log(`🔌 Client disconnected: ${client.username} (Code: ${client.code})`);
            
            // Discord Log: User Disconnected
            discordLogDisconnect(client.username, client.code);
            
            // Broadcast: Player left
            socket.broadcast.emit('userLeft', {
                username: client.username,
                message: `${client.username} left the chat`,
                timestamp: new Date().toISOString()
            });
        } else {
            console.log(`🔌 Unverified client disconnected: ${socket.id}`);
        }
        
        clients.delete(socket.id);
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
