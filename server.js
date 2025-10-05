const express = require('express');
const http = require('http');
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

// Pfade für Dateien
const WHITELIST_PATH = path.join(__dirname, 'whitelist.txt');
const CODE_USAGE_PATH = path.join(__dirname, 'code-usage.json');

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

// Code-Usage laden
function loadCodeUsage() {
    try {
        if (fs.existsSync(CODE_USAGE_PATH)) {
            const content = fs.readFileSync(CODE_USAGE_PATH, 'utf8');
            codeUsage = JSON.parse(content);
            console.log(`✅ Code-Usage geladen: ${Object.keys(codeUsage).length} Codes getrackt`);
        } else {
            codeUsage = {};
            saveCodeUsage();
        }
    } catch (error) {
        console.error('❌ Fehler beim Laden der Code-Usage:', error);
        codeUsage = {};
    }
}

// Code-Usage speichern
function saveCodeUsage() {
    try {
        fs.writeFileSync(CODE_USAGE_PATH, JSON.stringify(codeUsage, null, 2));
    } catch (error) {
        console.error('❌ Fehler beim Speichern der Code-Usage:', error);
    }
}

// Code tracken
function trackCodeUsage(code, username) {
    const upperCode = code.toUpperCase();
    
    if (!codeUsage[upperCode]) {
        codeUsage[upperCode] = [];
    }
    
    if (!codeUsage[upperCode].includes(username)) {
        codeUsage[upperCode].push(username);
        saveCodeUsage();
        console.log(`📊 Code ${upperCode} wird nun auch von "${username}" verwendet`);
    }
}

// Code validieren
function isValidCode(code) {
    return whitelist.has(code.toUpperCase());
}

// Initial laden
loadWhitelist();
loadCodeUsage();

// Whitelist neu laden (manueller Trigger via Endpoint)
app.get('/reload-whitelist', (req, res) => {
    loadWhitelist();
    res.json({ 
        success: true, 
        message: 'Whitelist neu geladen',
        totalCodes: whitelist.size 
    });
});

// Gesundheitscheck-Endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'Server läuft', 
        time: new Date().toISOString(),
        connectedClients: clients.size,
        whitelistedCodes: whitelist.size,
        trackedCodes: Object.keys(codeUsage).length
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
            
            // Anderen Usern mitteilen
            socket.broadcast.emit('userJoined', {
                username: username,
                message: `${username} ist dem Chat beigetreten`,
                timestamp: new Date().toISOString()
            });
            
        } else {
            // Code ist ungültig
            console.log(`❌ Ungültiger Code von ${username}: ${code}`);
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
    console.log(`📊 Code-Usage: ${Object.keys(codeUsage).length} Codes getrackt`);
});
