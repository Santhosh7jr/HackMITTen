import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import multer from "multer";
import jwt from "jsonwebtoken";
import { promisify } from "util";

import {
  pool,
  initDatabase,
  hashPassword,
  generateUserIdCode,
} from "./db.js";

const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json({ limit: "14mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max
});

// WebSocket tracking: userId -> Set of WebSockets
const userSockets = new Map<string, Set<WebSocket>>();

class FaceRecognitionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
  }
}

class SteganographyError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
  }
}

function getJwtSecret(): string | null {
  const secret = process.env.JWT_SECRET;
  return secret && Buffer.byteLength(secret, "utf8") >= 32 ? secret : null;
}

function createAccessToken(userId: string): string {
  const secret = getJwtSecret();
  if (!secret) {
    throw new Error("JWT_SECRET must be configured with at least 32 bytes.");
  }
  return jwt.sign({}, secret, { subject: userId, issuer: "chatvia", expiresIn: "12h" });
}

const scrypt = promisify(crypto.scrypt);

async function hashFriendshipSecret(secret: string, salt: Buffer): Promise<Buffer> {
  return (await scrypt(secret, salt, 32)) as Buffer;
}

async function callSteganographyService(
  endpoint: "embed" | "extract",
  image: Buffer,
  payload?: Buffer
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(
      `${process.env.STEGANOGRAPHY_SERVICE_URL || "http://127.0.0.1:8001"}/stego/${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: image.toString("base64"),
          ...(payload ? { payload_base64: payload.toString("base64") } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      }
    );
  } catch {
    throw new SteganographyError("The steganography service is unavailable.", 503);
  }

  const result = (await response.json().catch(() => ({}))) as {
    image_base64?: string;
    payload_base64?: string;
    detail?: string;
  };
  if (!response.ok) {
    throw new SteganographyError(
      result.detail || "The image could not be processed.",
      response.status === 422 ? 422 : 503
    );
  }

  const encoded = endpoint === "embed" ? result.image_base64 : result.payload_base64;
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new SteganographyError("The steganography service returned invalid data.", 503);
  }
  const data = Buffer.from(encoded, "base64");
  if (!data.length || data.toString("base64") !== encoded) {
    throw new SteganographyError("The steganography service returned invalid data.", 503);
  }
  return data;
}

function requireJwt(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const secret = getJwtSecret();
  if (!secret) {
    return res.status(503).json({ error: "JWT authentication is not configured." });
  }

  const authorization = req.header("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) {
    return res.status(401).json({ error: "Bearer token is required." });
  }

  try {
    const payload = jwt.verify(token, secret, { issuer: "chatvia" });
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      return res.status(401).json({ error: "Invalid authentication token." });
    }
    res.locals.userId = payload.sub;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired authentication token." });
  }
}

function getFaceEncryptionKey(): Buffer | null {
  const encodedKey = process.env.FACE_ENCRYPTION_KEY;
  if (!encodedKey || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) return null;

  const key = Buffer.from(encodedKey, "base64");
  return key.length === 32 && key.toString("base64") === encodedKey ? key : null;
}

async function extractFaceEmbedding(imageBase64: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(
      `${process.env.FACE_SERVICE_URL || "http://127.0.0.1:8001"}/face/embedding`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: imageBase64 }),
        signal: AbortSignal.timeout(60_000),
      }
    );
  } catch {
    throw new FaceRecognitionError("Facial recognition service is unavailable.", 503);
  }

  const result = (await response.json().catch(() => ({}))) as {
    embedding?: string;
    detail?: string;
  };
  if (!response.ok) {
    throw new FaceRecognitionError(
      result.detail || "The face capture could not be processed.",
      [400, 413, 422].includes(response.status) ? response.status : 503
    );
  }

  if (!result.embedding || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.embedding)) {
    throw new FaceRecognitionError("Facial recognition returned an invalid template.", 503);
  }

  const embedding = Buffer.from(result.embedding, "base64");
  if (
    embedding.length === 0 ||
    embedding.length > 16_384 ||
    embedding.length % Float32Array.BYTES_PER_ELEMENT !== 0 ||
    embedding.toString("base64") !== result.embedding
  ) {
    throw new FaceRecognitionError("Facial recognition returned an invalid template.", 503);
  }
  return embedding;
}

function decryptFaceTemplate(
  ciphertext: Buffer,
  nonce: Buffer,
  authTag: Buffer
): Buffer {
  const encryptionKey = getFaceEncryptionKey();
  if (!encryptionKey) {
    throw new FaceRecognitionError("Face verification is not configured.", 503);
  }

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    console.error("Stored face template could not be decrypted:", error);
    throw new FaceRecognitionError("The enrolled face template is unavailable.", 503);
  }
}

async function verifyFaceWithService(
  imageBase64: string,
  referenceEmbedding: Buffer
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(
      `${process.env.FACE_SERVICE_URL || "http://127.0.0.1:8001"}/face/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: imageBase64,
          reference_embedding_base64: referenceEmbedding.toString("base64"),
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );
  } catch {
    throw new FaceRecognitionError("Facial verification service is unavailable.", 503);
  }

  const result = (await response.json().catch(() => ({}))) as {
    verified?: boolean;
    detail?: string;
  };
  if (!response.ok) {
    throw new FaceRecognitionError(
      result.detail || "The face capture could not be verified.",
      [400, 413].includes(response.status) ? response.status : 503
    );
  }
  if (typeof result.verified !== "boolean") {
    throw new FaceRecognitionError("Facial verification returned an invalid response.", 503);
  }
  return result.verified;
}

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

