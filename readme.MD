# Chatvia - Real-Time Multi-User Chat Application

Chatvia is a real-time chat application built with React, TypeScript, Vite, Express, WebSockets, PostgreSQL, and a Python facial-enrollment service using OpenCV, NumPy, and InspireFace.

## Features

- PostgreSQL stores account profiles, friend requests, messages, and uploaded file contents.
- Uploaded images and documents are stored as PostgreSQL `BYTEA` attachments, with a 25 MB per-file limit.
- Friend requests use User IDs; profiles are only revealed when a User ID is searched.
- Real-time messaging and notifications are available to accepted friends.
- Profiles can be edited after signing in.
- Registration requires camera capture and explicit consent. InspireFace checks for exactly one face and creates a recognition template; the raw camera image is not stored. Enrollment is not liveness detection or identity verification.
- Face templates are encrypted with AES-256-GCM before being stored in PostgreSQL. Keep `FACE_ENCRYPTION_KEY` secret and back it up securely; losing it makes stored templates unreadable.
- Secure image messages use a per-friend shared passphrase, client-side AES-GCM encryption, and randomized PNG LSB steganography. PostgreSQL stores the stego image and the exact original PNG; after the recipient decrypts successfully, the stored image is restored and the saved original is cleared.
- The shared passphrase is never stored in plaintext or placed in a JWT. PostgreSQL keeps a salted scrypt verifier; JWTs authenticate secure-message requests.

## Run locally

The backend loads its configuration from `server/.env`. A local, ignored `.env` file is provided for this checkout; for a fresh clone, copy the template and generate the two secrets once:

```powershell
cd server
if (Test-Path .env) { throw "server/.env already exists; keep the existing keys." }
Copy-Item .env.example .env
$jwtBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($jwtBytes)
$faceBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($faceBytes)
$envFile = [System.IO.File]::ReadAllText((Join-Path $PWD ".env"))
$envFile = $envFile.Replace("replace-with-a-private-random-secret-at-least-32-bytes", [Convert]::ToBase64String($jwtBytes))
$envFile = $envFile.Replace("replace-with-base64-encoded-32-byte-key", [Convert]::ToBase64String($faceBytes))
[System.IO.File]::WriteAllText((Join-Path $PWD ".env"), $envFile, [System.Text.UTF8Encoding]::new($false))
```

Set `PG_PASSWORD` in `server/.env` to your PostgreSQL password. Keep both generated keys private and unchanged across restarts; changing them invalidates login tokens or makes existing face templates unreadable. `.env` is ignored by Git. The server creates the required tables and migrates older secure-message schemas on startup.

In a second terminal, install and start the facial-enrollment and steganography service:

```powershell
cd api
if (-not (Test-Path .venv)) { uv venv --python 3.12 .venv }
uv pip install --python .\.venv\Scripts\python.exe -r requirements.txt
.\.venv\Scripts\python -m uvicorn app:app --host 127.0.0.1 --port 8001
```

Use Python 3.12 for this service because InspireFace does not publish compatible wheels for every Python version.

The service downloads InspireFace's model on first use. The upstream project states its models are for academic use only and prohibit commercial applications; confirm the current license and platform requirements before deployment.

Start the backend in the first terminal, from the `server` directory so `.env` is loaded:

```powershell
cd server
npm install
npm run dev
```

The backend runs at `http://localhost:5000` with WebSockets at `ws://localhost:5000/ws`.

Start the frontend in a third terminal:

```powershell
cd client
npm install
npm run dev
```

The frontend runs at `http://localhost:5173`. Create an account with **Sign Up** to get started. Signing out or refreshing the page requires signing in again; account and chat data remain in PostgreSQL.

To send a secure image message, select **Secure image + text**, set a shared passphrase with a friend, and have the other friend confirm the same passphrase. Choose a PNG and enter the text; the encrypted payload is hidden in the PNG before it is saved. The recipient must enter the passphrase and select **Decrypt once**. A wrong passphrase does not consume the message. After a successful decrypt, the application restores the original PNG in PostgreSQL and removes the saved recovery copy.

Restoration and removal are logical database operations, not a guarantee of forensic erasure: PostgreSQL write-ahead logs, replicas, or backups may retain earlier data until their retention policies expire.
