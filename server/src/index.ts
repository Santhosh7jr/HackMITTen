import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import fs from "fs";

import {
  pool,
  initDatabase,
  hashPassword,
  generateUserIdCode,
  STORAGE_DIR,
  CHAT_DIR,
  IMAGES_DIR,
  FILES_DIR,
  backupChatToFile,
} from "./db.js";

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// Serve uploaded files statically from storage/ folder
app.use("/storage", express.static(STORAGE_DIR));

// Multer Storage Configuration for Images and Files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, IMAGES_DIR);
    } else {
      cb(null, FILES_DIR);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
    const unique = `${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    cb(null, `${base}_${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max
});

// WebSocket tracking: userId -> Set of WebSockets
const userSockets = new Map<string, Set<WebSocket>>();

function isUserOnline(userId: string): boolean {
  const sockets = userSockets.get(userId);
  return Boolean(sockets && sockets.size > 0);
}

function broadcastToUser(userId: string, payload: any) {
  const sockets = userSockets.get(userId);
  if (sockets) {
    const data = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}

function broadcastGlobal(payload: any) {
  const data = JSON.stringify(payload);
  for (const sockets of userSockets.values()) {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}

// Helper: check if two users are friends in PostgreSQL
async function areFriends(userId1: string, userId2: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT id FROM friend_requests 
     WHERE status = 'accepted' 
       AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))`,
    [userId1, userId2]
  );
  return res.rows.length > 0;
}

// Helper: refresh JSON backup in storage/chat/
async function syncChatBackup(user1: string, user2: string) {
  try {
    const res = await pool.query(
      `SELECT id, sender_id AS "senderId", receiver_id AS "receiverId", content,
              message_type AS "messageType", file_url AS "fileUrl", file_name AS "fileName",
              file_size AS "fileSize", timestamp
       FROM messages
       WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
       ORDER BY timestamp ASC`,
      [user1, user2]
    );
    backupChatToFile(user1, user2, res.rows);
  } catch (err) {
    console.error("Error backing up chat:", err);
  }
}

// ---------------- REST API ROUTES ----------------

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", db: "PostgreSQL", timestamp: new Date().toISOString() });
});

// 1. Register: requires username, email (Gmail ID), password
app.post("/api/auth/register", async (req, res) => {
  const { username, email, password, fullName, avatar, bio } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: "Username, Gmail ID (email), and password are required." });
  }

  const cleanUsername = username.trim().toLowerCase();
  const cleanEmail = email.trim().toLowerCase();

  try {
    const existingUser = await pool.query(
      `SELECT id FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $2`,
      [cleanUsername, cleanEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: "Username or Gmail ID already registered." });
    }

    const newId = `u_${crypto.randomUUID().slice(0, 8)}`;
    const userIdCode = generateUserIdCode();
    const pHash = hashPassword(password);
    const name = fullName?.trim() || cleanUsername;
    const userAvatar =
      avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cleanUsername)}`;
    const userBio = bio?.trim() || "Hey there! I am using Chatvia.";

    const insertRes = await pool.query(
      `INSERT INTO users (id, user_id_code, username, email, full_name, password_hash, avatar, bio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id_code AS "userIdCode", username, email, full_name AS "fullName", avatar, bio`,
      [newId, userIdCode, cleanUsername, cleanEmail, name, pHash, userAvatar, userBio]
    );

    const user = insertRes.rows[0];

    broadcastGlobal({
      type: "user_registered",
      user: {
        id: user.id,
        userIdCode: user.userIdCode,
        username: user.username,
        fullName: user.fullName,
        avatar: user.avatar,
      },
    });

    return res.json({ user });
  } catch (err: any) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Registration failed on server." });
  }
});