// ---------------- REST API ROUTES ----------------

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", db: "PostgreSQL", timestamp: new Date().toISOString() });
});

// 1. Register: requires username, email (Gmail ID), password
app.post("/api/auth/register", async (req, res) => {
  const { username, email, password, fullName, avatar, bio, faceImage, faceConsent } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: "Username, Gmail ID (email), and password are required." });
  }
  if (faceConsent !== true || typeof faceImage !== "string") {
    return res.status(400).json({ error: "Face enrollment and consent are required to register." });
  }
  if (
    faceImage.length > 3_000_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(faceImage)
  ) {
    return res.status(400).json({ error: "The face capture is invalid or too large." });
  }
  if (!getJwtSecret()) {
    console.error("Registration is unavailable: JWT_SECRET must be configured with at least 32 bytes.");
    return res.status(503).json({ error: "Registration is unavailable because authentication is not configured." });
  }

  const encryptionKey = getFaceEncryptionKey();
  if (!encryptionKey) {
    console.error("Registration is unavailable: FACE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    return res.status(503).json({ error: "Registration is unavailable because face encryption is not configured." });
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

    let embedding: Buffer;
    try {
      embedding = await extractFaceEmbedding(faceImage);
    } catch (err) {
      console.error("Face enrollment error:", err);
      if (err instanceof FaceRecognitionError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res.status(503).json({ error: "Facial recognition is temporarily unavailable." });
    }

    const newId = `u_${crypto.randomUUID().slice(0, 8)}`;
    const userIdCode = generateUserIdCode();
    const pHash = hashPassword(password);
    const name = fullName?.trim() || cleanUsername;
    const userAvatar =
      avatar ||
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23e9e7ff'/%3E%3Ccircle cx='50' cy='38' r='18' fill='%237269ef'/%3E%3Cpath d='M15 100c2-24 16-36 35-36s33 12 35 36' fill='%237269ef'/%3E%3C/svg%3E";
    const userBio = bio?.trim() || "Hey there! I am using CryptChat.";
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(embedding), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const client = await pool.connect();
    let user;
    try {
      await client.query("BEGIN");
      const insertRes = await client.query(
        `INSERT INTO users (id, user_id_code, username, email, full_name, password_hash, avatar, bio)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, user_id_code AS "userIdCode", username, email, full_name AS "fullName", avatar, bio`,
        [newId, userIdCode, cleanUsername, cleanEmail, name, pHash, userAvatar, userBio]
      );
      user = insertRes.rows[0];
      await client.query(
        `INSERT INTO face_biometrics
           (user_id, template_ciphertext, nonce, auth_tag, algorithm, consented_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [newId, ciphertext, nonce, authTag, "InspireFace-Pikachu"]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

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

    return res.json({ user, token: createAccessToken(user.id) });
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
  if (!getJwtSecret()) {
    return res.status(503).json({ error: "Authentication is not configured." });
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
    return res.json({ user, token: createAccessToken(user.id) });
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

app.get("/api/friends/:friendId/secure-key", requireJwt, async (req, res) => {
  const userId = res.locals.userId as string;
  try {
    const friendship = await pool.query(
      `SELECT fr.id, fs.salt, fs.set_by, fs.confirmed_by, fs.confirmed_at
       FROM friend_requests fr
       LEFT JOIN friendship_secrets fs ON fs.friendship_id = fr.id
       WHERE fr.status = 'accepted'
         AND ((fr.sender_id = $1 AND fr.receiver_id = $2)
           OR (fr.sender_id = $2 AND fr.receiver_id = $1))`,
      [userId, req.params.friendId]
    );
    if (friendship.rows.length === 0) {
      return res.status(403).json({ error: "Secure keys are available only to accepted friends." });
    }

    const key = friendship.rows[0];
    const configured = Boolean(key.set_by);
    const setByMe = key.set_by === userId;
    const ready = configured && Boolean(key.confirmed_at);
    return res.json({
      configured,
      ready,
      setByMe,
      confirmedByMe: key.confirmed_by === userId,
      confirmed: Boolean(key.confirmed_by),
      salt: configured ? Buffer.from(key.salt).toString("base64") : null,
    });
  } catch (err) {
    console.error("Friendship key status error:", err);
    return res.status(500).json({ error: "Failed to fetch secure key status." });
  }
});

app.put("/api/friends/:friendId/secure-key", requireJwt, async (req, res) => {
  const userId = res.locals.userId as string;
  const secret = req.body.secret;
  if (typeof secret !== "string" || secret.trim().length < 12 || secret.length > 256) {
    return res.status(400).json({ error: "Use a shared passphrase between 12 and 256 characters." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const friendship = await client.query(
      `SELECT id FROM friend_requests
       WHERE status = 'accepted'
         AND ((sender_id = $1 AND receiver_id = $2)
           OR (sender_id = $2 AND receiver_id = $1))
       FOR UPDATE`,
      [userId, req.params.friendId]
    );
    if (friendship.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Secure keys are available only to accepted friends." });
    }

    const friendshipId = friendship.rows[0].id as string;
    const existing = await client.query(
      `SELECT salt, secret_hash, set_by, confirmed_by
       FROM friendship_secrets WHERE friendship_id = $1 FOR UPDATE`,
      [friendshipId]
    );

    if (existing.rows.length === 0) {
      const salt = crypto.randomBytes(16);
      const secretHash = await hashFriendshipSecret(secret, salt);
      await client.query(
        `INSERT INTO friendship_secrets (friendship_id, salt, secret_hash, set_by)
         VALUES ($1, $2, $3, $4)`,
        [friendshipId, salt, secretHash, userId]
      );
      await client.query("COMMIT");
      return res.json({
        ready: false,
        setByMe: true,
        confirmed: false,
        salt: salt.toString("base64"),
        message: "Shared passphrase saved. Your friend must confirm it once before secure messaging is enabled.",
      });
    }

    const stored = existing.rows[0];
    if (stored.confirmed_by) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This friendship already has a confirmed shared key." });
    }
    if (stored.set_by === userId) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Waiting for your friend to confirm the shared passphrase." });
    }

    const suppliedHash = await hashFriendshipSecret(secret, Buffer.from(stored.salt));
    if (!crypto.timingSafeEqual(suppliedHash, Buffer.from(stored.secret_hash))) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "That passphrase does not match your friend's key." });
    }

    await client.query(
      `UPDATE friendship_secrets
       SET confirmed_by = $2, confirmed_at = CURRENT_TIMESTAMP
       WHERE friendship_id = $1`,
      [friendshipId, userId]
    );
    await client.query("COMMIT");
    return res.json({
      ready: true,
      confirmed: true,
      salt: Buffer.from(stored.salt).toString("base64"),
      message: "Shared passphrase confirmed. Use it to encrypt and decrypt secure messages.",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Friendship key setup error:", err);
    return res.status(500).json({ error: "Failed to set up the shared passphrase." });
  } finally {
    client.release();
  }
});

app.post("/api/friends/:friendId/secure-key/verify", requireJwt, async (req, res) => {
  const userId = res.locals.userId as string;
  const secret = req.body.secret;
  if (typeof secret !== "string" || secret.length < 12 || secret.length > 256) {
    return res.status(400).json({ error: "Enter the shared passphrase for this friendship." });
  }

  try {
    const result = await pool.query(
      `SELECT fs.salt, fs.secret_hash
       FROM friend_requests fr
       JOIN friendship_secrets fs ON fs.friendship_id = fr.id
       WHERE fr.status = 'accepted'
         AND fs.confirmed_at IS NOT NULL
         AND ((fr.sender_id = $1 AND fr.receiver_id = $2)
           OR (fr.sender_id = $2 AND fr.receiver_id = $1))`,
      [userId, req.params.friendId]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ error: "The shared passphrase is not ready for this friendship." });
    }

    const stored = result.rows[0];
    const suppliedHash = await hashFriendshipSecret(secret, Buffer.from(stored.salt));
    const matches = crypto.timingSafeEqual(suppliedHash, Buffer.from(stored.secret_hash));
    return res.json({
      valid: matches,
      salt: matches ? Buffer.from(stored.salt).toString("base64") : undefined,
    });
  } catch (err) {
    console.error("Friendship key verification error:", err);
    return res.status(500).json({ error: "Failed to verify the shared passphrase." });
  }
});

app.post("/api/friends/:friendId/secure-key/rotate", requireJwt, async (req, res) => {
  const userId = res.locals.userId as string;
  const { currentSecret, newSecret } = req.body as {
    currentSecret?: unknown;
    newSecret?: unknown;
  };
  if (
    typeof currentSecret !== "string" ||
    currentSecret.length < 12 ||
    currentSecret.length > 256 ||
    typeof newSecret !== "string" ||
    newSecret.trim().length < 12 ||
    newSecret.length > 256
  ) {
    return res.status(400).json({ error: "Current and new passphrases must each be 12 to 256 characters." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const friendship = await client.query(
      `SELECT id FROM friend_requests
       WHERE status = 'accepted'
         AND ((sender_id = $1 AND receiver_id = $2)
           OR (sender_id = $2 AND receiver_id = $1))
       FOR UPDATE`,
      [userId, req.params.friendId]
    );
    if (friendship.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Secure keys are available only to accepted friends." });
    }

    const friendshipId = friendship.rows[0].id as string;
    const existing = await client.query(
      `SELECT salt, secret_hash, confirmed_at
       FROM friendship_secrets WHERE friendship_id = $1 FOR UPDATE`,
      [friendshipId]
    );
    if (existing.rows.length === 0 || !existing.rows[0].confirmed_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Confirm the current shared passphrase before changing it." });
    }

    const stored = existing.rows[0];
    const suppliedHash = await hashFriendshipSecret(currentSecret, Buffer.from(stored.salt));
    if (!crypto.timingSafeEqual(suppliedHash, Buffer.from(stored.secret_hash))) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "The current passphrase is incorrect." });
    }

    const pendingMessages = await client.query(
      `SELECT 1
       FROM messages m
       JOIN stego_messages sm ON sm.message_id = m.id AND sm.consumed_at IS NULL
       WHERE m.is_secure = TRUE
         AND ((m.sender_id = $1 AND m.receiver_id = $2)
           OR (m.sender_id = $2 AND m.receiver_id = $1))
       LIMIT 1`,
      [userId, req.params.friendId]
    );
    if (pendingMessages.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "View or remove all pending private image messages before changing this key.",
      });
    }

    const salt = crypto.randomBytes(16);
    const secretHash = await hashFriendshipSecret(newSecret, salt);
    await client.query(
      `UPDATE friendship_secrets
       SET salt = $2, secret_hash = $3, set_by = $4, confirmed_by = NULL,
           confirmed_at = NULL
       WHERE friendship_id = $1`,
      [friendshipId, salt, secretHash, userId]
    );
    await client.query("COMMIT");
    return res.json({
      ready: false,
      salt: salt.toString("base64"),
      message: "New passphrase saved. Your friend must confirm it once before either of you can use it.",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Friendship key rotation error:", err);
    return res.status(500).json({ error: "Failed to update the shared passphrase." });
  } finally {
    client.release();
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

// 9. File & Image Upload endpoint (stores file data in PostgreSQL)
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file was uploaded." });
  }
  const userId = req.body.userId as string | undefined;
  if (!userId) {
    return res.status(400).json({ error: "userId is required." });
  }

  const isImage = req.file.mimetype.startsWith("image/");
  const formattedSize =
    req.file.size > 1024 * 1024
      ? `${(req.file.size / (1024 * 1024)).toFixed(1)} MB`
      : req.file.size > 1024
        ? `${(req.file.size / 1024).toFixed(1)} KB`
        : `${req.file.size} B`;
  const attachmentId = crypto.randomUUID();

  try {
    const userRes = await pool.query("SELECT id FROM users WHERE id = $1", [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    await pool.query(
      `INSERT INTO attachments (id, owner_id, file_name, content_type, file_data, file_size)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        attachmentId,
        userId,
        req.file.originalname,
        req.file.mimetype,
        req.file.buffer,
        req.file.size,
      ]
    );

    return res.json({
      fileUrl: `/api/files/${attachmentId}`,
      fileName: req.file.originalname,
      fileSize: formattedSize,
      messageType: isImage ? "image" : "file",
    });
  } catch (err) {
    console.error("File upload error:", err);
    return res.status(500).json({ error: "Failed to save uploaded file." });
  }
});

