const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ================= ENV =================
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!ADMIN_HASH) {
  console.error("❌ ADMIN_PASSWORD_HASH missing!");
}

// ================= MODELS =================
const messageSchema = new mongoose.Schema({
  username: String,
  message: String,
  channel: String,
  ip: String,
  type: { type: String, default: "message" },
  createdAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  online: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now }
});

const Message = mongoose.model("Message", messageSchema);
const User = mongoose.model("User", userSchema);

// ================= MONGO =================
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB Connected");
    await User.updateMany({}, { online: false });
  })
  .catch(err => console.error(err));

// ================= HELPERS =================
function safeMessage(m) {
  return {
    id: m._id,
    username: m.username,
    message: m.message,
    channel: m.channel,
    type: m.type,
    createdAt: m.createdAt
  };
}

function broadcastOnlineUsers() {
  const users = [];

  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.username) {
      users.push(c.username);
    }
  });

  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify({
        type: "online_users",
        users
      }));
    }
  });
}

function broadcastSystem(message, channel = "general") {
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify({
        type: "system",
        message,
        channel
      }));
    }
  });
}

// ================= LOGIN ROUTE =================
app.post("/login", async (req, res) => {
  try {
    const match = await bcrypt.compare(req.body.password, ADMIN_HASH);
    if (match) return res.send("ok");
    res.status(401).send("nope");
  } catch {
    res.status(500).send("error");
  }
});

// ================= WS =================
wss.on("connection", (ws, req) => {
  ws.username = null;
  ws.isAuthed = false;

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    "unknown";

  ws.ip = ip;

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // ================= AUTH =================
    if (data.type === "auth") {
      const ok = await bcrypt.compare(data.password, ADMIN_HASH);

      if (!ok) {
        ws.send(JSON.stringify({ type: "auth_failed" }));
        ws.close();
        return;
      }

      const username = (data.username || "").trim();
      if (!username) return;

      ws.username = username;
      ws.isAuthed = true;

      await User.updateOne(
        { username },
        { username, online: true, lastSeen: new Date() },
        { upsert: true }
      );

      ws.send(JSON.stringify({ type: "auth_success" }));

      broadcastSystem(`${username} joined the chat`, "general");
      broadcastOnlineUsers();
      return;
    }

    // ================= BLOCK UNAUTH =================
    if (!ws.isAuthed) {
      ws.send(JSON.stringify({ type: "auth_failed" }));
      ws.close();
      return;
    }

    // ================= HISTORY =================
    if (data.type === "get_history") {
      const channel = data.channel || "general";

      const messages = await Message.find({ channel })
        .sort({ createdAt: 1 })
        .limit(100);

      ws.send(JSON.stringify({
        type: "history",
        channel,
        messages: messages.map(safeMessage)
      }));

      return;
    }

    // ================= MESSAGE =================
    if (data.type === "message") {
      const channel = data.channel || "general";

      const msg = await Message.create({
        username: ws.username,
        message: data.message,
        channel,
        ip: ws.ip
      });

      const payload = safeMessage(msg);

      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN && c.isAuthed) {
          c.send(JSON.stringify({
            type: "message",
            ...payload
          }));
        }
      });

      return;
    }

    // ================= USERNAME CHANGE =================
    if (data.type === "username_change") {
      const oldName = ws.username;
      const newName = (data.username || data.newName || "").trim();

      if (!newName || newName === oldName) return;

      const exists = await User.findOne({ username: newName });

      if (exists && exists.online) {
        ws.send(JSON.stringify({ type: "username_taken" }));
        return;
      }

      await User.updateOne(
        { username: oldName },
        { online: false }
      );

      ws.username = newName;

      await User.updateOne(
        { username: newName },
        { username: newName, online: true, lastSeen: new Date() },
        { upsert: true }
      );

      ws.send(JSON.stringify({
        type: "username_changed",
        oldName,
        newName
      }));

      broadcastSystem(`${oldName} is now ${newName}`, "general");
      broadcastOnlineUsers();

      return;
    }
  });

  // ================= DISCONNECT =================
  ws.on("close", async () => {
    if (!ws.username) return;

    await User.updateOne(
      { username: ws.username },
      { online: false, lastSeen: new Date() }
    );

    broadcastSystem(`${ws.username} left the chat`, "general");
    broadcastOnlineUsers();
  });
});

// ================= ROUTE =================
app.get("/", (req, res) => {
  res.send("Chat Server Running");
});

// ================= START =================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
