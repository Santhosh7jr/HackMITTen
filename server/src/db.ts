import dotenv from "dotenv";
import pkg from "pg";
const { Pool } = pkg;
import crypto from "crypto";
import { fileURLToPath } from "url";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

// PostgreSQL Pool Connection
export const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: Number(process.env.PG_PORT) || 5432,
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || "postgres",
});

export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function generateUserIdCode(): string {
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `UID-${randomNum}`;
}

export async function initDatabase() {
  const client = await pool.connect();
  try {
    // 1. Create tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        user_id_code VARCHAR(32) UNIQUE NOT NULL,
        username VARCHAR(64) UNIQUE NOT NULL,
        email VARCHAR(128) UNIQUE NOT NULL,
        full_name VARCHAR(128) NOT NULL,
        password_hash VARCHAR(128) NOT NULL,
        avatar TEXT,
        bio TEXT DEFAULT 'Hey there! I am using Chatvia.',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS face_biometrics (
        user_id VARCHAR(64) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        template_ciphertext BYTEA NOT NULL,
        nonce BYTEA NOT NULL,
        auth_tag BYTEA NOT NULL,
        algorithm VARCHAR(64) NOT NULL,
        consented_at TIMESTAMP WITH TIME ZONE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS friend_requests (
        id VARCHAR(64) PRIMARY KEY,
        sender_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
        receiver_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(sender_id, receiver_id)
      );

      CREATE TABLE IF NOT EXISTS friendship_secrets (
        friendship_id VARCHAR(64) PRIMARY KEY REFERENCES friend_requests(id) ON DELETE CASCADE,
        salt BYTEA NOT NULL,
        secret_hash BYTEA NOT NULL,
        set_by VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        confirmed_by VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
        confirmed_at TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(64) PRIMARY KEY,
        sender_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
        receiver_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        message_type VARCHAR(20) DEFAULT 'text' CHECK(message_type IN ('text', 'image', 'file')),
        file_url TEXT,
        file_name VARCHAR(255),
        file_size VARCHAR(64),
        is_secure BOOLEAN NOT NULL DEFAULT FALSE,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_secure BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE TABLE IF NOT EXISTS attachments (
        id VARCHAR(64) PRIMARY KEY,
        owner_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        content_type VARCHAR(255) NOT NULL,
        file_data BYTEA NOT NULL,
        file_size BIGINT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS stego_messages (
        message_id VARCHAR(64) PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        attachment_id VARCHAR(64) NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        original_png BYTEA,
        consumed_at TIMESTAMP WITH TIME ZONE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_pair_pg ON messages (sender_id, receiver_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_users_id_code ON users (user_id_code);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
      CREATE INDEX IF NOT EXISTS idx_attachments_owner_id ON attachments (owner_id);
    `);

    await client.query(`
      ALTER TABLE stego_messages
        ADD COLUMN IF NOT EXISTS attachment_id VARCHAR(64);

      ALTER TABLE stego_messages
        ALTER COLUMN original_png DROP NOT NULL;

      UPDATE stego_messages sm
      SET attachment_id = a.id
      FROM messages m
      JOIN attachments a
        ON a.file_name = m.id || '.png'
        OR m.file_url = '/api/files/' || a.id
      WHERE sm.message_id = m.id
        AND sm.attachment_id IS NULL;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'stego_messages_attachment_id_fkey'
            AND conrelid = 'stego_messages'::regclass
        ) THEN
          ALTER TABLE stego_messages
            ADD CONSTRAINT stego_messages_attachment_id_fkey
            FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM stego_messages WHERE attachment_id IS NULL
        ) THEN
          ALTER TABLE stego_messages
            ALTER COLUMN attachment_id SET NOT NULL;
        END IF;
      END $$;
    `);

    await client.query(
      `DELETE FROM users
       WHERE id IN ('u_doris', 'u_patrick', 'u_steve', 'u_mark', 'u_emily')`
    );

    console.log("PostgreSQL database initialized successfully.");
  } finally {
    client.release();
  }
}
