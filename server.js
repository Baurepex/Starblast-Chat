const express = require('express');
const http = require('http');
const https = require('https');
const socketIO = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// CORS konfigurieren für Socket.io
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

// Discord Webhook URLs aus Environment Variables
const DISCORD_WEBHOOK_LOGS = process.env.DISCORD_WEBHOOK_LOGS;
const DISCORD_WEBHOOK_CHAT = process.env.DISCORD_WEBHOOK_CHAT;

// Discord Webhook Funktion (mit https Modul statt fetch)
function sendDiscordWebhook(webhookUrl, content, embed = null) {
    if (!webhookUrl) {
        console.log('⚠️  Discord Webhook URL nicht konfiguriert');
        return;
    }
    
    try {
        const payload = JSON.stringify({
            content: content || undefined,
            embeds: embed ? [embed] : undefined
        });
        
        const url = new URL(webhookUrl);
        
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        
        const req = https.request(options, (res) => {
            if (res.statusCode !== 204 && res.statusCode !== 200) {
                console.error('Discord Webhook Fehler:', res.statusCode);
            }
        });
        
        req.on('error', (error) => {
            console.error('Discord Webhook Fehler:', error.message);
        });
        
        req.write(payload);
        req.end();
    } catch (error) {
        console.error('Discord Webhook Fehler:', error.message);
    }
}

// Discord Log-Funktionen
function discordLogSuccess(username, code) {
    const embed = {
        title: '✅ Erfolgreiche Verifizierung',
        description: `**${username}** hat sich verifiziert`,
        color: 0x00ff88,
        fields: [
            { name: 'Code', value: code, inline: true },
            { name: 'Zeitpunkt', value: new Date().toLocaleString('de-DE'), inline: true }
        ],
        timestamp: new Date().toISOString()
    };
    sendDiscordWebhook(DISCORD_WEBHOOK_LOGS, null, embed);
}

function discordLogFailed(username, code) {
    const embed = {
        title: '❌ Fehlgeschlagene Verifizierung',
        description: `**${username}** versuchte ungültigen Code`,
        color: 0xff0000,
        fields: [
            { name: 'Versuchter Code', value: code, inline: true },
            { name: 'Zeitpunkt', value: new Date().toLocaleString('de-DE'), inline: true }
        ],
        timestamp: new Date().toISOString()
    };
    sendDiscordWebhook(DISCORD_WEBHOOK_LOGS, null, embed);
}

function discordLogConnect(username, code) {
    const embed = {
        title: '🔌 User Connected',
        description: `**${username}** ist dem Chat beigetreten`,
        color: 0x0099ff,
        fields: [
            { name: 'Code', value: code, inline: true },
            { name: 'Zeitpunkt', value: new Date().toLocaleString('de-DE'), inline: true }
        ],
        timestamp: new Date().toISOString()
    };
    sendDiscordWebhook(DISCORD_WEBHOOK_LOGS, null, embed);
}

function discordLogDisconnect(username, code) {
    const embed = {
        title: '🔌 User Disconnected',
        description: `**${username}** hat den Chat verlassen`,
        color: 0x808080,
        fields: [
            { name: 'Code', value: code, inline: true },
            { name: 'Zeitpunkt', value: new Date().toLocaleString('de-DE'), inline: true }
        ],
        timestamp: new Date().toISOString()
    };
    sendDiscordWebhook(DISCORD_WEBHOOK_LOGS, null, embed);
}

function discordLogChatMessage(username, message) {
    const content = `**${username}:** ${message}`;
    sendDiscordWebhook(DISCORD_WEBHOOK_CHAT, content);
}

// Pfade für Dateien
const WHITELIST_PATH = path.join(__dirname, 'whitelist.txt');

// Whitelist und Code-Tracking
let whitelist = new Set();
let codeUsage = {}; // { "CODE": ["username1", "username2"] }

// Whitelist laden
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
            
            console.log(`✅ Whitelist geladen: ${whitelist.size} Codes`);
        } else {
            console.log('⚠️  whitelist.txt nicht gefunden, erstelle leere Datei');
            fs.writeFileSync(WHITELIST_PATH, '# Codes hier eintragen (9-stellig)\n# Beispiel: A3K9X7M2B # für Player1\n');
        }
    } catch (error) {
        console.error('❌ Fehler beim Laden der Whitelist:', error);
    }
}

// Code tracken (nur im Memory)
function trackCodeUsage(code, username) {
    const upperCode = code.toUpperCase();
    
    if (!codeUsage[upperCode]) {
        codeUsage[upperCode] = [];
    }
    
    if (!codeUsage[upperCode].includes(username)) {
        codeUsage[upperCode].push(username);
        console.log(`📊 Code ${upperCode} wird nun auch von "${username}" verwendet`);
    }
}

// Code validieren
function isValidCode(code) {
    return whitelist.has(code.toUpperCase());
}

// Initial laden
loadWhitelist();

// Whitelist neu laden (manueller Trigger via Endpoint)
app.get('/reload-whitelist', (req, res) => {
    loadWhitelist();
    res.json({ 
        success: true, 
        message: 'Whitelist neu geladen',
        totalCodes: whitelist.size 
    });
});