app.get("/api/files/:id", async (req, res) => {
  const userId = req.query.userId as string | undefined;
  if (!userId) {
    return res.status(400).json({ error: "userId is required." });
  }

  try {
    const fileRes = await pool.query(
      `SELECT a.file_data, a.content_type AS "contentType", a.file_name AS "fileName",
              m.message_type AS "messageType"
       FROM attachments a
       JOIN messages m ON m.file_url = '/api/files/' || a.id
       WHERE a.id = $1 AND ($2 = m.sender_id OR $2 = m.receiver_id)
       LIMIT 1`,
      [req.params.id, userId]
    );
    if (fileRes.rows.length === 0) {
      return res.status(404).json({ error: "File not found." });
    }

    const file = fileRes.rows[0];
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `${file.messageType === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(file.file_data);
  } catch (err) {
    console.error("File retrieval error:", err);
    return res.status(500).json({ error: "Failed to retrieve file." });
  }
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
              file_size AS "fileSize", is_secure AS "isSecure",
              COALESCE(sm.consumed_at IS NOT NULL, FALSE) AS "secureConsumed", m.timestamp
       FROM messages m
       LEFT JOIN stego_messages sm ON sm.message_id = m.id
       WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)
       ORDER BY m.timestamp ASC`,
      [u1, u2]
    );

    res.json({ messages: msgRes.rows, allowed: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch messages." });
  }
});

app.post("/api/secure/messages", requireJwt, async (req, res) => {
  const senderId = res.locals.userId as string;
  const { friendId, keySalt, imageBase64, payloadBase64 } = req.body as {
    friendId?: string;
    keySalt?: string;
    imageBase64?: string;
    payloadBase64?: string;
  };
  if (
    typeof friendId !== "string" ||
    typeof keySalt !== "string" ||
    !/^[A-Za-z0-9+/]{22}==$/.test(keySalt) ||
    typeof imageBase64 !== "string" ||
    typeof payloadBase64 !== "string" ||
    imageBase64.length > 11_200_000 ||
    payloadBase64.length > 1_400_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(payloadBase64)
  ) {
    return res.status(400).json({ error: "A PNG and encrypted message are required." });
  }

  const image = Buffer.from(imageBase64, "base64");
  const payload = Buffer.from(payloadBase64, "base64");
  if (
    image.length === 0 ||
    image.length > 8 * 1024 * 1024 ||
    image.toString("base64") !== imageBase64 ||
    payload.length === 0 ||
    payload.length > 1_000_000 ||
    payload.toString("base64") !== payloadBase64
  ) {
    return res.status(400).json({ error: "The PNG or encrypted message is invalid or too large." });
  }

  try {
    const friendshipRes = await pool.query(
      `SELECT fr.id, fs.salt
       FROM friend_requests fr
       JOIN friendship_secrets fs ON fs.friendship_id = fr.id
       WHERE fr.status = 'accepted'
         AND fs.confirmed_at IS NOT NULL
         AND ((fr.sender_id = $1 AND fr.receiver_id = $2)
           OR (fr.sender_id = $2 AND fr.receiver_id = $1))`,
      [senderId, friendId]
    );
    if (friendshipRes.rows.length === 0) {
      return res.status(403).json({ error: "Confirm the shared passphrase with this friend first." });
    }
    const friendshipId = friendshipRes.rows[0].id as string;
    if (Buffer.from(friendshipRes.rows[0].salt).toString("base64") !== keySalt) {
      return res.status(409).json({ error: "The friendship key changed. Refresh the chat before sending." });
    }

    const stegoImage = await callSteganographyService("embed", image, payload);
    const messageId = `m_${crypto.randomUUID().slice(0, 12)}`;
    const attachmentId = crypto.randomUUID();
    const client = await pool.connect();
    let message;
    try {
      await client.query("BEGIN");
      const currentKey = await client.query(
        `SELECT fs.salt, fs.confirmed_at
         FROM friend_requests fr
         JOIN friendship_secrets fs ON fs.friendship_id = fr.id
         WHERE fr.id = $1 AND fr.status = 'accepted'
         FOR UPDATE OF fr, fs`,
        [friendshipId]
      );
      if (
        currentKey.rows.length === 0 ||
        !currentKey.rows[0].confirmed_at ||
        Buffer.from(currentKey.rows[0].salt).toString("base64") !== keySalt
      ) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "The friendship key changed. Refresh the chat and confirm the current key before sending.",
        });
      }
      await client.query(
        `INSERT INTO attachments (id, owner_id, file_name, content_type, file_data, file_size)
         VALUES ($1, $2, $3, 'image/png', $4, $5)`,
        [attachmentId, senderId, `${messageId}.png`, stegoImage, stegoImage.length]
      );
      const messageRes = await client.query(
        `INSERT INTO messages
           (id, sender_id, receiver_id, content, message_type, file_url, file_name, file_size, is_secure)
         VALUES ($1, $2, $3, 'Encrypted image message', 'image', $4, $5, $6, TRUE)
         RETURNING id, sender_id AS "senderId", receiver_id AS "receiverId", content,
                   message_type AS "messageType", file_url AS "fileUrl", file_name AS "fileName",
                   file_size AS "fileSize", is_secure AS "isSecure", timestamp`,
        [
          messageId,
          senderId,
          friendId,
          `/api/secure/messages/${messageId}/image`,
          `${messageId}.png`,
          `${(stegoImage.length / 1024).toFixed(1)} KB`,
        ]
      );
      message = messageRes.rows[0];
      await client.query(
        "INSERT INTO stego_messages (message_id, attachment_id, original_png) VALUES ($1, $2, $3)",
        [messageId, attachmentId, image]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    broadcastToUser(friendId, { type: "new_message", message });
    broadcastToUser(senderId, { type: "new_message", message });
    return res.json({ message });
  } catch (err) {
    console.error("Secure message send error:", err);
    const message = err instanceof Error ? err.message : "Failed to send secure image.";
    const statusCode = err instanceof SteganographyError ? err.statusCode : 500;
    return res.status(statusCode).json({ error: message });
  }
});

