const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS konfigurieren für Socket.io
const io = socketIO(server, {
    cors: {
        origin: "*", // Erlaubt alle Origins (für Entwicklung)
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Express CORS Middleware
app.use(cors());
app.use(express.json());

// Gesundheitscheck-Endpoint für Render
app.get('/', (req, res) => {
    res.json({ 
        status: 'Server läuft', 
        time: new Date().toISOString(),
        connectedClients: clients.size 
    });
});

// Speichere verbundene Clients
const clients = new Map();
const messageHistory = []; // Letzte 50 Nachrichten speichern
const MAX_HISTORY = 50;

// Socket.io Verbindungshandling
io.on('connection', (socket) => {
    console.log('Neuer Client verbunden:', socket.id);
    
    // Client speichern (ohne Username, wird später gesetzt)
    clients.set(socket.id, {
        id: socket.id,
        username: null,
        connectedAt: new Date()
    });
    
    // Username vom Client empfangen
    socket.on('setUsername', (username) => {
        const client = clients.get(socket.id);
        if (client) {
            client.username = username;
            console.log(`Username gesetzt für ${socket.id}: ${username}`);
            
            // Sende Willkommensnachricht und Historie
            socket.emit('welcome', {
                history: messageHistory,
                onlineUsers: Array.from(clients.values()).filter(c => c.username).map(c => c.username)
            });
            
            // Broadcast an alle: Neuer Spieler
            socket.broadcast.emit('userJoined', {
                username: username,
                message: `${username} ist dem Chat beigetreten`,
                timestamp: new Date().toISOString()
            });
        }
    });
    
    // Nachricht empfangen und weiterleiten
    socket.on('chatMessage', (data) => {
        const client = clients.get(socket.id);
        if (!client || !client.username) return;
        
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
        
        // An alle Clients senden (inklusive Sender)
        io.emit('newMessage', message);
        
        console.log(`Nachricht von ${message.username}: ${message.message}`);
    });
    
    // Client-Liste anfordern
    socket.on('requestUserList', () => {
        socket.emit('userList', {
            users: Array.from(clients.values())
                .filter(c => c.username)
                .map(c => ({
                    username: c.username,
                    connectedAt: c.connectedAt
                }))
        });
    });
    
    // Verbindung getrennt
    socket.on('disconnect', () => {
        const client = clients.get(socket.id);
        if (client && client.username) {
            console.log('Client getrennt:', client.username);
            
            // Broadcast: Spieler hat verlassen
            socket.broadcast.emit('userLeft', {
                username: client.username,
                message: `${client.username} hat den Chat verlassen`,
                timestamp: new Date().toISOString()
            });
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
    console.log(`Server läuft auf Port ${PORT}`);
});