// Code-Usage Endpoint (für Übersicht)
app.get('/admin/code-usage', (req, res) => {
    res.json({
        success: true,
        timestamp: new Date().toISOString(),
        codeUsage: codeUsage,
        totalCodes: Object.keys(codeUsage).length,
        totalUsers: Object.values(codeUsage).flat().length
    });
});

// Gesundheitscheck-Endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'Server läuft', 
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

// Speichere verbundene Clients
const clients = new Map();
const messageHistory = [];
const MAX_HISTORY = 50;

// Socket.io Verbindungshandling
io.on('connection', (socket) => {
    console.log('🔌 Neuer Client verbunden:', socket.id);
    
    // Client speichern (unverified)
    clients.set(socket.id, {
        id: socket.id,
        username: null,
        verified: false,
        code: null,
        connectedAt: new Date()
    });
    
    // Fordere Verifizierung an
    socket.emit('verifyRequired', {
        message: 'Bitte verifiziere dich mit /verify CODE'
    });
    
    // Code-Verifizierung
    socket.on('verifyCode', (data) => {
        const { code, username } = data;
        const client = clients.get(socket.id);
        
        if (!client) return;
        
        console.log(`🔐 Verify-Versuch von ${socket.id} (${username}): ${code}`);
        
        if (isValidCode(code)) {
            // Code ist gültig
            client.verified = true;
            client.code = code.toUpperCase();
            client.username = username;
            
            // Code-Usage tracken
            trackCodeUsage(code, username);
            
            console.log(`✅ ${username} erfolgreich verifiziert mit Code ${code.toUpperCase()}`);
            
            // Discord Log: Erfolgreiche Verifizierung
            discordLogSuccess(username, code.toUpperCase());
            
            // Erfolg an Client senden
            socket.emit('verifySuccess', {
                message: 'Verifizierung erfolgreich! Willkommen im Chat.'
            });
            
            // Jetzt Chat-Historie senden
            socket.emit('welcome', {
                history: messageHistory,
                onlineUsers: Array.from(clients.values())
                    .filter(c => c.verified && c.username)
                    .map(c => c.username)
            });
            
            // Discord Log: User Connected
            discordLogConnect(username, code.toUpperCase());
            
            // Anderen Usern mitteilen
            socket.broadcast.emit('userJoined', {
                username: username,
                message: `${username} ist dem Chat beigetreten`,
                timestamp: new Date().toISOString()
            });
            
        } else {
            // Code ist ungültig
            console.log(`❌ Ungültiger Code von ${username}: ${code}`);
            
            // Discord Log: Fehlgeschlagene Verifizierung
            discordLogFailed(username, code);
            
            socket.emit('verifyFailed', {
                message: 'Code ungültig, versuche es erneut'
            });
        }
    });
    
    // Username setzen (nur für verifizierte User)
    socket.on('setUsername', (username) => {
        const client = clients.get(socket.id);
        if (client && client.verified) {
            client.username = username;
            console.log(`👤 Username aktualisiert für ${socket.id}: ${username}`);
        }
    });
    
    // Nachricht empfangen (nur von verifizierten Usern)
    socket.on('chatMessage', (data) => {
        const client = clients.get(socket.id);
        
        if (!client || !client.verified || !client.username) {
            socket.emit('verifyRequired', {
                message: 'Du musst verifiziert sein um Nachrichten zu senden'
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
        
        // Zur Historie hinzufügen
        messageHistory.push(message);
        if (messageHistory.length > MAX_HISTORY) {
            messageHistory.shift();
        }
        
        // An alle VERIFIZIERTEN Clients senden
        io.emit('newMessage', message);
        
        console.log(`💬 ${message.username}: ${message.message}`);
        
        // Discord Log: Chat-Nachricht
        discordLogChatMessage(message.username, message.message);
    });
    
    // Client-Liste anfordern
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
    
    // Verbindung getrennt
    socket.on('disconnect', () => {
        const client = clients.get(socket.id);
        if (client && client.verified && client.username) {
            console.log(`🔌 Client getrennt: ${client.username} (Code: ${client.code})`);
            
            // Discord Log: User Disconnected
            discordLogDisconnect(client.username, client.code);
            
            // Broadcast: Spieler hat verlassen
            socket.broadcast.emit('userLeft', {
                username: client.username,
                message: `${client.username} hat den Chat verlassen`,
                timestamp: new Date().toISOString()
            });
        } else {
            console.log(`🔌 Nicht-verifizierter Client getrennt: ${socket.id}`);
        }
        
        clients.delete(socket.id);
    });
    
    // Ping/Pong für Verbindungscheck
    socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
    });
});

// Server starten
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server läuft auf Port ${PORT}`);
    console.log(`📋 Whitelist: ${whitelist.size} Codes geladen`);
    console.log(`📊 Code-Usage Tracking: Aktiv`);
    console.log(`🔔 Discord Webhooks: ${DISCORD_WEBHOOK_LOGS ? '✅' : '❌'} Logs | ${DISCORD_WEBHOOK_CHAT ? '✅' : '❌'} Chat`);
});