app.get("/api/secure/messages/:id/image", requireJwt, async (req, res) => {
  const userId = res.locals.userId as string;
  try {
    const imageRes = await pool.query(
      `SELECT a.file_data
       FROM messages m
       JOIN stego_messages sm ON sm.message_id = m.id
       JOIN attachments a ON a.id = sm.attachment_id
       WHERE m.id = $1 AND m.is_secure = TRUE
         AND ($2 = m.sender_id OR $2 = m.receiver_id)`,
      [req.params.id, userId]
    );
    if (imageRes.rows.length === 0) {
      return res.status(404).json({ error: "Secure image not found." });
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(imageRes.rows[0].file_data);
  } catch (err) {
    console.error("Secure image fetch error:", err);
    return res.status(500).json({ error: "Failed to retrieve secure image." });
  }
});

app.post("/api/secure/messages/:id/verify-face", requireJwt, async (req, res) => {
  const receiverId = res.locals.userId as string;
  const imageBase64 = req.body?.imageBase64;
  if (
    typeof imageBase64 !== "string" ||
    imageBase64.length > 2_800_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)
  ) {
    return res.status(400).json({ error: "A valid camera capture is required." });
  }

  const image = Buffer.from(imageBase64, "base64");
  if (
    image.length === 0 ||
    image.length > 2_000_000 ||
    image.toString("base64") !== imageBase64
  ) {
    return res.status(400).json({ error: "The camera capture is invalid or too large." });
  }

  let template: Buffer | undefined;
  try {
    const templateResult = await pool.query(
      `SELECT b.template_ciphertext, b.nonce, b.auth_tag
       FROM messages m
       JOIN face_biometrics b ON b.user_id = m.receiver_id
       WHERE m.id = $1 AND m.receiver_id = $2 AND m.is_secure = TRUE`,
      [req.params.id, receiverId]
    );
    if (templateResult.rows.length === 0) {
      return res.status(403).json({ verified: false });
    }

    const stored = templateResult.rows[0];
    template = decryptFaceTemplate(
      Buffer.from(stored.template_ciphertext),
      Buffer.from(stored.nonce),
      Buffer.from(stored.auth_tag)
    );
    const verified = await verifyFaceWithService(imageBase64, template);
    return res.json({ verified });
  } catch (error) {
    console.error("Secure message face verification error:", error);
    const statusCode = error instanceof FaceRecognitionError ? error.statusCode : 500;
    const message =
      error instanceof FaceRecognitionError
        ? error.message
        : "Could not verify the recipient.";
    return res.status(statusCode).json({ error: message });
  } finally {
    image.fill(0);
    template?.fill(0);
  }
});

