// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===== MongoDB Connection =====
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch(err => console.error("MongoDB Connection Error:", err));

// ===== Message Schema =====
const messageSchema = new mongoose.Schema({
  username: String,
  message: String,
  channel: String,
  type: { type: String, default: "message" },
  createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model("Message", messageSchema);

wss.on("connection", (ws) => {
    console.log("User connected");

    ws.on("message", async (data) => {
        try {
          if (parsed.type === "auth") {
    if (parsed.password === process.env.WS_PASSWORD) {
        ws.isAuthed = true;

        ws.send(JSON.stringify({
            type: "auth_success"
        }));
    } else {
        ws.send(JSON.stringify({
            type: "auth_failed"
        }));
        ws.close();
    }
    return;
}

          if (!ws.isAuthed) {
    ws.send(JSON.stringify({ type: "auth_failed" }));
    ws.close();
    return;
}
            const parsed = JSON.parse(data);

            // =========================
            // LOAD HISTORY (per channel)
            // =========================
            if (parsed.type === "get_history") {
                const messages = await Message.find({ channel: parsed.channel })
                    .sort({ createdAt: 1 })
                    .limit(50);

                ws.send(JSON.stringify({
                    type: "history",
                    channel: parsed.channel,    // <-- fixed: include channel
                    messages
                }));
            }

            // =========================
            // SEND NEW MESSAGE
            // =========================
            if (parsed.type === "message") {
                const newMessage = new Message({
                    username: parsed.username,
                    message: parsed.message,
                    channel: parsed.channel
                });

                await newMessage.save();

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: "message",
                            username: parsed.username,
                            message: parsed.message,
                            channel: parsed.channel,
                            id: newMessage._id       // <-- add id for deduplication
                        }));
                    }
                });
            }

            // =========================
            // USERNAME CHANGE
            // =========================
            if (parsed.type === "username_change") {
                const sysMessage = new Message({
                    username: parsed.username,
                    message: parsed.message,
                    channel: parsed.channel,
                    type: "username_change"
                });

                await sysMessage.save();

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: "username_change",
                            username: parsed.username,
                            message: parsed.message,
                            channel: parsed.channel,
                            id: sysMessage._id
                        }));
                    }
                });
            }

        } catch (err) {
            console.error("WebSocket error:", err);
        }
    });
});

// ===== Basic Test Route =====
app.get("/", (req, res) => {
  res.send("WebSocket Chat Server Running");
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
