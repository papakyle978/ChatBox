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

// ===== ENV =====
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!ADMIN_HASH) {
  console.error("❌ ADMIN_PASSWORD_HASH missing!");
}

// ===== MONGO MODELS =====
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

// ===== MONGO CONNECT =====
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB Connected");
    await User.updateMany({}, { online: false });
    console.log("All users set offline");
  })
  .catch(err => console.error("MongoDB Error:", err));

// ===== HELPERS =====
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
    if (c.readyState === WebSocket.OPEN && c.isAuthed && c.username) {
      users.push(c.username);
    }
  });

  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.isAuthed) {
      c.send(JSON.stringify({
        type: "online_users",
        users
      }));
    }
  });
}

// ===== LOGIN ROUTE (optional REST auth) =====
app.post("/login", async (req, res) => {
  try {
    const match = await bcrypt.compare(req.body.password, ADMIN_HASH);
    if (match) return res.send("ok");
    res.status(401).send("nope");
  } catch {
    res.status(500).send("error");
  }
});

// ===== WEBSOCKET =====
wss.on("connection", (ws, req) => {
  ws.isAuthed = false;
  ws.username = null;

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    "unknown";

  ws.ip = ip;

  ws.on("message", async (data) => {
    try {
      const parsed = JSON.parse(data);

      // ================= AUTH =================
      if (parsed.type === "auth") {
        const match = await bcrypt.compare(parsed.password, ADMIN_HASH);

        if (!match) {
          ws.send(JSON.stringify({ type: "auth_failed" }));
          ws.close();
          return;
        }

        const username = parsed.username?.trim();
        if (!username) {
          ws.send(JSON.stringify({ type: "invalid_username" }));
          return;
        }

        let user = await User.findOne({ username });

        if (user && user.online) {
          ws.send(JSON.stringify({ type: "username_taken" }));
          return;
        }

        if (!user) {
          user = new User({ username, online: true });
        } else {
          user.online = true;
          user.lastSeen = new Date();
        }

        await user.save();

        ws.username = username;
        ws.isAuthed = true;

        ws.send(JSON.stringify({ type: "auth_success" }));

        // system join message
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN && c.isAuthed) {
            c.send(JSON.stringify({
              type: "system",
              message: `${username} joined the chat`,
              channel: "general"
            }));
          }
        });

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
      if (parsed.type === "get_history") {
        const messages = await Message.find({ channel: parsed.channel })
          .sort({ createdAt: 1 })
          .limit(50);

        ws.send(JSON.stringify({
          type: "history",
          channel: parsed.channel,
          messages: messages.map(safeMessage)
        }));
        return;
      }

      // ================= MESSAGE =================
      if (parsed.type === "message") {
        const msg = new Message({
          username: ws.username,
          message: parsed.message,
          channel: parsed.channel,
          ip: ws.ip
        });

        await msg.save();

        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN && c.isAuthed) {
            c.send(JSON.stringify({
              type: "message",
              ...safeMessage(msg)
            }));
          }
        });

        return;
      }

      // ================= USERNAME CHANGE =================
      if (parsed.type === "username_change") {
        const newName = parsed.username?.trim();

        if (!newName) {
          ws.send(JSON.stringify({ type: "invalid_username" }));
          return;
        }

        const existing = await User.findOne({ username: newName });

        if (existing && existing.online) {
          ws.send(JSON.stringify({ type: "username_taken" }));
          return;
        }

        await User.updateOne(
          { username: ws.username },
          { online: false }
        );

        let user = await User.findOne({ username: newName });

        if (!user) {
          user = new User({ username: newName, online: true });
        } else {
          user.online = true;
        }

        await user.save();

        ws.username = newName;
        ws.isAuthed = true;

        ws.send(JSON.stringify({
          type: "username_changed",
          username: newName
        }));

        broadcastOnlineUsers();
        return;
      }

    } catch (err) {
      console.error("WS Error:", err);
    }
  });

  // ================= DISCONNECT =================
  ws.on("close", async () => {
    if (ws.username) {
      await User.updateOne(
        { username: ws.username },
        { online: false, lastSeen: new Date() }
      );

      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN && c.isAuthed) {
          c.send(JSON.stringify({
            type: "system",
            message: `${ws.username} left the chat`,
            channel: "general"
          }));
        }
      });

      broadcastOnlineUsers();
    }
  });
});

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.send("WebSocket Chat Server Running");
});

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
