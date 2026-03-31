const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

require("dotenv").config();

// password system

const PASSWORD = process.env.ADMIN_PASSWORD;

app.post("/login", (req, res) => {
  if (req.body.password === PASSWORD) {
    res.send("ok");
  } else {
    res.send("nope");
  }
});

const bcrypt = require("bcrypt");

const hash = process.env.ADMIN_PASSWORD_HASH;

if (await bcrypt.compare(req.body.password, hash)) {
  res.send("ok");
}

// ===== MongoDB =====
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error("MongoDB Connection Error:", err));

// ===== Schema =====
const messageSchema = new mongoose.Schema({
  username: String,
  message: String,
  channel: String,
  ip: String,
  type: { type: String, default: "message" },
  createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model("Message", messageSchema);

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

// ===== WebSocket =====
wss.on("connection", (ws, req) => {
    console.log("User connected");

    ws.isAuthed = false;

    const ip =
        (req.headers["x-forwarded-for"] &&
            req.headers["x-forwarded-for"].split(",")[0]) ||
        req.socket.remoteAddress ||
        "unknown";

    ws.ip = ip;

    console.log("User connected IP:", ip);

    ws.on("message", async (data) => {
        try {
            const parsed = JSON.parse(data);

            // ================= AUTH =================
            if (parsed.type === "auth") {
                if (parsed.password === WS_PASSWORD) {
                    ws.isAuthed = true;

                    ws.send(JSON.stringify({ type: "auth_success" }));
                } else {
                    ws.send(JSON.stringify({ type: "auth_failed" }));
                    ws.close();
                }
                return;
            }

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
            }

            // ================= MESSAGE =================
            if (parsed.type === "message") {
                const newMessage = new Message({
                    username: parsed.username,
                    message: parsed.message,
                    channel: parsed.channel,
                    ip: ws.ip
                });

                await newMessage.save();

                console.log("Saved message from IP:", ws.ip);

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.isAuthed) {
                        client.send(JSON.stringify({
                            type: "message",
                            ...safeMessage(newMessage)
                        }));
                    }
                });
            }

            // ================= USERNAME CHANGE =================
            if (parsed.type === "username_change") {
                const sysMessage = new Message({
                    username: parsed.username,
                    message: parsed.message,
                    channel: parsed.channel,
                    type: "username_change"
                });

                await sysMessage.save();

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.isAuthed) {
                        client.send(JSON.stringify({
                            type: "username_change",
                            ...safeMessage(sysMessage)
                        }));
                    }
                });
            }

        } catch (err) {
            console.error("WebSocket error:", err);
        }
    });
});

// ===== ROUTE (OUTSIDE websocket) =====
app.get("/", (req, res) => {
    res.send("WebSocket Chat Server Running");
});

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