// 2. Login: supports username, email (Gmail ID), and password
app.post("/api/auth/login", async (req, res) => {
  const { username, email, password } = req.body;
  if (!password || (!username && !email)) {
    return res.status(400).json({ error: "Username/Gmail ID and password are required." });
  }

  try {
    let query = `SELECT id, user_id_code AS "userIdCode", username, email, full_name AS "fullName", password_hash, avatar, bio FROM users WHERE `;
    const params: any[] = [];

    if (username && email) {
      query += `LOWER(username) = $1 AND LOWER(email) = $2`;
      params.push(username.trim().toLowerCase(), email.trim().toLowerCase());
    } else if (username) {
      query += `LOWER(username) = $1`;
      params.push(username.trim().toLowerCase());
    } else {
      query += `LOWER(email) = $1`;
      params.push(email.trim().toLowerCase());
    }

    const userRes = await pool.query(query, params);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username, Gmail ID, or password." });
    }

    const user = userRes.rows[0];
    if (user.password_hash !== hashPassword(password)) {
      return res.status(401).json({ error: "Invalid username, Gmail ID, or password." });
    }

    delete user.password_hash;
    return res.json({ user });
  } catch (err: any) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed on server." });
  }
});

// 3. User Profile: Get Profile
app.get("/api/users/profile/:id", async (req, res) => {
  try {
    const userRes = await pool.query(
      `SELECT id, user_id_code AS "userIdCode", username, email, full_name AS "fullName", avatar, bio, created_at AS "createdAt"
       FROM users WHERE id = $1`,
      [req.params.id]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ profile: userRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user profile." });
  }
});

// 4. User Profile: Update Profile (Full Name, Bio, Avatar)
app.put("/api/users/profile", async (req, res) => {
  const { userId, fullName, bio, avatar } = req.body;
  if (!userId) {
    return res.status(400).json({ error: "userId is required." });
  }

  try {
    const updateRes = await pool.query(
      `UPDATE users 
       SET full_name = COALESCE($1, full_name),
           bio = COALESCE($2, bio),
           avatar = COALESCE($3, avatar)
       WHERE id = $4
       RETURNING id, user_id_code AS "userIdCode", username, email, full_name AS "fullName", avatar, bio`,
      [fullName?.trim() || null, bio?.trim() || null, avatar || null, userId]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ user: updateRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed to update profile." });
  }
});

// 5. Lookup user by User ID Code ("do not show user name until they enter the user id")
app.get("/api/users/lookup", async (req, res) => {
  const { userIdCode, currentUserId } = req.query;
  if (!userIdCode) {
    return res.status(400).json({ error: "Please enter a User ID to search." });
  }

  const cleanCode = (userIdCode as string).trim().toUpperCase();

  try {
    const result = await pool.query(
      `SELECT id, user_id_code AS "userIdCode", username, full_name AS "fullName", avatar, bio 
       FROM users 
       WHERE UPPER(user_id_code) = $1 OR UPPER(username) = $1`,
      [cleanCode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `No user found with ID '${cleanCode}'.` });
    }

    const target = result.rows[0];

    // Check relationship if currentUserId provided
    let relationship = "none";
    if (currentUserId && currentUserId !== target.id) {
      const friendCheck = await pool.query(
        `SELECT status, sender_id FROM friend_requests
         WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)`,
        [currentUserId, target.id]
      );

      if (friendCheck.rows.length > 0) {
        const fr = friendCheck.rows[0];
        if (fr.status === "accepted") {
          relationship = "friends";
        } else if (fr.sender_id === currentUserId) {
          relationship = "pending_sent";
        } else {
          relationship = "pending_received";
        }
      }
    }

    res.json({
      user: {
        ...target,
        online: isUserOnline(target.id),
        relationship,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Error looking up user." });
  }
});

// 6. Send Friend Request (Supports User ID Code or Username)
app.post("/api/friends/request", async (req, res) => {
  const { senderId, targetIdCode } = req.body;
  if (!senderId || !targetIdCode || !targetIdCode.trim()) {
    return res.status(400).json({ error: "Sender ID and User ID / Username are required." });
  }

  const searchVal = targetIdCode.trim().toUpperCase();

  try {
    const targetRes = await pool.query(
      `SELECT id, user_id_code, username, full_name, avatar FROM users 
       WHERE UPPER(user_id_code) = $1 OR UPPER(username) = $1`,
      [searchVal]
    );

    if (targetRes.rows.length === 0) {
      return res.status(404).json({ error: `User with ID '${searchVal}' not found.` });
    }

    const target = targetRes.rows[0];
    if (target.id === senderId) {
      return res.status(400).json({ error: "You cannot send a friend request to yourself." });
    }

    // Check existing relationship
    const existingReq = await pool.query(
      `SELECT id, status, sender_id FROM friend_requests 
       WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)`,
      [senderId, target.id]
    );

    if (existingReq.rows.length > 0) {
      const fr = existingReq.rows[0];
      if (fr.status === "accepted") {
        return res.status(400).json({ error: `You and @${target.username} are already friends!` });
      }
      if (fr.sender_id === senderId) {
        return res.status(400).json({ error: `Friend request already sent to @${target.username} (Pending).` });
      } else {
        return res.status(400).json({
          error: `@${target.username} already sent you a friend request! Check your Pending Requests.`,
        });
      }
    }

    const newReqId = `fr_${crypto.randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO friend_requests (id, sender_id, receiver_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [newReqId, senderId, target.id]
    );

    const senderRes = await pool.query(
      `SELECT id, user_id_code, username, full_name, avatar FROM users WHERE id = $1`,
      [senderId]
    );
    const sender = senderRes.rows[0];

    // Real-time WebSocket event to receiver
    broadcastToUser(target.id, {
      type: "friend_request_received",
      request: {
        id: newReqId,
        sender: {
          id: sender.id,
          userIdCode: sender.user_id_code,
          username: sender.username,
          fullName: sender.full_name,
          avatar: sender.avatar,
        },
        createdAt: new Date().toISOString(),
      },
    });

    res.json({
      message: `Friend request sent to ${target.full_name} (@${target.username})!`,
      targetUser: target,
    });
  } catch (err: any) {
    console.error("Friend request error:", err);
    res.status(500).json({ error: "Failed to send friend request." });
  }
});

// 7. Accept or Reject Friend Request
app.post("/api/friends/respond", async (req, res) => {
  const { requestId, action, userId } = req.body;
  if (!requestId || !action || !userId) {
    return res.status(400).json({ error: "requestId, action ('accept'|'reject'), and userId are required." });
  }

  try {
    const frRes = await pool.query(
      `SELECT id, sender_id, receiver_id, status FROM friend_requests WHERE id = $1`,
      [requestId]
    );

    if (frRes.rows.length === 0) {
      return res.status(404).json({ error: "Friend request not found." });
    }

    const fr = frRes.rows[0];
    if (fr.receiver_id !== userId) {
      return res.status(403).json({ error: "Not authorized to respond to this request." });
    }

    if (action === "accept") {
      await pool.query(`UPDATE friend_requests SET status = 'accepted' WHERE id = $1`, [requestId]);

      const senderRes = await pool.query(
        `SELECT id, user_id_code, username, full_name, avatar FROM users WHERE id = $1`,
        [fr.sender_id]
      );
      const receiverRes = await pool.query(
        `SELECT id, user_id_code, username, full_name, avatar FROM users WHERE id = $1`,
        [fr.receiver_id]
      );

      const sender = senderRes.rows[0];
      const receiver = receiverRes.rows[0];

      // Broadcast to both users
      broadcastToUser(fr.sender_id, {
        type: "friend_request_accepted",
        friend: { ...receiver, online: isUserOnline(receiver.id) },
      });

      broadcastToUser(fr.receiver_id, {
        type: "friend_request_accepted",
        friend: { ...sender, online: isUserOnline(sender.id) },
      });

      return res.json({ message: "Friend request accepted! You can now chat." });
    } else {
      await pool.query(`UPDATE friend_requests SET status = 'rejected' WHERE id = $1`, [requestId]);
      return res.json({ message: "Friend request declined." });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to respond to friend request." });
  }
});

// 8. Get Friends & Pending Requests
app.get("/api/friends", async (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) {
    return res.status(400).json({ error: "userId is required." });
  }

  try {
    // 1. Accepted Friends with last message
    const friendsRes = await pool.query(
      `SELECT u.id, u.user_id_code AS "userIdCode", u.username, u.email, u.full_name AS "fullName",
              u.avatar, u.bio
       FROM users u
       JOIN friend_requests fr 
         ON fr.status = 'accepted' 
        AND ((fr.sender_id = $1 AND fr.receiver_id = u.id) OR (fr.sender_id = u.id AND fr.receiver_id = $1))
       WHERE u.id != $1`,
      [userId]
    );

    const friends = await Promise.all(
      friendsRes.rows.map(async (u) => {
        const lastMsgRes = await pool.query(
          `SELECT content, message_type AS "messageType", file_name AS "fileName", timestamp 
           FROM messages 
           WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
           ORDER BY timestamp DESC LIMIT 1`,
          [userId, u.id]
        );

        const lastMsg = lastMsgRes.rows[0];
        let preview = null;
        if (lastMsg) {
          if (lastMsg.messageType === "image") preview = "📷 Photo";
          else if (lastMsg.messageType === "file") preview = `📄 ${lastMsg.fileName || "File"}`;
          else preview = lastMsg.content;
        }

        return {
          ...u,
          online: isUserOnline(u.id),
          lastMessage: preview,
          lastMessageTime: lastMsg ? lastMsg.timestamp : null,
        };
      })
    );

    // 2. Pending Incoming Requests
    const incomingRes = await pool.query(
      `SELECT fr.id, fr.sender_id AS "senderId", u.user_id_code AS "userIdCode",
              u.username, u.full_name AS "fullName", u.avatar, fr.created_at AS "createdAt"
       FROM friend_requests fr
       JOIN users u ON u.id = fr.sender_id
       WHERE fr.receiver_id = $1 AND fr.status = 'pending'`,
      [userId]
    );

    // 3. Pending Outgoing Requests
    const outgoingRes = await pool.query(
      `SELECT fr.id, fr.receiver_id AS "receiverId", u.user_id_code AS "userIdCode",
              u.username, u.full_name AS "fullName", u.avatar, fr.created_at AS "createdAt"
       FROM friend_requests fr
       JOIN users u ON u.id = fr.receiver_id
       WHERE fr.sender_id = $1 AND fr.status = 'pending'`,
      [userId]
    );

    res.json({
      friends,
      pendingIncoming: incomingRes.rows,
      pendingOutgoing: outgoingRes.rows,
    });
  } catch (err: any) {
    console.error("Get friends error:", err);
    res.status(500).json({ error: "Failed to fetch friends." });
  }
});

// 9. File & Image Upload endpoint (stores in storage/images/ or storage/files/)
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file was uploaded." });
  }

  const isImage = req.file.mimetype.startsWith("image/");
  const subFolder = isImage ? "images" : "files";
  const fileUrl = `/storage/${subFolder}/${req.file.filename}`;

  // Human readable file size (e.g. 2.4 MB)
  const bytes = req.file.size;
  let formattedSize = `${bytes} B`;
  if (bytes > 1024 * 1024) formattedSize = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  else if (bytes > 1024) formattedSize = `${(bytes / 1024).toFixed(1)} KB`;

  res.json({
    fileUrl,
    fileName: req.file.originalname,
    fileSize: formattedSize,
    messageType: isImage ? "image" : "file",
  });
});

// 10. Get Messages (Gated by friendship)
app.get("/api/messages", async (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) {
    return res.status(400).json({ error: "user1 and user2 query parameters are required." });
  }

  const u1 = user1 as string;
  const u2 = user2 as string;

  const friends = await areFriends(u1, u2);
  if (!friends) {
    return res.status(403).json({
      error: "You can only view messages with accepted friends.",
      allowed: false,
      messages: [],
    });
  }

  try {
    const msgRes = await pool.query(
      `SELECT id, sender_id AS "senderId", receiver_id AS "receiverId", content,
              message_type AS "messageType", file_url AS "fileUrl", file_name AS "fileName",
              file_size AS "fileSize", timestamp
       FROM messages
       WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
       ORDER BY timestamp ASC`,
      [u1, u2]
    );

    res.json({ messages: msgRes.rows, allowed: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch messages." });
  }
});

// 11. Send Message via REST (Gated by friendship, saves to PostgreSQL + storage/chat/)
app.post("/api/messages", async (req, res) => {
  const { senderId, receiverId, content, messageType, fileUrl, fileName, fileSize } = req.body;
  if (!senderId || !receiverId) {
    return res.status(400).json({ error: "senderId and receiverId are required." });
  }

  const friends = await areFriends(senderId, receiverId);
  if (!friends) {
    return res.status(403).json({ error: "You must be accepted friends to chat.", allowed: false });
  }

  const msgId = `m_${crypto.randomUUID().slice(0, 8)}`;
  const mType = messageType || "text";
  const textContent = content || (mType === "image" ? "Photo" : fileName || "Attachment");

  try {
    const insertRes = await pool.query(
      `INSERT INTO messages (id, sender_id, receiver_id, content, message_type, file_url, file_name, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, sender_id AS "senderId", receiver_id AS "receiverId", content,
                 message_type AS "messageType", file_url AS "fileUrl", file_name AS "fileName",
                 file_size AS "fileSize", timestamp`,
      [msgId, senderId, receiverId, textContent, mType, fileUrl || null, fileName || null, fileSize || null]
    );

    const newMessage = insertRes.rows[0];

    // Backup to storage/chat/
    await syncChatBackup(senderId, receiverId);

    // Broadcast in real-time
    broadcastToUser(receiverId, { type: "new_message", message: newMessage });
    broadcastToUser(senderId, { type: "new_message", message: newMessage });

    res.json({ message: newMessage });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: "Failed to save message." });
  }
});

// ---------------- WEBSOCKET SERVER ----------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const userId = url.searchParams.get("userId");

  if (!userId) {
    ws.close(1008, "User ID missing");
    return;
  }

  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set());
  }
  userSockets.get(userId)!.add(ws);

  broadcastGlobal({ type: "user_status", userId, online: true });

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === "send_message") {
        const { receiverId, content, messageType, fileUrl, fileName, fileSize } = data;
        if (!receiverId) return;

        const friends = await areFriends(userId, receiverId);
        if (!friends) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Cannot send message: you must be accepted friends first.",
            })
          );
          return;
        }

        const msgId = `m_${crypto.randomUUID().slice(0, 8)}`;
        const mType = messageType || "text";
        const textContent = content || (mType === "image" ? "Photo" : fileName || "Attachment");

        const insertRes = await pool.query(
          `INSERT INTO messages (id, sender_id, receiver_id, content, message_type, file_url, file_name, file_size)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, sender_id AS "senderId", receiver_id AS "receiverId", content,
                     message_type AS "messageType", file_url AS "fileUrl", file_name AS "fileName",
                     file_size AS "fileSize", timestamp`,
          [msgId, userId, receiverId, textContent, mType, fileUrl || null, fileName || null, fileSize || null]
        );

        const newMessage = insertRes.rows[0];

        // Backup to storage/chat/
        await syncChatBackup(userId, receiverId);

        // Send to receiver & echo to sender
        broadcastToUser(receiverId, { type: "new_message", message: newMessage });
        broadcastToUser(userId, { type: "new_message", message: newMessage });
      } else if (data.type === "typing") {
        const { receiverId, isTyping } = data;
        if (receiverId && (await areFriends(userId, receiverId))) {
          broadcastToUser(receiverId, {
            type: "typing_indicator",
            senderId: userId,
            isTyping: Boolean(isTyping),
          });
        }
      }
    } catch (err) {
      console.error("WebSocket message error:", err);
    }
  });

  ws.on("close", () => {
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        broadcastGlobal({ type: "user_status", userId, online: false });
      }
    }
  });
});

// Initialize PostgreSQL database and start listening
initDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Chatvia Server running on http://localhost:${PORT}`);
      console.log(`WebSocket running on ws://localhost:${PORT}/ws`);
      console.log(`Storage root: ${STORAGE_DIR} (chat, images, files, avatars)`);
    });
  })
  .catch((err) => {
    console.error("FATAL: Failed to initialize PostgreSQL database:", err);
  });