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
    
    // Generiere zufälligen Benutzernamen
    const username = `Player_${Math.floor(Math.random() * 10000)}`;
    
    // Client speichern
    clients.set(socket.id, {
        id: socket.id,
        username: username,
        connectedAt: new Date()
    });
    
    // Sende Willkommensnachricht und Historie
    socket.emit('welcome', {
        username: username,
        history: messageHistory,
        onlineUsers: Array.from(clients.values()).map(c => c.username)
    });
    
    // Broadcast an alle: Neuer Spieler
    socket.broadcast.emit('userJoined', {
        username: username,
        message: `${username} ist dem Chat beigetreten`,
        timestamp: new Date().toISOString()
    });
    
    // Nachricht empfangen und weiterleiten
    socket.on('chatMessage', (data) => {
        const client = clients.get(socket.id);
        if (!client) return;
        
        const message = {
            id: Date.now() + Math.random(),
            username: data.username || client.username,
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
    
    // Benutzername ändern
    socket.on('changeUsername', (newUsername) => {
        const client = clients.get(socket.id);
        if (!client) return;
        
        const oldUsername = client.username;
        client.username = newUsername;
        
        // Informiere alle über Namensänderung
        io.emit('usernameChanged', {
            oldUsername: oldUsername,
            newUsername: newUsername,
            message: `${oldUsername} heißt jetzt ${newUsername}`,
            timestamp: new Date().toISOString()
        });
    });
    
    // Client-Liste anfordern
    socket.on('requestUserList', () => {
        socket.emit('userList', {
            users: Array.from(clients.values()).map(c => ({
                username: c.username,
                connectedAt: c.connectedAt
            }))
        });
    });
    
    // Verbindung getrennt
    socket.on('disconnect', () => {
        const client = clients.get(socket.id);
        if (client) {
            console.log('Client getrennt:', client.username);
            
            // Broadcast: Spieler hat verlassen
            socket.broadcast.emit('userLeft', {
                username: client.username,
                message: `${client.username} hat den Chat verlassen`,
                timestamp: new Date().toISOString()
            });
            
            clients.delete(socket.id);
        }
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
