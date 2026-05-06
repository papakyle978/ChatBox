const express = require("express"); const http = require("http"); const WebSocket = require("ws"); const mongoose = require("mongoose"); const cors = require("cors"); const bcrypt = require("bcryptjs"); require("dotenv").config();

const app = express(); app.use(cors()); app.use(express.json());

const server = http.createServer(app); const wss = new WebSocket.Server({ server });

// ===== ENV ===== 
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH; if (!ADMIN_HASH) { console.error("❌ ADMIN_PASSWORD_HASH missing!"); }

// ===== MODELS ===== 
const MessageSchema = new mongoose.Schema({ username: String, message: String, channel: String, ip: String, type: { type: String, default: "message" }, createdAt: { type: Date, default: Date.now } });

MessageSchema.index({ channel: 1, createdAt: 1 });

const Message = mongoose.model("Message", MessageSchema);

const UserSchema = new mongoose.Schema({ username: { type: String, unique: true }, online: { type: Boolean, default: false }, lastSeen: { type: Date, default: Date.now } });

const User = mongoose.model("User", UserSchema);

// ===== CONNECT ===== 
mongoose .connect(process.env.MONGO_URI) .then(async () => { console.log("MongoDB Connected"); await User.updateMany({}, { online: false }); }) .catch(err => console.error("MongoDB connection error:", err));

// ===== HELPERS =====

const badWords = [
  "asshole",
  "nigga",
  "shit",
  "fuck",
  "bitch",
  "nigger",
  "bastard"
];

function containsProfanity(text) {
  const lower = text.toLowerCase();
  return badWords.some(word => lower.includes(word));
}

function cleanMessage(text) {
  let cleaned = text;

  badWords.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    cleaned = cleaned.replace(regex, "****");
  });

  return cleaned;
}

function getDMChannel(a, b) { return "dm:" + [a, b].sort().join(":"); }

function safeMessage(m) { return { id: String(m._id), username: m.username, message: m.message, channel: m.channel, type: m.type, createdAt: m.createdAt }; }

function sendToClient(ws, payload) { if (ws.readyState !== WebSocket.OPEN) return; ws.send(JSON.stringify(payload)); }

function broadcast(type, payload) { const message = JSON.stringify({ type, ...payload });

wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN && client.isAuthed) { client.send(message); } }); }

function broadcastSystem(message, channel = "general1") { broadcast("system", { message, channel }); }

function broadcastOnline() { const users = []; const seen = new Set();

wss.clients.forEach(client => { if ( client.readyState === WebSocket.OPEN && client.isAuthed && client.username && !seen.has(client.username) ) { seen.add(client.username); users.push(client.username); } });

broadcast("online_users", { users }); }

function normalizeUsername(value) { return String(value || "").trim(); }

function normalizeChannel(value) { return String(value || "general1").trim() || "general1"; }

function normalizeMessage(value) { return String(value || "").trim(); }

// ===== WS ===== 
wss.on("connection", (ws, req) => { ws.isAuthed = false; ws.username = null; ws.lastDM = 0; ws.ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

ws.on("message", async raw => { let data;

try {
  data = JSON.parse(raw);
} catch {
  return;
}

try {
  // ===== AUTH =====
  if (data.type === "auth") {
    if (!ADMIN_HASH) {
      sendToClient(ws, { type: "auth_failed" });
      ws.close();
      return;
    }

    const password = String(data.password || "");
    const username = normalizeUsername(data.username);

    if (!username) {
      sendToClient(ws, { type: "auth_failed" });
      ws.close();
      return;
    }

    const ok = await bcrypt.compare(password, ADMIN_HASH);

    if (!ok) {
      sendToClient(ws, { type: "auth_failed" });
      ws.close();
      return;
    }

    const existingUser = await User.findOne({ username }).lean();
    const wasOnline = Boolean(existingUser?.online);

    ws.username = username;
    ws.isAuthed = true;

    await User.updateOne(
      { username },
      { username, online: true, lastSeen: new Date() },
      { upsert: true }
    );

    sendToClient(ws, { type: "auth_success" });

    if (!wasOnline) {
      broadcastSystem(`${username} joined the chat`);
    }

    broadcastOnline();
    return;
  }

  if (!ws.isAuthed) return;

  // ===== HISTORY =====
  if (data.type === "get_history") {
    const channel = normalizeChannel(data.channel);

    const messages = await Message.find({ channel })
      .sort({ createdAt: 1 })
      .limit(100)
      .lean();

    sendToClient(ws, {
      type: "history",
      channel,
      messages: messages.map(safeMessage)
    });
    return;
  }

  // ===== MESSAGE =====
if (data.type === "message") {
  const channel = normalizeChannel(data.channel);
  const text = normalizeMessage(data.message);

  if (!text || text.length > 500) return;

  // ===== PROFANITY CHECK =====
  if (containsProfanity(text)) {
    sendToClient(ws, {
      type: "system",
      message: "⚠️ Your message contains blocked language.",
      channel
    });
    return;
  }

  const msg = await Message.create({
    username: ws.username,
    message: cleanMessage(text), // optional censoring instead of raw text
    channel,
    ip: ws.ip
  });

  broadcast("message", safeMessage(msg));
  return;
}

  // ===== USERNAME CHANGE =====
  if (data.type === "username_change") {
    const oldName = ws.username;
    const newName = normalizeUsername(data.newName);

    if (!newName || newName === oldName) return;

    const exists = await User.findOne({ username: newName }).lean();

    if (exists && exists.online && exists.username !== oldName) {
      sendToClient(ws, { type: "username_taken" });
      return;
    }

    await User.updateOne({ username: oldName }, { online: false });

    await User.updateOne(
      { username: newName },
      { username: newName, online: true, lastSeen: new Date() },
      { upsert: true }
    );

    ws.username = newName;

    sendToClient(ws, {
      type: "username_changed",
      oldName,
      newName
    });

    broadcastSystem(`${oldName} is now ${newName}`);
    broadcastOnline();
    return;
  }

  // ===== DM REQUEST =====
  if (data.type === "dm_request") {
    const now = Date.now();
    if (now - ws.lastDM < 2000) return;
    ws.lastDM = now;

    const target = normalizeUsername(data.to);
    if (!target || target === ws.username) return;

    const channel = getDMChannel(ws.username, target);

    wss.clients.forEach(client => {
      if (
        client.readyState === WebSocket.OPEN &&
        client.isAuthed &&
        client.username === target
      ) {
        sendToClient(client, {
          type: "dm_request",
          from: ws.username,
          channel
        });
      }
    });

    return;
  }
} catch (err) {
  console.error("WebSocket message error:", err);
}
});

// ===== DISCONNECT =====
ws.on("close", async () => { if (!ws.username) return;

try {
  const stillOnlineSomewhereElse = [...wss.clients].some(client => {
    return (
      client !== ws &&
      client.readyState === WebSocket.OPEN &&
      client.isAuthed &&
      client.username === ws.username
    );
  });

  if (!stillOnlineSomewhereElse) {
    await User.updateOne(
      { username: ws.username },
      { online: false, lastSeen: new Date() }
    );

    broadcastSystem(`${ws.username} left the chat`);
  }

  broadcastOnline();
} catch (err) {
  console.error("Close handler error:", err);
}
}); });

// ===== ROUTE ===== 
app.get("/", (req, res) => { res.send("Chat Server Running"); });

// ===== START ===== 
const PORT = process.env.PORT || 3000; server.listen(PORT, () => { console.log("Server running on port", PORT); });
