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

// ===== MongoDB =====
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB Connected");

    // 🔥 Reset all users offline on startup (prevents stuck users)
    await User.updateMany({}, { online: false });
    console.log("All users set to offline");
  })
  .catch(err => console.error("MongoDB Connection Error:", err));

// ===== Schemas =====
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

// ===== helper =====
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

// ===== LOGIN ROUTE =====
app.post("/login", async (req, res) => {
  try {
    const password = req.body.password;

    if (!password) return res.status(400).send("Missing password");

    const match = await bcrypt.compare(password, ADMIN_HASH);

    if (match) {
      res.send("ok");
    } else {
      res.status(401).send("nope");
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("server error");
  }
});

// ===== WebSocket =====
wss.on("connection", (ws, req) => {
  console.log("User connected");

  ws.isAuthed = false;
  ws.username = null;

  const ip =
    (req.headers["x-forwarded-for"]?.split(",")[0]) ||
    req.socket.remoteAddress ||
    "unknown";

  ws.ip = ip;

  ws.on("message", async (data) => {
    try {
      const parsed = JSON.parse(data);

      // ===== AUTH =====
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

        if (!user) {
          try {
            user = new User({ username, online: true });
            await user.save();
          } catch (err) {
            ws.send(JSON.stringify({ type: "username_taken" }));
            return;
          }
        } else {
          if (user.online) {
            ws.send(JSON.stringify({ type: "username_taken" }));
            return;
          }

          user.online = true;
          user.lastSeen = new Date();
          await user.save();
        }

        ws.username = username;
        ws.isAuthed = true;

        ws.send(JSON.stringify({ type: "auth_success" }));
        return;
      }

      if (parsed.type === "auth") {
  console.log("INPUT PASSWORD:", parsed.password);
  console.log("HASH FROM ENV:", ADMIN_HASH);

  const match = await bcrypt.compare(parsed.password, ADMIN_HASH);

  console.log("MATCH RESULT:", match);

  if (!match) {
    ws.send(JSON.stringify({ type: "auth_failed" }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: "auth_success" }));
  return;
}

      // ===== BLOCK IF NOT AUTHED =====
      if (!ws.isAuthed) {
        ws.send(JSON.stringify({ type: "auth_failed" }));
        ws.close();
        return;
      }

      // ===== HISTORY =====
      if (parsed.type === "get_history") {
        const messages = await Message.find({ channel: parsed.channel })
          .sort({ createdAt: 1 })
          .limit(50);

        ws.send(JSON.stringify({
          type: "history",
          channel: parsed.channel,
          messages: messages.map(safeMessage)
        }));
      }

      // ===== MESSAGE =====
      if (parsed.type === "message") {
        const newMessage = new Message({
          username: ws.username,
          message: parsed.message,
          channel: parsed.channel,
          ip: ws.ip
        });

        await newMessage.save();

        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.isAuthed) {
            client.send(JSON.stringify({
              type: "message",
              ...safeMessage(newMessage)
            }));
          }
        });
      }

      // ===== USERNAME CHANGE =====
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

        // set old offline
        await User.updateOne(
          { username: ws.username },
          { online: false }
        );

        let user = await User.findOne({ username: newName });

        if (!user) {
          user = new User({ username: newName, online: true });
          await user.save();
        } else {
          user.online = true;
          await user.save();
        }

        ws.username = newName;

        ws.send(JSON.stringify({
          type: "username_changed",
          username: newName
        }));
      }

    } catch (err) {
      console.error("WebSocket error:", err);
    }
  });

  // ===== DISCONNECT =====
  ws.on("close", async () => {
    if (ws.username) {
      await User.updateOne(
        { username: ws.username },
        { online: false, lastSeen: new Date() }
      );

      console.log(`User disconnected: ${ws.username}`);
    }
  });
});

// ===== ROUTE =====
app.get("/", (req, res) => {
  res.send("WebSocket Chat Server Running");
});

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
