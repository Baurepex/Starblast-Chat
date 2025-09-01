import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";

const app = express();
app.use(helmet({
  contentSecurityPolicy: false
}));

// Passe die Origins an DEINE echten Domains an (Render-URL + starblast.io).
const allowed = new Set([
  "https://starblast.io",
  "https://www.starblast.io",
  // z.B. deine Vorschau-Seite:
  // "https://dein-test-host.example"
]);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // erlaubt z.B. curl
    if (allowed.has(origin)) return cb(null, true);
    return cb(new Error("CORS not allowed"), false);
  }
}));

app.get("/", (_req, res) => {
  res.status(200).send("Starblast Chat Relay OK");
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowed.has(origin)) return cb(null, true);
      return cb(new Error("CORS not allowed"), false);
    }
  },
  transports: ["websocket"], // nur WS
  pingInterval: 15000,
  pingTimeout: 20000
});

// ===== Utilities =====
const sanitize = (s, max = 300) =>
  String(s ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")  // Control chars
    .slice(0, max);

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Token-Bucket Rate Limiter je Socket
function makeBucket({ capacity = 6, refillPerSec = 1 }) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    tokens = Math.min(capacity, tokens + dt * refillPerSec);
    if (tokens >= 1) {
      tokens -= 1;
      return true;
    }
    return false;
  };
}

// User- & Room-Tracking
const users = new Map(); // socket.id -> { name, room, bucket }
const nameIndex = new Map(); // lower(name) -> socket.id

function uniqueName(requested) {
  let base = requested || "Player";
  base = sanitize(base, 20).trim() || "Player";
  let candidate = base;
  let n = 1;
  while (nameIndex.has(candidate.toLowerCase())) {
    n += 1;
    candidate = `${base}#${n}`;
  }
  return candidate;
}

io.on("connection", (socket) => {
  const bucket = makeBucket({ capacity: 6, refillPerSec: 1.5 });
  // default identity
  let name = uniqueName("Player");
  let room = "global";

  users.set(socket.id, { name, room, bucket });
  nameIndex.set(name.toLowerCase(), socket.id);
  socket.join(room);

  socket.emit("system", { message: `Verbunden als ${name} im Raum ${room}.` });
  socket.to(room).emit("user_joined", { name });

  // helper
  function rename(newName) {
    newName = sanitize(newName, 20).trim();
    if (!newName) return socket.emit("error", { message: "Ungültiger Name." });
    if (nameIndex.has(newName.toLowerCase())) {
      newName = uniqueName(newName);
    }
    nameIndex.delete(name.toLowerCase());
    name = newName;
    nameIndex.set(name.toLowerCase(), socket.id);
    users.get(socket.id).name = name;
    socket.emit("system", { message: `Neuer Name: ${name}` });
  }

  function joinRoom(newRoom) {
    newRoom = sanitize(newRoom, 24).trim() || "global";
    if (newRoom === room) return;
    socket.leave(room);
    socket.to(room).emit("user_left", { name });
    room = newRoom;
    users.get(socket.id).room = room;
    socket.join(room);
    socket.emit("system", { message: `Beigetreten: ${room}` });
    socket.to(room).emit("user_joined", { name });
  }

  // === Events from client ===

  socket.on("set_name", ({ name: reqName }) => {
    if (!bucket()) return socket.emit("error", { message: "Zu schnell." });
    rename(reqName);
  });

  socket.on("join_room", ({ room: reqRoom }) => {
    if (!bucket()) return socket.emit("error", { message: "Zu schnell." });
    joinRoom(reqRoom);
  });

  socket.on("chat_message", ({ text }) => {
    if (!bucket()) return socket.emit("error", { message: "Zu schnell." });
    const msg = sanitize(text, 300);
    if (!msg) return;
    const safe = escapeHtml(msg);
    io.to(room).emit("chat_message", { name, room, text: safe, ts: Date.now() });
  });

  socket.on("private_message", ({ to, text }) => {
    if (!bucket()) return socket.emit("error", { message: "Zu schnell." });
    const msg = sanitize(text, 300);
    const targetId = nameIndex.get(String(to || "").toLowerCase());
    if (!targetId) return socket.emit("error", { message: `User ${to} nicht gefunden.` });
    const safe = escapeHtml(msg);
    io.to(targetId).emit("private_message", { from: name, text: safe, ts: Date.now() });
    socket.emit("private_message", { from: `You → ${to}`, text: safe, ts: Date.now() });
  });

  socket.on("disconnect", () => {
    socket.to(room).emit("user_left", { name });
    nameIndex.delete(name.toLowerCase());
    users.delete(socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Chat relay listening on :${PORT}`);
});