app.post("/api/secure/messages/:id/payload", requireJwt, async (req, res) => {
  const receiverId = res.locals.userId as string;
  try {
    const imageRes = await pool.query(
      `SELECT a.file_data
       FROM messages m
       JOIN stego_messages sm ON sm.message_id = m.id AND sm.consumed_at IS NULL
       JOIN attachments a ON a.id = sm.attachment_id
       JOIN friend_requests fr ON fr.status = 'accepted'
         AND ((fr.sender_id = m.sender_id AND fr.receiver_id = m.receiver_id)
           OR (fr.sender_id = m.receiver_id AND fr.receiver_id = m.sender_id))
       JOIN friendship_secrets fs ON fs.friendship_id = fr.id AND fs.confirmed_at IS NOT NULL
       WHERE m.id = $1 AND m.receiver_id = $2 AND m.is_secure = TRUE`,
      [req.params.id, receiverId]
    );
    if (imageRes.rows.length === 0) {
      return res.status(410).json({ error: "This secure message has already been viewed or is unavailable." });
    }

    const payload = await callSteganographyService(
      "extract",
      Buffer.from(imageRes.rows[0].file_data)
    );
    return res.json({ payloadBase64: payload.toString("base64") });
  } catch (err) {
    console.error("Secure message extraction error:", err);
    const message = err instanceof Error ? err.message : "Failed to extract secure message.";
    const statusCode = err instanceof SteganographyError ? err.statusCode : 500;
    return res.status(statusCode).json({ error: message });
  }
});

