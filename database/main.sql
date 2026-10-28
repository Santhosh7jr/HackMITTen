-- Active: 1791805211089@@127.0.0.1@5432@hackmitten
-- PostgreSQL Schema for Chatvia Application
-- Configure the PostgreSQL connection with PG_HOST, PG_PORT, PG_USER,
-- PG_PASSWORD, and PG_DATABASE.

CREATE DATABASE hackmitten;

-- 1. Users Table
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

-- Store only the encrypted InspireFace template, never the source camera image.
CREATE TABLE IF NOT EXISTS face_biometrics (
    user_id VARCHAR(64) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    template_ciphertext BYTEA NOT NULL,
    nonce BYTEA NOT NULL,
    auth_tag BYTEA NOT NULL,
    algorithm VARCHAR(64) NOT NULL,
    consented_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- 2. Friend Requests Table
CREATE TABLE IF NOT EXISTS friend_requests (
    id VARCHAR(64) PRIMARY KEY,
    sender_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
    receiver_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sender_id, receiver_id)
);

-- A shared secret is never stored in plaintext; only its salted verifier is kept.
CREATE TABLE IF NOT EXISTS friendship_secrets (
    friendship_id VARCHAR(64) PRIMARY KEY REFERENCES friend_requests(id) ON DELETE CASCADE,
    salt BYTEA NOT NULL,
    secret_hash BYTEA NOT NULL,
    set_by VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    confirmed_by VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
    confirmed_at TIMESTAMP WITH TIME ZONE
);

-- 3. Messages Table with File and Image Support
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

-- Uploaded file content is stored in PostgreSQL rather than on disk.
CREATE TABLE IF NOT EXISTS attachments (
    id VARCHAR(64) PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    content_type VARCHAR(255) NOT NULL,
    file_data BYTEA NOT NULL,
    file_size BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Save the original PNG until the receiver decrypts successfully once.
CREATE TABLE IF NOT EXISTS stego_messages (
    message_id VARCHAR(64) PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    attachment_id VARCHAR(64) NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    original_png BYTEA,
    consumed_at TIMESTAMP WITH TIME ZONE
);

-- Runtime startup also applies this migration for databases created from older schemas.
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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_pair_pg ON messages (sender_id, receiver_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_users_id_code ON users (user_id_code);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_friend_requests_pair ON friend_requests (sender_id, receiver_id, status);
CREATE INDEX IF NOT EXISTS idx_attachments_owner_id ON attachments (owner_id);
