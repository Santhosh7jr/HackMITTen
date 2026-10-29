# CryptChat - Real-Time Secure Messaging

CryptChat is a real-time messaging application built with React, TypeScript, Vite, Express, WebSockets, PostgreSQL, and a Python facial-recognition service using OpenCV, NumPy, and InspireFace.

## Features

- PostgreSQL stores account profiles, friend requests, messages, and uploaded file contents.
- Uploaded images and documents are stored as PostgreSQL `BYTEA` attachments, with a 25 MB per-file limit.
- Friend requests use User IDs; profiles are only revealed when a User ID is searched.
- Real-time messaging and notifications are available to accepted friends.
- Profiles can be edited after signing in.
- Registration requires camera capture and explicit consent. InspireFace checks for exactly one face and creates a recognition template; the raw camera image is not stored. Enrollment is not liveness detection or identity verification.
- Before a recipient can reveal a secure message, the app verifies one enrolled face and continues checking while the text is visible. If the check fails, the text is hidden and the one-time message remains consumed. Verification frames are processed by the configured face service and are not stored. This is not liveness detection and cannot detect people outside the camera view or prevent screenshots or recording.
- Face templates are encrypted with AES-256-GCM before being stored in PostgreSQL. Keep `FACE_ENCRYPTION_KEY` secret and back it up securely; losing it makes stored templates unreadable.
- Secure image messages use one shared passphrase per friendship, client-side AES-GCM encryption, and randomized PNG LSB steganography. PostgreSQL stores only a salted verifier for the passphrase, plus the stego image and the exact original PNG. After the recipient decrypts successfully, the stored image is restored and the saved original is cleared.
- The passphrase is entered once to set or confirm a friendship key. Each device stores the derived, non-exportable encryption key in IndexedDB and reuses it for later messages; the passphrase itself is never persisted in plaintext, sent in a JWT, or stored by the server. A new device or cleared browser storage requires unlocking the friendship key once again.
- Friendship keys can be rotated from the dedicated **Keys** page. The other friend must confirm the new passphrase before secure messaging resumes. Rotation is blocked while any one-time private image message remains unopened.

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

To send a secure image message, select **Private image message**, set one passphrase for the friendship, and have the other friend confirm it once. Each device saves the derived key so it is reused without prompting for every message. Choose a PNG and enter the text; the encrypted payload is hidden in the PNG before it is saved. The recipient selects the image's small decrypt control. A failed initial face check does not consume the message. After a successful decrypt, the app keeps the text visible only while the enrolled face remains alone in view; a failed check hides the text. The application restores the original PNG in PostgreSQL and removes the saved recovery copy.

Restoration and removal are logical database operations, not a guarantee of forensic erasure: PostgreSQL write-ahead logs, replicas, or backups may retain earlier data until their retention policies expire.