app.post("/api/secure/messages/:id/consume", requireJwt, async (req, res) => {
  const receiverId = res.locals.userId as string;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const secureMessage = await client.query(
      `SELECT sm.attachment_id, sm.original_png, m.sender_id
       FROM messages m
       JOIN stego_messages sm ON sm.message_id = m.id AND sm.consumed_at IS NULL
       WHERE m.id = $1 AND m.receiver_id = $2 AND m.is_secure = TRUE
         AND sm.original_png IS NOT NULL
       FOR UPDATE OF sm`,
      [req.params.id, receiverId]
    );
    if (secureMessage.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(410).json({ error: "This secure message has already been viewed or is unavailable." });
    }

    const originalPng = Buffer.from(secureMessage.rows[0].original_png);
    await client.query(
      `UPDATE attachments SET file_data = $1, file_size = $2
       WHERE id = $3`,
      [originalPng, originalPng.length, secureMessage.rows[0].attachment_id]
    );
    await client.query(
      "UPDATE stego_messages SET original_png = NULL, consumed_at = CURRENT_TIMESTAMP WHERE message_id = $1",
      [req.params.id]
    );
    await client.query("COMMIT");
    broadcastToUser(secureMessage.rows[0].sender_id, {
      type: "secure_message_consumed",
      messageId: req.params.id,
    });
    return res.json({ consumed: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Secure message consume error:", err);
    return res.status(500).json({ error: "Failed to restore the original image." });
  } finally {
    client.release();
  }
});

// 11. Send Message via REST (Gated by friendship, saves to PostgreSQL)
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
const socketLiveness = new WeakMap<WebSocket, boolean>();

const presenceHeartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socketLiveness.get(socket) === false) {
      socket.terminate();
      continue;
    }
    socketLiveness.set(socket, false);
    socket.ping();
  }
}, 30_000);

wss.on("close", () => clearInterval(presenceHeartbeat));

wss.on("connection", (ws, req) => {
  socketLiveness.set(ws, true);
  ws.on("pong", () => socketLiveness.set(ws, true));

  let userId: string | null = null;
  const authTimeout = setTimeout(() => ws.close(1008, "Authentication required"), 10_000);

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (!userId) {
        const secret = getJwtSecret();
        if (data.type !== "authenticate" || typeof data.token !== "string" || !secret) {
          ws.close(1008, "Valid authentication token required");
          return;
        }

        const payload = jwt.verify(data.token, secret, { issuer: "chatvia" });
        if (typeof payload === "string" || typeof payload.sub !== "string") {
          ws.close(1008, "Invalid authentication token");
          return;
        }
        userId = payload.sub;
        clearTimeout(authTimeout);
        const wasOnline = isUserOnline(userId);
        if (!userSockets.has(userId)) {
          userSockets.set(userId, new Set());
        }
        userSockets.get(userId)!.add(ws);
        ws.send(
          JSON.stringify({
            type: "presence_snapshot",
            onlineUserIds: [...userSockets.keys()].filter((id) => id !== userId),
          })
        );
        if (!wasOnline) {
          broadcastGlobal({ type: "user_status", userId, online: true });
        }
        return;
      }

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
    clearTimeout(authTimeout);
    if (!userId) return;
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
      console.log(`CryptChat Server running on http://localhost:${PORT}`);
      console.log(`WebSocket running on ws://localhost:${PORT}/ws`);
    });
  })
  .catch((err) => {
    console.error("FATAL: Failed to initialize PostgreSQL database:", err);
  });