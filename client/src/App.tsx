import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import './App.css';

interface User {
  id: string;
  userIdCode: string;
  username: string;
  email: string;
  fullName: string;
  avatar: string;
  bio?: string;
  online?: boolean;
  lastMessage?: string | null;
  lastMessageTime?: string | null;
}

interface Message {
  id: string;
  senderId: string;
  receiverId: string;
  content: string;
  messageType?: 'text' | 'image' | 'file';
  fileUrl?: string | null;
  fileName?: string | null;
  fileSize?: string | null;
  isSecure?: boolean;
  secureConsumed?: boolean;
  timestamp: string;
}

interface SecureKeyStatus {
  configured: boolean;
  ready: boolean;
  setByMe: boolean;
  confirmedByMe: boolean;
  confirmed: boolean;
  salt: string | null;
}

function openSecureKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cryptchat-secure-keys', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('keys');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open secure key storage.'));
    request.onblocked = () => reject(new Error('Secure key storage is blocked by another tab.'));
  });
}

async function loadCachedSecureKey(cacheId: string): Promise<CryptoKey | null> {
  const database = await openSecureKeyDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction('keys', 'readonly').objectStore('keys').get(cacheId);
      request.onsuccess = () => resolve((request.result as CryptoKey | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Could not load the saved secure key.'));
    });
  } finally {
    database.close();
  }
}

async function saveCachedSecureKey(cacheId: string, key: CryptoKey): Promise<void> {
  const database = await openSecureKeyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('keys', 'readwrite');
      transaction.objectStore('keys').put(key, cacheId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save the secure key.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Secure key storage was interrupted.'));
    });
  } finally {
    database.close();
  }
}

function secureKeyCacheId(userId: string, friendId: string, salt: string): string {
  return `${userId}:${friendId}:${salt}`;
}

interface FriendRequestItem {
  id: string;
  senderId?: string;
  receiverId?: string;
  userIdCode?: string;
  username: string;
  fullName: string;
  avatar: string;
  createdAt: string;
}

interface FoundUser {
  id: string;
  userIdCode: string;
  username: string;
  fullName: string;
  avatar: string;
  bio?: string;
  online: boolean;
  relationship: 'friends' | 'pending_sent' | 'pending_received' | 'none';
}

function playChime() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    // Ignore audio restrictions
  }
}

const EMOJI_LIST = [
  '😀', '😂', '🥹', '😍', '😎', '🥳', '🤔',
  '😴', '🤐', '🙄', '👍', '👏', '🙌', '🙏',
  '🔥', '❤️', '💖', '✨', '🎉', '🚀', '💬',
  '☕', '💻', '🍕', '⭐', '🎈', '👋', '💯'
];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function captureCameraFrame(stream: MediaStream): Promise<string> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadeddata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('Camera frame is unavailable.')), {
        once: true,
      });
    });
  }

  const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (!context || canvas.width === 0 || canvas.height === 0) {
    throw new Error('Camera frame is unavailable.');
  }

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const encoded = canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
  video.pause();
  video.srcObject = null;
  canvas.width = 0;
  canvas.height = 0;
  if (!encoded) throw new Error('Camera frame is unavailable.');
  return encoded;
}

async function verifySecureViewer(
  messageId: string,
  stream: MediaStream,
  accessToken: string
): Promise<boolean> {
  const imageBase64 = await captureCameraFrame(stream);
  const response = await fetch(
    `/api/secure/messages/${encodeURIComponent(messageId)}/verify-face`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ imageBase64 }),
      cache: 'no-store',
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Facial verification is unavailable.');
  }
  return data.verified === true;
}

async function deriveSecureMessageKey(secret: string, saltBase64: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(new TextEncoder().encode(secret)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(base64ToBytes(saltBase64)),
      iterations: 310_000,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function getSecureMessageKey(
  secret: string,
  salt: string,
  cacheId: string
): Promise<CryptoKey> {
  const cachedKey = await loadCachedSecureKey(cacheId);
  if (cachedKey) return cachedKey;
  if (!secret) throw new Error('Unlock this friendship key on this device to continue.');
  const key = await deriveSecureMessageKey(secret, salt);
  await saveCachedSecureKey(cacheId, key);
  return key;
}

function secureMessageAad(userId1: string, userId2: string): ArrayBuffer {
  return toArrayBuffer(
    new TextEncoder().encode(`chatvia-secure-v1:${[userId1, userId2].sort().join(':')}`)
  );
}

interface ChatViewPanelProps {
  currentUser: User;
  accessToken: string;
  onLogout?: () => void;
  onUserUpdate?: (updatedUser: User) => void;
}

function ChatViewPanel({
  currentUser,
  accessToken,
  onLogout,
  onUserUpdate,
}: ChatViewPanelProps) {
  const [activeTab, setActiveTab] = useState<'chats' | 'friends' | 'profile' | 'key-settings'>('chats');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // Friends & Requests
  const [friends, setFriends] = useState<User[]>([]);
  const [pendingIncoming, setPendingIncoming] = useState<FriendRequestItem[]>([]);
  const [pendingOutgoing, setPendingOutgoing] = useState<FriendRequestItem[]>([]);

  // Active chat
  const [activeContact, setActiveContact] = useState<User | null>(null);
  const activeContactId = activeContact?.id;
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageAllowed, setMessageAllowed] = useState(true);
  const [imagePreview, setImagePreview] = useState<{ src: string; alt: string } | null>(null);

  // Inputs
  const [inputVal, setInputVal] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [targetIdInput, setTargetIdInput] = useState('');
  const [foundUser, setFoundUser] = useState<FoundUser | null>(null);
  const [searchingId, setSearchingId] = useState(false);
  const [idActionMsg, setIdActionMsg] = useState<{ text: string; isError: boolean } | null>(null);

  // Profile Edit
  const [editingProfile, setEditingProfile] = useState(false);
  const [editFullName, setEditFullName] = useState(currentUser.fullName);
  const [editBio, setEditBio] = useState(currentUser.bio || '');
  const [idCopied, setIdCopied] = useState(false);

  // Emoji & Uploads
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [secureMode, setSecureMode] = useState(false);
  const [securePassphrase, setSecurePassphrase] = useState('');
  const [secureKeyStatus, setSecureKeyStatus] = useState<SecureKeyStatus | null>(null);
  const [secureKeyRefresh, setSecureKeyRefresh] = useState(0);
  const [secureKeyError, setSecureKeyError] = useState('');
  const [secureKeyAvailable, setSecureKeyAvailable] = useState(false);
  const [keyUpdateCurrent, setKeyUpdateCurrent] = useState('');
  const [keyUpdateNext, setKeyUpdateNext] = useState('');
  const [keyUpdateBusy, setKeyUpdateBusy] = useState(false);
  const [keyUpdateError, setKeyUpdateError] = useState('');
  const [keyUpdateMessage, setKeyUpdateMessage] = useState('');
  const [secureImage, setSecureImage] = useState<File | null>(null);
  const [secureImageUrls, setSecureImageUrls] = useState<Record<string, string>>({});
  const [revealedSecureMessages, setRevealedSecureMessages] = useState<Record<string, string>>({});
  const [secureProcessingId, setSecureProcessingId] = useState<string | null>(null);
  const [activeSecureRevealId, setActiveSecureRevealId] = useState<string | null>(null);
  const [secureCameraStream, setSecureCameraStream] = useState<MediaStream | null>(null);
  const secureImageInputRef = useRef<HTMLInputElement | null>(null);
  const secureCameraStreamRef = useRef<MediaStream | null>(null);
  const secureCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const activeContactRef = useRef<User | null>(activeContact);

  // Typing
  const [otherIsTyping, setOtherIsTyping] = useState(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const wsAuthenticatedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    activeContactRef.current = activeContact;
  }, [activeContact]);

  const stopSecureCamera = useCallback(() => {
    const stream = secureCameraStreamRef.current;
    secureCameraStreamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    setSecureCameraStream(null);
  }, []);

  const clearSecureReveal = useCallback(() => {
    setRevealedSecureMessages({});
    setActiveSecureRevealId(null);
    stopSecureCamera();
  }, [stopSecureCamera]);

  const handleSelectContact = (contact: User) => {
    clearSecureReveal();
    setSecurePassphrase('');
    setSecureImage(null);
    setSecureKeyStatus(null);
    setSecureKeyAvailable(false);
    setSecureKeyError('');
    setKeyUpdateCurrent('');
    setKeyUpdateNext('');
    setKeyUpdateError('');
    setKeyUpdateMessage('');
    if (secureImageInputRef.current) secureImageInputRef.current.value = '';
    setMessages([]);
    setOtherIsTyping(false);
    setActiveContact(contact);
    setMessageAllowed(true);
    setMobileChatOpen(true);
  };

  const navigateToTab = (tab: 'chats' | 'friends' | 'profile' | 'key-settings') => {
    if (tab !== 'chats') {
      clearSecureReveal();
      setMobileChatOpen(false);
      setSecurePassphrase('');
    }
    if (tab !== 'key-settings') {
      setKeyUpdateCurrent('');
      setKeyUpdateNext('');
    }
    setActiveTab(tab);
  };

  const handleMobileChatBack = () => {
    clearSecureReveal();
    setMobileChatOpen(false);
  };

  const toggleTheme = () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, otherIsTyping]);

  useEffect(() => {
    const video = secureCameraVideoRef.current;
    if (video && secureCameraStream) {
      video.srcObject = secureCameraStream;
      void video.play().catch((error: unknown) => {
        console.error('Secure camera preview could not start:', error);
        clearSecureReveal();
      });
    }
    return () => {
      if (video) video.srcObject = null;
    };
  }, [secureCameraStream, activeSecureRevealId, clearSecureReveal]);

  useEffect(() => () => {
    secureCameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    secureCameraStreamRef.current = null;
  }, []);

  useEffect(() => {
    if (!activeSecureRevealId || !secureCameraStream) return;

    let stopped = false;
    let nextCheck: number | undefined;
    const concealMessage = () => {
      if (stopped) return;
      stopped = true;
      if (nextCheck !== undefined) window.clearTimeout(nextCheck);
      setRevealedSecureMessages((previous) => {
        const remaining = { ...previous };
        delete remaining[activeSecureRevealId];
        return remaining;
      });
      setActiveSecureRevealId(null);
      if (secureCameraStreamRef.current === secureCameraStream) {
        secureCameraStreamRef.current = null;
        secureCameraStream.getTracks().forEach((track) => track.stop());
        setSecureCameraStream(null);
      }
    };

    const checkViewer = async () => {
      if (document.visibilityState !== 'visible') {
        concealMessage();
        return;
      }

      try {
        if (!(await verifySecureViewer(activeSecureRevealId, secureCameraStream, accessToken))) {
          concealMessage();
          return;
        }
      } catch (error) {
        console.error('Secure message face check failed:', error);
        concealMessage();
        return;
      }

      if (!stopped) nextCheck = window.setTimeout(checkViewer, 1000);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') concealMessage();
    };
    const videoTrack = secureCameraStream.getVideoTracks()[0];
    document.addEventListener('visibilitychange', handleVisibilityChange);
    videoTrack?.addEventListener('ended', concealMessage);
    void checkViewer();

    return () => {
      stopped = true;
      if (nextCheck !== undefined) window.clearTimeout(nextCheck);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      videoTrack?.removeEventListener('ended', concealMessage);
    };
  }, [activeSecureRevealId, secureCameraStream, accessToken]);

  useEffect(() => {
    if (!imagePreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImagePreview(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [imagePreview]);

  // Load Friends Data
  const loadFriendsData = useCallback(async () => {
    try {
      const res = await fetch(`/api/friends?userId=${currentUser.id}`);
      if (res.ok) {
        const data = await res.json();
        setFriends(data.friends || []);
        setPendingIncoming(data.pendingIncoming || []);
        setPendingOutgoing(data.pendingOutgoing || []);

        if (!activeContactRef.current && data.friends && data.friends.length > 0) {
          setActiveContact(data.friends[0]);
        }
      }
    } catch (err) {
      console.error('Failed to load friends:', err);
    }
  }, [currentUser.id]);

  useEffect(() => {
    const request = window.setTimeout(() => {
      void loadFriendsData();
    }, 0);
    return () => window.clearTimeout(request);
  }, [loadFriendsData]);

  // Load conversation messages
  useEffect(() => {
    if (!activeContactId) {
      return;
    }

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/messages?user1=${currentUser.id}&user2=${activeContactId}`);
        const data = await res.json();
        if (res.ok && data.allowed) {
          setMessages(data.messages || []);
          setMessageAllowed(true);
        } else {
          setMessages([]);
          setMessageAllowed(false);
        }
      } catch (err) {
        console.error('Failed to fetch messages:', err);
      }
    };

    fetchMessages();
  }, [activeContactId, currentUser.id]);

  useEffect(() => {
    if (!activeContactId) return;

    const controller = new AbortController();
    fetch(`/api/friends/${encodeURIComponent(activeContactId)}/secure-key`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load shared key status.');
        setSecureKeyStatus(data);
        setSecureKeyError('');
        if (data.ready && data.salt) {
          const cachedKey = await loadCachedSecureKey(
            secureKeyCacheId(currentUser.id, activeContactId, data.salt)
          );
          if (!controller.signal.aborted) setSecureKeyAvailable(Boolean(cachedKey));
        } else if (!controller.signal.aborted) {
          setSecureKeyAvailable(false);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('Secure key status error:', err);
        setSecureKeyError(err instanceof Error ? err.message : 'Could not load shared key status.');
      });

    return () => controller.abort();
  }, [activeContactId, accessToken, currentUser.id, secureKeyRefresh]);

  useEffect(() => {
    if (!activeContactId) return;
    const pollId = window.setInterval(
      () => setSecureKeyRefresh((refresh) => refresh + 1),
      5000
    );
    return () => window.clearInterval(pollId);
  }, [activeContactId]);

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    const secureMessages = messages.filter((message) => message.isSecure);
    Promise.all(
      secureMessages.map(async (message) => {
        const res = await fetch(`/api/secure/messages/${encodeURIComponent(message.id)}/image`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`Could not load secure image ${message.id}.`);
        return [message.id, URL.createObjectURL(await res.blob())] as const;
      })
    )
      .then((entries) => {
        if (!active) {
          entries.forEach(([, url]) => URL.revokeObjectURL(url));
          return;
        }
        objectUrls.push(...entries.map(([, url]) => url));
        setSecureImageUrls(Object.fromEntries(entries));
      })
      .catch((err: unknown) => console.error('Secure image load error:', err));

    return () => {
      active = false;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [messages, accessToken]);

  // WebSocket lifecycle
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;
    let disposed = false;
    let retryTimer: number | undefined;
    let retryDelay = 1000;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(wsUrl);
      ws = socket;
      wsRef.current = socket;
      wsAuthenticatedRef.current = false;
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'authenticate', token: accessToken }));
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'presence_snapshot' && Array.isArray(data.onlineUserIds)) {
            const onlineIds = new Set<string>(
              data.onlineUserIds.filter((id: unknown): id is string => typeof id === 'string')
            );
            wsAuthenticatedRef.current = true;
            retryDelay = 1000;
            setFriends((previous) =>
              previous.map((friend) => ({ ...friend, online: onlineIds.has(friend.id) }))
            );
            setActiveContact((previous) =>
              previous ? { ...previous, online: onlineIds.has(previous.id) } : null
            );
            const contact = activeContactRef.current;
            if (contact) {
              fetch(
                `/api/messages?user1=${encodeURIComponent(currentUser.id)}&user2=${encodeURIComponent(contact.id)}`
              )
                .then(async (response) => {
                  const result = await response.json();
                  if (
                    response.ok &&
                    result.allowed &&
                    activeContactRef.current?.id === contact.id
                  ) {
                    setMessages(result.messages || []);
                  }
                })
                .catch((error: unknown) =>
                  console.error('Conversation refresh after reconnect failed:', error)
                );
            }
          } else if (data.type === 'new_message') {
            const msg: Message = data.message;
            const contactId = activeContactRef.current?.id;
            if (
              (msg.senderId === contactId && msg.receiverId === currentUser.id) ||
              (msg.senderId === currentUser.id && msg.receiverId === contactId)
            ) {
              setMessages((previous) =>
                previous.some((item) => item.id === msg.id) ? previous : [...previous, msg]
              );
              if (msg.senderId === contactId) playChime();
            }

            setFriends((previous) =>
              previous.map((friend) => {
                if (friend.id === msg.senderId || friend.id === msg.receiverId) {
                  let preview = msg.content;
                  if (msg.isSecure || msg.messageType === 'image') preview = '📷 Photo';
                  else if (msg.messageType === 'file') preview = `📄 ${msg.fileName || 'File'}`;
                  return { ...friend, lastMessage: preview, lastMessageTime: msg.timestamp };
                }
                return friend;
              })
            );
          } else if (data.type === 'secure_message_consumed') {
            setMessages((previous) =>
              previous.map((message) =>
                message.id === data.messageId
                  ? { ...message, secureConsumed: true }
                  : message
              )
            );
            setSecureImageUrls((previous) => {
              const next = { ...previous };
              const staleUrl = next[data.messageId];
              if (staleUrl) URL.revokeObjectURL(staleUrl);
              delete next[data.messageId];
              return next;
            });
          } else if (data.type === 'user_status' && typeof data.online === 'boolean') {
            setFriends((previous) =>
              previous.map((friend) =>
                friend.id === data.userId ? { ...friend, online: data.online } : friend
              )
            );
            setActiveContact((previous) =>
              previous && previous.id === data.userId
                ? { ...previous, online: data.online }
                : previous
            );
          } else if (data.type === 'typing_indicator') {
            if (data.senderId === activeContactRef.current?.id) {
              setOtherIsTyping(data.isTyping);
            }
          } else if (
            data.type === 'friend_request_received' ||
            data.type === 'friend_request_accepted'
          ) {
            playChime();
            loadFriendsData();
          }
        } catch (err) {
          console.error('WebSocket message error:', err);
        }
      };

      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (wsRef.current === socket) wsRef.current = null;
        wsAuthenticatedRef.current = false;
        if (disposed) return;
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      wsAuthenticatedRef.current = false;
      if (wsRef.current === ws) wsRef.current = null;
      ws?.close();
    };
  }, [currentUser.id, accessToken, loadFriendsData]);

  // Lookup User by User ID ("do not shows the user name until they enter the user id")
  const handleLookupUserId = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = targetIdInput.trim().toUpperCase();
    if (!code) return;

    setIdActionMsg(null);
    setFoundUser(null);
    setSearchingId(true);

    try {
      const res = await fetch(`/api/users/lookup?userIdCode=${encodeURIComponent(code)}&currentUserId=${currentUser.id}`);
      const data = await res.json();
      if (!res.ok) {
        setIdActionMsg({ text: data.error || 'User not found.', isError: true });
      } else {
        setFoundUser(data.user);
      }
    } catch {
      setIdActionMsg({ text: 'Error searching for user ID.', isError: true });
    } finally {
      setSearchingId(false);
    }
  };

  // Send Friend Request
  const handleSendFriendRequest = async (targetCode: string) => {
    setIdActionMsg(null);
    try {
      const res = await fetch('/api/friends/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderId: currentUser.id,
          targetIdCode: targetCode,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setIdActionMsg({ text: data.message, isError: false });
        if (foundUser) {
          setFoundUser({ ...foundUser, relationship: 'pending_sent' });
        }
        loadFriendsData();
      } else {
        setIdActionMsg({ text: data.error || 'Failed to send friend request.', isError: true });
      }
    } catch {
      setIdActionMsg({ text: 'Could not connect to server.', isError: true });
    }
  };

  // Respond to Friend Request (Accept / Reject)
  const handleRespondFriendRequest = async (requestId: string, action: 'accept' | 'reject') => {
    setIdActionMsg(null);
    try {
      const res = await fetch('/api/friends/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, action, userId: currentUser.id }),
      });

      const data = await res.json();
      if (res.ok) {
        setIdActionMsg({ text: data.message, isError: false });
        loadFriendsData();
      } else {
        setIdActionMsg({ text: data.error || 'Action failed.', isError: true });
      }
    } catch {
      setIdActionMsg({ text: 'Could not connect to server.', isError: true });
    }
  };

  // Send Text Message
  const handleSendMessage = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = inputVal.trim();
    if (!text || !activeContact || !messageAllowed) return;

    setInputVal('');
    setShowEmojiPicker(false);

    if (wsAuthenticatedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'send_message',
          receiverId: activeContact.id,
          content: text,
          messageType: 'text',
        })
      );
    } else {
      fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderId: currentUser.id,
          receiverId: activeContact.id,
          content: text,
          messageType: 'text',
        }),
      });
    }
  };

  // Upload File or Image
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeContact || !messageAllowed) return;

    setUploading(true);
    setUploadError('');
    const formData = new FormData();
    formData.append('userId', currentUser.id);
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const uploadData = await res.json();
      if (!res.ok) {
        throw new Error(uploadData.error || 'Failed to upload file.');
      }

      if (wsAuthenticatedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'send_message',
            receiverId: activeContact.id,
            content: uploadData.messageType === 'image' ? 'Photo' : uploadData.fileName,
            messageType: uploadData.messageType,
            fileUrl: uploadData.fileUrl,
            fileName: uploadData.fileName,
            fileSize: uploadData.fileSize,
          })
        );
      } else {
        const messageRes = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            senderId: currentUser.id,
            receiverId: activeContact.id,
            content: uploadData.messageType === 'image' ? 'Photo' : uploadData.fileName,
            messageType: uploadData.messageType,
            fileUrl: uploadData.fileUrl,
            fileName: uploadData.fileName,
            fileSize: uploadData.fileSize,
          }),
        });
        if (!messageRes.ok) {
          const messageData = await messageRes.json();
          throw new Error(messageData.error || 'Failed to send file.');
        }
      }
    } catch (err) {
      console.error('File upload error:', err);
      setUploadError(err instanceof Error ? err.message : 'Failed to upload file.');
    } finally {
      setUploading(false);
      if (e.target) e.target.value = '';
    }
  };

  const handleSecureImageSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'image/png' || file.size > 8 * 1024 * 1024) {
      setSecureImage(null);
      setUploadError('Secure image messages require a PNG smaller than 8 MB.');
      e.target.value = '';
      return;
    }

    try {
      const bitmap = await createImageBitmap(file);
      const validDimensions = bitmap.width * bitmap.height <= 2_500_000;
      bitmap.close();
      if (!validDimensions) {
        setSecureImage(null);
        setUploadError('The PNG must contain no more than 2.5 megapixels.');
        e.target.value = '';
        return;
      }
      setUploadError('');
      setSecureImage(file);
    } catch (err) {
      console.error('Secure PNG validation error:', err);
      setSecureImage(null);
      setUploadError('Could not read the selected PNG image.');
      e.target.value = '';
    }
  };

  const handleSetSecureKey = async () => {
    if (!activeContact || !securePassphrase) return;
    setUploadError('');
    try {
      const res = await fetch(
        `/api/friends/${encodeURIComponent(activeContact.id)}/secure-key`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ secret: securePassphrase }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not set the shared passphrase.');
      if (typeof data.salt !== 'string') throw new Error('The server did not return the friendship key salt.');
      const key = await deriveSecureMessageKey(securePassphrase, data.salt);
      await saveCachedSecureKey(
        secureKeyCacheId(currentUser.id, activeContact.id, data.salt),
        key
      );
      setSecureKeyStatus({
        configured: true,
        ready: Boolean(data.ready),
        setByMe: Boolean(data.setByMe),
        confirmedByMe: Boolean(data.confirmedByMe),
        confirmed: Boolean(data.confirmed),
        salt: data.salt,
      });
      setSecureKeyAvailable(true);
      setSecurePassphrase('');
      setSecureKeyError('');
      setUploadError(data.message || '');
    } catch (err) {
      console.error('Secure key setup error:', err);
      setUploadError(err instanceof Error ? err.message : 'Could not set shared passphrase.');
    }
  };

  const handleUnlockSecureKey = async () => {
    if (!activeContact || !securePassphrase) return;
    setUploadError('');
    try {
      const res = await fetch(
        `/api/friends/${encodeURIComponent(activeContact.id)}/secure-key/verify`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ secret: securePassphrase }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not unlock the shared passphrase.');
      if (data.valid !== true || data.salt !== secureKeyStatus?.salt) {
        throw new Error('That passphrase does not match this friendship.');
      }
      const key = await deriveSecureMessageKey(securePassphrase, data.salt);
      await saveCachedSecureKey(
        secureKeyCacheId(currentUser.id, activeContact.id, data.salt),
        key
      );
      setSecureKeyAvailable(true);
      setSecurePassphrase('');
    } catch (err) {
      console.error('Secure key unlock error:', err);
      setUploadError(err instanceof Error ? err.message : 'Could not unlock the shared passphrase.');
    }
  };

  const handleRotateSecureKey = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeContact || !secureKeyStatus?.ready) return;
    setKeyUpdateBusy(true);
    setKeyUpdateError('');
    setKeyUpdateMessage('');
    try {
      const res = await fetch(
        `/api/friends/${encodeURIComponent(activeContact.id)}/secure-key/rotate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            currentSecret: keyUpdateCurrent,
            newSecret: keyUpdateNext,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not update the shared passphrase.');
      if (typeof data.salt !== 'string') throw new Error('The server did not return the new friendship key salt.');
      const key = await deriveSecureMessageKey(keyUpdateNext, data.salt);
      await saveCachedSecureKey(
        secureKeyCacheId(currentUser.id, activeContact.id, data.salt),
        key
      );
      setSecureKeyStatus({
        configured: true,
        ready: false,
        setByMe: true,
        confirmedByMe: false,
        confirmed: false,
        salt: data.salt,
      });
      setSecureKeyAvailable(true);
      setKeyUpdateCurrent('');
      setKeyUpdateNext('');
      setKeyUpdateMessage(data.message || 'The new passphrase is saved. Your friend must confirm it.');
    } catch (err) {
      console.error('Secure key update error:', err);
      setKeyUpdateError(err instanceof Error ? err.message : 'Could not update the shared passphrase.');
    } finally {
      setKeyUpdateBusy(false);
    }
  };

  const handleSecureMessageSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !activeContact ||
      !secureKeyStatus?.ready ||
      !secureKeyStatus.salt ||
      !secureImage ||
      !inputVal.trim()
    ) {
      setUploadError('A confirmed shared key, PNG image, and text are required.');
      return;
    }

    setUploading(true);
    setUploadError('');
    try {
      const key = await getSecureMessageKey(
        '',
        secureKeyStatus.salt,
        secureKeyCacheId(currentUser.id, activeContact.id, secureKeyStatus.salt)
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encryptedText = new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: toArrayBuffer(iv),
            additionalData: secureMessageAad(currentUser.id, activeContact.id),
          },
          key,
          toArrayBuffer(new TextEncoder().encode(inputVal.trim()))
        )
      );
      const payload = new Uint8Array(iv.length + encryptedText.length);
      payload.set(iv);
      payload.set(encryptedText, iv.length);
      const imageBase64 = bytesToBase64(
        new Uint8Array(await secureImage.arrayBuffer())
      );

      const res = await fetch('/api/secure/messages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          friendId: activeContact.id,
          keySalt: secureKeyStatus.salt,
          imageBase64,
          payloadBase64: bytesToBase64(payload),
        }),
      });
      const data = await res.json();
      payload.fill(0);
      encryptedText.fill(0);
      if (!res.ok) throw new Error(data.error || 'Failed to send secure image.');

      setMessages((previous) =>
        previous.some((message) => message.id === data.message.id)
          ? previous
          : [...previous, data.message]
      );
      setInputVal('');
      setSecureImage(null);
      setShowEmojiPicker(false);
      if (secureImageInputRef.current) secureImageInputRef.current.value = '';
    } catch (err) {
      console.error('Secure message send error:', err);
      setUploadError(err instanceof Error ? err.message : 'Failed to send secure image.');
    } finally {
      setUploading(false);
    }
  };

  const handleDecryptSecureMessage = async (message: Message) => {
    if (!activeContact || !secureKeyStatus?.salt) {
      setUploadError('Set up the shared passphrase for this friendship first.');
      return;
    }

    setSecureProcessingId(message.id);
    setUploadError('');
    let stream: MediaStream | null = null;
    let revealStarted = false;
    let combined: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera access is required to reveal secure messages.');
      }
      const captureStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
      stream = captureStream;
      secureCameraStreamRef.current = captureStream;
      setSecureCameraStream(captureStream);
      if (!(await verifySecureViewer(message.id, captureStream, accessToken))) {
        throw new Error('Face check failed. The message remains unopened.');
      }

      const payloadRes = await fetch(
        `/api/secure/messages/${encodeURIComponent(message.id)}/payload`,
        { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const payloadData = await payloadRes.json();
      if (!payloadRes.ok) throw new Error(payloadData.error || 'Could not read secure message.');

      combined = base64ToBytes(payloadData.payloadBase64);
      if (combined.length < 28) throw new Error('The encrypted message is incomplete.');
      const iv = combined.slice(0, 12);
      const encryptedText = combined.slice(12);
      const key = await getSecureMessageKey(
        '',
        secureKeyStatus.salt,
        secureKeyCacheId(currentUser.id, activeContact.id, secureKeyStatus.salt)
      );
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: toArrayBuffer(iv),
            additionalData: secureMessageAad(currentUser.id, activeContact.id),
          },
          key,
          toArrayBuffer(encryptedText)
        )
      );
      const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);

      if (!(await verifySecureViewer(message.id, captureStream, accessToken))) {
        throw new Error('Face check failed. The message remains unopened.');
      }

      const consumeRes = await fetch(
        `/api/secure/messages/${encodeURIComponent(message.id)}/consume`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      const consumeData = await consumeRes.json();
      if (!consumeRes.ok) throw new Error(consumeData.error || 'This message was already viewed.');

      const liveVideoTrack = captureStream.getVideoTracks()[0];
      if (
        activeContactRef.current?.id !== activeContact.id ||
        document.visibilityState !== 'visible' ||
        liveVideoTrack?.readyState !== 'live'
      ) {
        throw new Error('The face check ended before the text could be revealed.');
      }

      setRevealedSecureMessages((previous) => ({ ...previous, [message.id]: text }));
      setMessages((previous) =>
        previous.map((item) =>
          item.id === message.id ? { ...item, secureConsumed: true } : item
        )
      );
      setActiveSecureRevealId(message.id);
      revealStarted = true;
    } catch (err) {
      console.error('Secure message decryption error:', err);
      const wrongPassphrase =
        err instanceof DOMException && err.name === 'OperationError';
      setUploadError(
        wrongPassphrase
          ? 'The passphrase is incorrect or the message was altered.'
          : err instanceof Error
            ? err.message
            : 'Could not decrypt secure message.'
      );
    } finally {
      combined?.fill(0);
      plaintext?.fill(0);
      if (!revealStarted && stream) {
        stream.getTracks().forEach((track) => track.stop());
        if (secureCameraStreamRef.current === stream) {
          secureCameraStreamRef.current = null;
          setSecureCameraStream(null);
        }
      }
      setSecureProcessingId(null);
    }
  };

  const handleSelectEmoji = (emoji: string) => {
    setInputVal((prev) => prev + emoji);
  };

  // Typing status broadcast
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputVal(e.target.value);
    if (!activeContact || !messageAllowed) return;

    if (wsAuthenticatedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'typing',
          receiverId: activeContact.id,
          isTyping: true,
        })
      );
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      if (
        wsAuthenticatedRef.current &&
        wsRef.current?.readyState === WebSocket.OPEN &&
        activeContact
      ) {
        wsRef.current.send(
          JSON.stringify({
            type: 'typing',
            receiverId: activeContact.id,
            isTyping: false,
          })
        );
      }
    }, 1500);
  };

  // Update Profile
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/users/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: currentUser.id,
          fullName: editFullName.trim(),
          bio: editBio.trim(),
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setEditingProfile(false);
        if (onUserUpdate) onUserUpdate(data.user);
      }
    } catch (err) {
      console.error('Profile update error:', err);
    }
  };

  const copyUserId = () => {
    navigator.clipboard.writeText(currentUser.userIdCode);
    setIdCopied(true);
    setTimeout(() => setIdCopied(false), 2000);
  };

  const filteredFriends = friends.filter(
    (f) =>
      f.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className={`cryptchat-app${mobileChatOpen ? ' mobile-chat-open' : ''}`}>
      {/* 1. Leftmost Navigation Rail */}
      <aside className="nav-rail">
        <div className="rail-top">
          <div className="rail-brand-logo" title="CryptChat">
            💬
          </div>

          <div className="rail-nav-menu">
            <button
              type="button"
              className={`rail-nav-btn ${activeTab === 'chats' ? 'active' : ''}`}
              onClick={() => navigateToTab('chats')}
              title="Chats"
            >
              💭
            </button>

            <button
              type="button"
              className={`rail-nav-btn ${activeTab === 'friends' ? 'active' : ''}`}
              onClick={() => navigateToTab('friends')}
              title="Find Users by ID & Friend Requests"
            >
              👥
              {pendingIncoming.length > 0 && (
                <span className="rail-badge-dot">{pendingIncoming.length}</span>
              )}
            </button>

            <button
              type="button"
              className={`rail-nav-btn ${activeTab === 'profile' ? 'active' : ''}`}
              onClick={() => navigateToTab('profile')}
              title="My Profile"
            >
              👤
            </button>

            <button
              type="button"
              className={`rail-nav-btn ${activeTab === 'key-settings' ? 'active' : ''}`}
              onClick={() => navigateToTab('key-settings')}
              title="Friendship key updates"
            >
              🔑
            </button>
          </div>
        </div>

        <div className="rail-bottom">
          <button
            type="button"
            className="rail-theme-btn"
            onClick={toggleTheme}
            title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>

          <div
            className="rail-user-avatar"
            title={`Logged in as ${currentUser.fullName} (${currentUser.userIdCode})`}
            onClick={() => navigateToTab('profile')}
          >
            <img src={currentUser.avatar} alt={currentUser.fullName} />
            <span className="rail-user-status" />
          </div>
        </div>
      </aside>

      {/* 2. Middle Panel: Chats / Friends / Profile */}
      <div className="sidebar-panel">
        <nav className="mobile-nav-tabs" aria-label="Main navigation">
          <button
            type="button"
            className={activeTab === 'chats' ? 'active' : ''}
            onClick={() => navigateToTab('chats')}
          >
            Chats
          </button>
          <button
            type="button"
            className={activeTab === 'friends' ? 'active' : ''}
            onClick={() => navigateToTab('friends')}
          >
            Friends{pendingIncoming.length > 0 ? ` (${pendingIncoming.length})` : ''}
          </button>
          <button
            type="button"
            className={activeTab === 'profile' ? 'active' : ''}
            onClick={() => navigateToTab('profile')}
          >
            Profile
          </button>
          <button
            type="button"
            className={activeTab === 'key-settings' ? 'active' : ''}
            onClick={() => navigateToTab('key-settings')}
          >
            Keys
          </button>
          <button type="button" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </nav>
        {activeTab === 'chats' && (
          <>
            <div className="panel-header">
              <div className="panel-title-row">
                <h2 className="panel-heading">Chats</h2>
                <button
                  type="button"
                  className="panel-add-btn"
                  title="Add Friend by ID"
                  onClick={() => navigateToTab('friends')}
                >
                  +
                </button>
              </div>

              <div className="panel-search-box">
                <span className="search-icon-pos">🔍</span>
                <input
                  type="text"
                  className="panel-search-input"
                  placeholder="Search messages or friends"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            {/* Active Users / Story Carousel */}
            <div className="online-users-carousel">
              {friends.map((f) => (
                <div
                  key={f.id}
                  className="story-user-item"
                  onClick={() => {
                    handleSelectContact(f);
                    setMessageAllowed(true);
                  }}
                >
                  <div className="story-avatar-wrapper">
                    <img src={f.avatar} alt={f.fullName} className="story-avatar" />
                    {f.online && <span className="story-dot" />}
                  </div>
                  <span className="story-name">{f.fullName.split(' ')[0]}</span>
                </div>
              ))}
            </div>

            <div className="panel-section-title">Recent</div>

            {/* Chat list */}
            <div className="chat-list-scroll">
              {filteredFriends.length === 0 ? (
                <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
                  No chats yet. Click the <strong>👥 Friends</strong> tab to connect with someone using their User ID!
                </div>
              ) : (
                filteredFriends.map((friend) => {
                  const isActive = activeContact?.id === friend.id;
                  return (
                    <div
                      key={friend.id}
                      className={`chat-item ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        handleSelectContact(friend);
                        setMessageAllowed(true);
                      }}
                    >
                      <div className="chat-item-avatar-wrap">
                        <img src={friend.avatar} alt={friend.fullName} className="chat-item-avatar" />
                        <span className={`chat-item-dot ${friend.online ? 'online' : 'offline'}`} />
                      </div>
                      <div className="chat-item-content">
                        <div className="chat-item-top">
                          <span className="chat-item-name">{friend.fullName}</span>
                          {friend.lastMessageTime && (
                            <span className="chat-item-time">
                              {new Date(friend.lastMessageTime).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          )}
                        </div>
                        <div className="chat-item-bottom">
                          <span className="chat-item-msg">
                            {friend.lastMessage || (friend.online ? 'Active now' : 'Offline')}
                          </span>
                          {friend.online && <span className="chat-item-unread">01</span>}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* Friends & Connect by User ID Tab ("do not shows the user name until they enter the user id") */}
        {activeTab === 'friends' && (
          <div className="friend-panel-body">
            <div className="panel-title-row" style={{ paddingBottom: 6 }}>
              <h2 className="panel-heading">Connect with Friends</h2>
            </div>

            <div className="privacy-notice-box">
              <span>🔒</span>
              <span>
                <strong>Privacy Shield:</strong> User profiles and usernames are hidden until you enter their unique <strong>User ID</strong>.
              </span>
            </div>

            {idActionMsg && (
              <div
                role={idActionMsg.isError ? 'alert' : 'status'}
                className={`status-notice ${idActionMsg.isError ? 'status-notice--error' : 'status-notice--success'}`}
              >
                {idActionMsg.text}
              </div>
            )}

            {/* User ID Lookup Card */}
            <div className="friend-send-card">
              <span className="friend-send-title">
                <span>🔍</span> Find User by User ID
              </span>
              <p style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                Ask your friend for their User ID to reveal their profile and connect:
              </p>
              <form onSubmit={handleLookupUserId} className="friend-send-form">
                <input
                  type="text"
                  className="friend-send-input"
                  placeholder="Enter User ID"
                  value={targetIdInput}
                  onChange={(e) => setTargetIdInput(e.target.value)}
                  required
                />
                <button type="submit" className="friend-send-btn" disabled={searchingId}>
                  {searchingId ? 'Searching...' : 'Search ID'}
                </button>
              </form>

              {/* Found User Profile Result */}
              {foundUser && (
                <div className="found-user-card">
                  <div className="found-user-header">
                    <img src={foundUser.avatar} alt={foundUser.fullName} className="found-user-avatar" />
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                        {foundUser.fullName}
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--primary-color)', fontWeight: 600 }}>
                        @{foundUser.username} • {foundUser.userIdCode}
                      </div>
                      {foundUser.bio && (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                          {foundUser.bio}
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    {foundUser.relationship === 'friends' ? (
                      <button
                        type="button"
                        className="btn-accept"
                        style={{ width: '100%' }}
                        onClick={() => {
                          const friendObj = friends.find((f) => f.id === foundUser.id);
                          if (friendObj) {
                            handleSelectContact(friendObj);
                            setMessageAllowed(true);
                            navigateToTab('chats');
                          }
                        }}
                      >
                        You are Friends! Open Chat 💬
                      </button>
                    ) : foundUser.relationship === 'pending_sent' ? (
                      <div style={{ textAlign: 'center' }}>
                        <span className="status-badge-pending">Friend Request Sent (Pending...)</span>
                      </div>
                    ) : foundUser.relationship === 'pending_received' ? (
                      <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--primary-color)', fontWeight: 600 }}>
                        This user has sent you a friend request! Accept it below 👇
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="friend-send-btn"
                        style={{ width: '100%' }}
                        onClick={() => handleSendFriendRequest(foundUser.userIdCode)}
                      >
                        + Send Friend Request to {foundUser.fullName}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Incoming Requests */}
            <div>
              <div className="panel-section-title" style={{ padding: '0 0 10px 0' }}>
                Pending Requests Received ({pendingIncoming.length})
              </div>
              {pendingIncoming.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No incoming requests.</div>
              ) : (
                pendingIncoming.map((req) => (
                  <div key={req.id} className="request-card">
                    <div className="request-meta">
                      <img src={req.avatar} alt={req.fullName} className="request-avatar" />
                      <div className="request-names">
                        <span className="request-fullname">{req.fullName}</span>
                        <span className="request-username">@{req.username} ({req.userIdCode})</span>
                      </div>
                    </div>
                    <div className="request-actions">
                      <button
                        type="button"
                        className="btn-accept"
                        onClick={() => handleRespondFriendRequest(req.id, 'accept')}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="btn-reject"
                        onClick={() => handleRespondFriendRequest(req.id, 'reject')}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Sent Outgoing Requests */}
            {pendingOutgoing.length > 0 && (
              <div>
                <div className="panel-section-title" style={{ padding: '0 0 10px 0' }}>
                  Requests Sent ({pendingOutgoing.length})
                </div>
                {pendingOutgoing.map((req) => (
                  <div key={req.id} className="request-card">
                    <div className="request-meta">
                      <img src={req.avatar} alt={req.fullName} className="request-avatar" />
                      <div className="request-names">
                        <span className="request-fullname">{req.fullName}</span>
                        <span className="request-username">@{req.username} ({req.userIdCode})</span>
                      </div>
                    </div>
                    <span className="status-badge-pending">Pending...</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 3. Structured Profile Tab */}
        {activeTab === 'profile' && (
          <div className="profile-panel-container">
            <h2 className="panel-heading">User Profile</h2>

            <div className="profile-hero-card">
              <div className="profile-avatar-large-wrap">
                <img src={currentUser.avatar} alt={currentUser.fullName} className="profile-avatar-large" />
                <span className="rail-user-status" style={{ width: 14, height: 14 }} />
              </div>

              <div>
                <h3 className="profile-name-text">{currentUser.fullName}</h3>
                <p className="profile-bio-text">{currentUser.bio || 'Hey there! I am using CryptChat.'}</p>
              </div>

              {/* User ID Chip with Copy */}
              <div className="profile-id-chip" onClick={copyUserId} title="Click to copy your User ID to share">
                <span>🔑 User ID: <strong>{currentUser.userIdCode}</strong></span>
                <span style={{ fontSize: 11 }}>{idCopied ? '✓ Copied!' : '📋 Copy'}</span>
              </div>
            </div>

            {/* Profile Structured Information */}
            <div className="profile-details-card">
              <div className="profile-row-item">
                <span className="profile-row-label">Full Name</span>
                <span className="profile-row-value">{currentUser.fullName}</span>
              </div>
              <div className="profile-row-item">
                <span className="profile-row-label">Username</span>
                <span className="profile-row-value">@{currentUser.username}</span>
              </div>
              <div className="profile-row-item">
                <span className="profile-row-label">Gmail ID / Email</span>
                <span className="profile-row-value">{currentUser.email}</span>
              </div>
              <div className="profile-row-item">
                <span className="profile-row-label">Database</span>
                <span className="profile-row-value">PostgreSQL 🐘</span>
              </div>
              <div className="profile-row-item">
                <span className="profile-row-label">Storage Folders</span>
                <span className="profile-row-value">chat, images, files</span>
              </div>
              <div className="profile-row-item">
                <span className="profile-row-label">Total Friends</span>
                <span className="profile-row-value">{friends.length}</span>
              </div>
            </div>

            {/* Edit Profile Form */}
            {editingProfile ? (
              <form onSubmit={handleSaveProfile} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input
                  type="text"
                  className="friend-send-input"
                  placeholder="Full Name"
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                  required
                />
                <textarea
                  className="friend-send-input"
                  placeholder="Bio / About status"
                  value={editBio}
                  onChange={(e) => setEditBio(e.target.value)}
                  rows={2}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" className="btn-accept" style={{ flex: 1 }}>Save Changes</button>
                  <button type="button" className="btn-reject" onClick={() => setEditingProfile(false)}>Cancel</button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="btn-accept"
                style={{ background: 'var(--primary-light)', color: 'var(--primary-color)', border: '1px solid var(--primary-border)' }}
                onClick={() => setEditingProfile(true)}
              >
                ✏️ Edit Profile
              </button>
            )}

            {onLogout && (
              <button
                type="button"
                className="btn-reject"
                style={{ marginTop: 8, padding: 12, borderRadius: 8, cursor: 'pointer' }}
                onClick={onLogout}
              >
                Sign Out
              </button>
            )}
          </div>
        )}
        {activeTab === 'key-settings' && (
          <div className="profile-panel-container">
            <h2 className="panel-heading">Friendship key updates</h2>
            <p className="mb-4 text-sm text-[var(--text-secondary)]">
              A shared key is saved once for each friendship. Update it here; your friend must confirm a new key once before private messages are enabled again.
            </p>
            <div className="mb-5 flex flex-wrap gap-2">
              {friends.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">Add a friend before setting up a shared key.</p>
              ) : friends.map((friend) => (
                <button
                  type="button"
                  key={friend.id}
                  className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                    activeContact?.id === friend.id
                      ? 'border-emerald-600 bg-emerald-700 text-white'
                      : 'border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-primary)]'
                  }`}
                  onClick={() => {
                    if (activeContact?.id !== friend.id) handleSelectContact(friend);
                    setKeyUpdateError('');
                    setKeyUpdateMessage('');
                  }}
                >
                  {friend.fullName}
                </button>
              ))}
            </div>
            {activeContact ? (
              <section className="max-w-2xl rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4 shadow-sm sm:p-6">
                <h3 className="mb-2 text-base font-semibold text-[var(--text-primary)]">
                  {activeContact.fullName}
                </h3>
                {!secureKeyStatus ? (
                  <p className="text-sm text-[var(--text-secondary)]">Loading this friendship’s key status…</p>
                ) : !secureKeyStatus.configured ? (
                  <p className="text-sm text-[var(--text-secondary)]">
                    Set up the first shared key in this friend’s chat. You will not need to enter it for each message.
                  </p>
                ) : !secureKeyStatus.ready && secureKeyStatus.setByMe ? (
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Waiting for your friend to confirm the new shared key. Private messages are paused until they do.
                  </p>
                ) : !secureKeyStatus.ready ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleSetSecureKey();
                    }}
                    className="flex flex-col gap-3"
                  >
                    <p className="text-sm text-[var(--text-secondary)]">
                      Your friend set a shared key. Enter it once to confirm and save it on this device.
                    </p>
                    <input
                      type="password"
                      autoComplete="off"
                      minLength={12}
                      maxLength={256}
                      aria-label="Confirm shared passphrase"
                      placeholder="Shared passphrase"
                      value={securePassphrase}
                      onChange={(event) => setSecurePassphrase(event.target.value)}
                      className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-input)] px-4 py-3 text-sm text-[var(--text-primary)]"
                    />
                    <button
                      type="submit"
                      disabled={!securePassphrase.trim()}
                      className="w-fit rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Confirm shared key
                    </button>
                    {uploadError && <p role="alert" className="text-sm text-red-600">{uploadError}</p>}
                  </form>
                ) : (
                  <form onSubmit={handleRotateSecureKey} className="flex flex-col gap-3">
                    <p className="text-sm text-[var(--text-secondary)]">
                      Changing the key pauses private messages until your friend confirms the new one. Pending private images must be viewed before changing the key.
                    </p>
                    {keyUpdateError && <p role="alert" className="status-notice status-notice--error">{keyUpdateError}</p>}
                    {keyUpdateMessage && <p role="status" className="status-notice status-notice--success">{keyUpdateMessage}</p>}
                    <input
                      type="password"
                      autoComplete="off"
                      minLength={12}
                      maxLength={256}
                      aria-label="Current shared passphrase"
                      placeholder="Current shared passphrase"
                      value={keyUpdateCurrent}
                      onChange={(event) => setKeyUpdateCurrent(event.target.value)}
                      required
                      className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-input)] px-4 py-3 text-sm text-[var(--text-primary)]"
                    />
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={256}
                      aria-label="New shared passphrase"
                      placeholder="New shared passphrase (12+ characters)"
                      value={keyUpdateNext}
                      onChange={(event) => setKeyUpdateNext(event.target.value)}
                      required
                      className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-input)] px-4 py-3 text-sm text-[var(--text-primary)]"
                    />
                    <button
                      type="submit"
                      disabled={keyUpdateBusy || !keyUpdateCurrent || keyUpdateNext.trim().length < 12}
                      className="w-fit rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      {keyUpdateBusy ? 'Updating…' : 'Update friendship key'}
                    </button>
                  </form>
                )}
              </section>
            ) : (
              <p className="text-sm text-[var(--text-secondary)]">Choose a friend to manage their shared key.</p>
            )}
          </div>
        )}
      </div>

      {/* 3. Main Chat View Area */}
      <div className="chat-main-area">
        {activeTab === 'key-settings' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="text-5xl" aria-hidden="true">🔐</div>
            <h2 className="text-xl font-bold text-[var(--text-primary)]">Keys are scoped per friendship</h2>
            <p className="max-w-md text-sm text-[var(--text-secondary)]">
              Select a friend in the key updates panel to confirm or rotate that connection’s shared key.
            </p>
          </div>
        ) : activeContact ? (
          <>
            {/* Header */}
            <div className="chat-header-bar">
              <button
                type="button"
                className="mobile-chat-back"
                onClick={handleMobileChatBack}
                aria-label="Back to chats"
              >
                ←
              </button>
              <div className="chat-header-contact">
                <div className="header-avatar-wrap">
                  <img src={activeContact.avatar} alt={activeContact.fullName} className="header-avatar" />
                  <span className={`story-dot ${activeContact.online ? 'online' : ''}`} />
                </div>
                <div>
                  <div className="header-contact-name">
                    {activeContact.fullName}
                    {activeContact.online && <span className="header-online-indicator" />}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {activeContact.online ? 'Active now' : 'Offline'} • @{activeContact.username} ({activeContact.userIdCode})
                  </span>
                </div>
              </div>

              <div className="header-actions">
                <button
                  type="button"
                  className="header-icon-btn"
                  title="Profile Details"
                  onClick={() => {
                    navigateToTab('profile');
                  }}
                >
                  ℹ️
                </button>
              </div>
            </div>

            {/* Conversation Feed */}
            {messageAllowed ? (
              <div className="chat-messages-thread">
                {messages.length === 0 ? (
                  <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
                      You and {activeContact.fullName} are connected! 🎉
                    </p>
                    <p style={{ fontSize: 13 }}>Send a message, emoji, or file below to start chatting.</p>
                  </div>
                ) : (
                  messages.map((m) => {
                    const isMe = m.senderId === currentUser.id;
                    return (
                      <div key={m.id} className={`message-row ${isMe ? 'sent' : 'received'}`}>
                        {!isMe && (
                          <img
                            src={activeContact.avatar}
                            alt={activeContact.fullName}
                            className="msg-avatar"
                          />
                        )}
                        <div className="msg-content-wrapper">
                          {/* Image Message */}
                          {m.isSecure ? (
                            <div className="msg-image-bubble">
                              {secureImageUrls[m.id] ? (
                                <button
                                  type="button"
                                  className="image-preview-trigger"
                                  aria-label="Enlarge secure image"
                                  onClick={() =>
                                    setImagePreview({
                                      src: secureImageUrls[m.id],
                                      alt: 'Secure image message',
                                    })
                                  }
                                >
                                  <img src={secureImageUrls[m.id]} alt="Secure image message" />
                                </button>
                              ) : (
                                <span className="image-loading-state">Loading image…</span>
                              )}
                              {revealedSecureMessages[m.id] ? (
                                <div className="secure-message-revealed">
                                  {activeSecureRevealId === m.id && secureCameraStream && (
                                    <div className="secure-camera-guard">
                                      <video
                                        ref={secureCameraVideoRef}
                                        autoPlay
                                        muted
                                        playsInline
                                        aria-label="Live face verification preview"
                                      />
                                      <span>Face check active</span>
                                      <button
                                        type="button"
                                        aria-label="Hide private text"
                                        onClick={clearSecureReveal}
                                      >
                                        ×
                                      </button>
                                    </div>
                                  )}
                                  <p>{revealedSecureMessages[m.id]}</p>
                                </div>
                              ) : m.secureConsumed ? null : m.receiverId === currentUser.id ? (
                                <button
                                  type="button"
                                  className="secure-decrypt-btn"
                                  aria-label="Decrypt secure message once"
                                  title={secureProcessingId === m.id ? 'Checking face and decrypting' : 'Decrypt once'}
                                  disabled={secureProcessingId === m.id || !secureKeyStatus?.ready}
                                  onClick={() => handleDecryptSecureMessage(m)}
                                >
                                  {secureProcessingId === m.id ? (
                                    <span className="secure-decrypt-spinner" aria-hidden="true" />
                                  ) : (
                                    <span aria-hidden="true">⌄</span>
                                  )}
                                </button>
                              ) : null}
                            </div>
                          ) : m.messageType === 'image' && m.fileUrl ? (
                            <div className="msg-image-bubble">
                              <button
                                type="button"
                                className="image-preview-trigger"
                                aria-label={`Enlarge image: ${m.fileName || 'attached photo'}`}
                                onClick={() =>
                                  setImagePreview({
                                    src: `${m.fileUrl}?userId=${encodeURIComponent(currentUser.id)}`,
                                    alt: m.fileName || 'Attached photo',
                                  })
                                }
                              >
                                <img
                                  src={`${m.fileUrl}?userId=${encodeURIComponent(currentUser.id)}`}
                                  alt={m.fileName || 'Attached photo'}
                                />
                              </button>
                            </div>
                          ) : m.messageType === 'file' && m.fileUrl ? (
                            /* File Attachment Message */
                            <div className="msg-file-bubble">
                              <div className="file-icon-box">📄</div>
                              <div className="file-meta-info">
                                <span className="file-name-text">{m.fileName || 'Document'}</span>
                                <span className="file-size-text">{m.fileSize || 'File'}</span>
                              </div>
                              <a
                                href={`${m.fileUrl}?userId=${encodeURIComponent(currentUser.id)}`}
                                download={m.fileName || 'download'}
                                className="file-download-btn"
                                title="Download file"
                              >
                                ⬇️
                              </a>
                            </div>
                          ) : (
                            /* Normal Text Message */
                            <div className="msg-bubble">
                              <span>{m.content}</span>
                              <button type="button" className="msg-menu-btn">⋮</button>
                            </div>
                          )}

                          <div className="msg-time-badge">
                            <span>
                              {new Date(m.timestamp).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                            {isMe && <span>✓✓</span>}
                          </div>
                          {!isMe && <span className="msg-sender-name">{activeContact.fullName}</span>}
                        </div>
                      </div>
                    );
                  })
                )}

                {otherIsTyping && (
                  <div style={{ fontSize: 12, color: 'var(--primary-color)', fontStyle: 'italic', display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span>{activeContact.fullName} is typing...</span>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            ) : (
              <div className="not-friends-banner">
                <div className="lock-icon-circle">🔒</div>
                <h3 style={{ fontSize: 18, color: 'var(--text-primary)' }}>Friendship Required</h3>
                <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  You and <strong>@{activeContact.username}</strong> ({activeContact.userIdCode}) are not friends yet. You must connect first before exchanging messages.
                </p>
                <button
                  type="button"
                  className="friend-send-btn"
                  onClick={() => handleSendFriendRequest(activeContact.userIdCode)}
                >
                  Send Friend Request
                </button>
              </div>
            )}

            {/* Emoji Picker Popover */}
            {showEmojiPicker && (
              <div className="emoji-picker-popover">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  <span>Emojis & Reactions</span>
                  <button
                    type="button"
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14 }}
                    onClick={() => setShowEmojiPicker(false)}
                  >
                    ✕
                  </button>
                </div>
                <div className="emoji-grid">
                  {EMOJI_LIST.map((em) => (
                    <button
                      key={em}
                      type="button"
                      className="emoji-select-btn"
                      onClick={() => handleSelectEmoji(em)}
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Hidden File Inputs */}
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
            <input
              type="file"
              ref={imageInputRef}
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
            <input
              type="file"
              ref={secureImageInputRef}
              accept="image/png"
              style={{ display: 'none' }}
              onChange={handleSecureImageSelected}
            />

            {/* Input Bar */}
            {uploadError && (
              <p role="alert" className="auth-error-alert">
                {uploadError}
              </p>
            )}
            {messageAllowed && (
              <form
                onSubmit={secureMode ? handleSecureMessageSubmit : handleSendMessage}
                className="chat-input-bar"
              >
                <button
                  type="button"
                  className={`inline-flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm font-semibold shadow-sm transition sm:w-auto ${
                    secureMode
                      ? 'border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800'
                      : 'border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:border-emerald-500'
                  }`}
                  aria-pressed={secureMode}
                  onClick={() => {
                    setSecureMode((enabled) => !enabled);
                    setSecureImage(null);
                    setUploadError('');
                    if (secureImageInputRef.current) secureImageInputRef.current.value = '';
                  }}
                >
                  <span>{secureMode ? 'Private image message' : 'Send a private image message'}</span>
                  <span className={`ml-4 rounded-full px-2 py-0.5 text-xs ${
                    secureMode ? 'bg-white/20 text-white' : 'bg-[var(--bg-input)] text-[var(--text-secondary)]'
                  }`}>
                    {secureMode ? 'ON' : 'OFF'}
                  </span>
                </button>
                {secureMode && (
                  <section className="secure-key-card w-full rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-4 text-slate-800 shadow-sm dark:border-emerald-400/30 dark:from-slate-800 dark:to-slate-900 dark:text-slate-100 sm:p-5">
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-100 text-lg dark:bg-emerald-400/15">🔐</span>
                          <h3 className="text-sm font-bold sm:text-base">Shared passphrase</h3>
                        </div>
                        <p className="mt-2 max-w-xl text-xs leading-relaxed text-slate-600 dark:text-slate-300 sm:text-sm">
                          Create one key for this friendship. Enter it once to set or confirm it; this device then keeps a non-exportable encryption key so you do not have to type it for each message. The server stores only a salted verifier.
                        </p>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        secureKeyStatus?.ready
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300'
                          : secureKeyStatus?.configured
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-200'
                            : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                      }`}>
                        {!secureKeyStatus
                          ? 'Checking…'
                          : secureKeyStatus.ready
                            ? secureKeyAvailable ? 'Ready on this device' : 'Unlock this device once'
                            : secureKeyStatus.configured
                              ? secureKeyStatus.setByMe ? 'Waiting for friend' : 'Confirmation needed'
                              : 'Not set up'}
                      </span>
                    </div>

                    {secureKeyError && (
                      <p role="alert" className="status-notice status-notice--error mb-3">
                        {secureKeyError}
                      </p>
                    )}
                    {secureKeyStatus && (
                      <p className="mb-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                        {!secureKeyStatus.configured
                          ? 'Set one shared passphrase for this friendship. Your friend confirms it once.'
                          : secureKeyStatus.confirmed
                            ? secureKeyAvailable
                              ? 'The key is saved on this device and will be reused automatically for private messages.'
                              : 'Enter the shared passphrase once to unlock it on this device.'
                            : secureKeyStatus.setByMe
                              ? 'Your key is saved. Your friend must confirm it once before private messages are enabled.'
                              : 'Your friend has set the shared key. Enter it once to confirm and save it on this device.'}
                      </p>
                    )}

                    {secureKeyStatus?.configured && secureKeyStatus.ready && (
                      <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-300">
                        {secureKeyAvailable ? 'Saved securely on this device.' : 'This device needs to be unlocked once.'}
                      </p>
                    )}
                    {secureKeyStatus?.configured && secureKeyStatus.ready && (
                      <button
                        type="button"
                        className="mb-3 text-left text-xs font-semibold text-emerald-800 underline dark:text-emerald-300"
                        onClick={() => navigateToTab('key-settings')}
                      >
                        Manage or update this friendship key
                      </button>
                    )}

                    {secureKeyStatus && (
                      (!secureKeyStatus.configured ||
                        (!secureKeyStatus.ready && !secureKeyStatus.setByMe) ||
                        (secureKeyStatus.ready && !secureKeyAvailable)) && (
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            type="password"
                            autoComplete="off"
                            minLength={12}
                            maxLength={256}
                            aria-label="Shared passphrase"
                            placeholder={
                              !secureKeyStatus.configured
                                ? 'Create shared passphrase (12+ characters)'
                                : secureKeyStatus.ready
                                  ? 'Unlock shared passphrase on this device'
                                  : 'Enter shared passphrase to confirm once'
                            }
                            value={securePassphrase}
                            onChange={(event) => setSecurePassphrase(event.target.value)}
                            className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:focus:ring-emerald-500/20"
                          />
                          <button
                            type="button"
                            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={
                              !securePassphrase.trim() ||
                              (secureKeyStatus.ready && securePassphrase.length < 12)
                            }
                            onClick={
                              secureKeyStatus.ready
                                ? handleUnlockSecureKey
                                : handleSetSecureKey
                            }
                          >
                            {!secureKeyStatus.configured
                              ? 'Set key once'
                              : secureKeyStatus.ready
                                ? 'Unlock once'
                                : 'Confirm key once'}
                          </button>
                        </div>
                      )
                    )}
                    <div className="mt-4 flex flex-col gap-2 border-t border-emerald-200/70 pt-4 dark:border-slate-700 sm:flex-row sm:items-center">
                      <button
                        type="button"
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-2.5 text-sm font-semibold text-emerald-800 transition hover:border-emerald-400 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-emerald-200 dark:hover:bg-slate-700"
                        disabled={uploading || !secureKeyStatus?.ready || !secureKeyAvailable}
                        onClick={() => {
                          if (secureImageInputRef.current) {
                            secureImageInputRef.current.value = '';
                            secureImageInputRef.current.click();
                          }
                        }}
                      >
                        <span aria-hidden="true">＋</span>
                        {secureImage ? 'Change PNG image' : 'Choose PNG image'}
                      </button>
                      <p className="min-w-0 truncate text-xs text-slate-600 dark:text-slate-300">
                        {secureImage
                          ? `${secureImage.name} · ${(secureImage.size / 1024).toFixed(0)} KB`
                          : secureKeyStatus?.ready
                            ? 'PNG up to 8 MB · text is encrypted before sending'
                            : 'Set or unlock the shared key to choose an image'}
                      </p>
                    </div>
                  </section>
                )}
                <div className="input-container-pill">
                  <input
                    type="text"
                    className="chat-input-field"
                    placeholder={
                      uploading
                        ? 'Processing...'
                        : secureMode
                          ? 'Text to encrypt and hide in the PNG…'
                          : 'Enter Message...'
                    }
                    value={inputVal}
                    onChange={handleInputChange}
                    disabled={uploading}
                    autoFocus
                  />
                  {!secureMode && <button
                    type="button"
                    className="input-action-btn"
                    title="Insert Emoji"
                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  >
                    😊
                  </button>}
                  {!secureMode && <button
                    type="button"
                    className="input-action-btn"
                    title="Attach Image"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={uploading}
                  >
                    📷
                  </button>}
                  {!secureMode && <button
                    type="button"
                    className="input-action-btn"
                    title="Attach File/Document"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    📎
                  </button>}
                </div>
                <button
                  type="submit"
                  className="chat-send-submit-btn"
                  disabled={
                    !inputVal.trim() ||
                    uploading ||
                    (secureMode &&
                      (!secureImage || !secureKeyStatus?.ready || !secureKeyAvailable))
                  }
                  title="Send Message"
                >
                  {uploading ? '⏳' : '➤'}
                </button>
              </form>
            )}
          </>
        ) : (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-secondary)' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>💬</div>
            <h3 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>Welcome to CryptChat</h3>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 6, maxWidth: 320 }}>
              Select a friend from the left sidebar or click <strong>👥 Friends</strong> to connect using a User ID!
            </p>
          </div>
        )}
      </div>
      {imagePreview && (
        <div
          className="image-preview-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => setImagePreview(null)}
        >
          <button
            type="button"
            className="image-preview-close"
            aria-label="Close image preview"
            onClick={() => setImagePreview(null)}
          >
            ×
          </button>
          <img
            src={imagePreview.src}
            alt={imagePreview.alt}
            className="image-preview-full"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  // Auth Form State
  const [isLogin, setIsLogin] = useState(true);
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [faceImage, setFaceImage] = useState<string | null>(null);
  const [faceConsent, setFaceConsent] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = cameraStream;
    }
    return () => {
      cameraStream?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraStream]);

  const saveUserSession = (user: User, token?: string) => {
    setCurrentUser(user);
    if (token) setAccessToken(token);
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setAccessToken(null);
  };

  const startFaceCamera = async () => {
    setErrorMsg('');
    setFaceImage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
      setCameraStream(stream);
    } catch (err) {
      console.error('Camera access error:', err);
      setErrorMsg('Camera access is required for face enrollment. Allow camera access and try again.');
    }
  };

  const captureFace = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setErrorMsg('The camera is not ready yet. Please try again.');
      return;
    }

    const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) {
      setErrorMsg('Could not capture an image from the camera.');
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    setFaceImage(canvas.toDataURL('image/jpeg', 0.85).split(',')[1] || null);
    setCameraStream(null);
    setErrorMsg('');
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (!isLogin && (!faceImage || !faceConsent)) {
      setErrorMsg('Capture your face and provide consent to complete registration.');
      return;
    }
    if (!username.trim() || !email.trim() || !password.trim()) {
      setErrorMsg('Please provide username, Gmail ID, and password.');
      return;
    }

    setLoading(true);
    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: fullName.trim() || username.trim(),
          username: username.trim(),
          email: email.trim(),
          password: password.trim(),
          ...(isLogin ? {} : { faceImage, faceConsent }),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'Authentication failed.');
      } else if (typeof data.token !== 'string') {
        setErrorMsg('Authentication server returned no access token.');
      } else {
        saveUserSession(data.user, data.token);
        setCameraStream(null);
        setFaceImage(null);
        setFaceConsent(false);
        setUsername('');
        setEmail('');
        setPassword('');
        setFullName('');
      }
    } catch {
      setErrorMsg('Could not connect to backend server. Make sure it is running.');
    } finally {
      setLoading(false);
    }
  };

  if (!currentUser || !accessToken) {
    return (
      <div className="auth-page-wrapper">
        <div className="auth-modal-card">
          <div className="auth-card-header">
            <div className="auth-brand-badge">💬</div>
            <h1 className="auth-title">
              {isLogin ? 'Sign in to CryptChat' : 'Create CryptChat Account'}
            </h1>
            <p className="auth-subtitle">
              {isLogin
                ? 'Sign in with your Username, Gmail ID, and Password'
                : 'Join CryptChat to connect with friends via User ID'}
            </p>
          </div>

          <div className="auth-nav-tabs">
            <button
              type="button"
              className={`auth-nav-tab ${isLogin ? 'active' : ''}`}
              onClick={() => {
                setIsLogin(true);
                setErrorMsg('');
                setCameraStream(null);
                setFaceImage(null);
                setFaceConsent(false);
              }}
            >
              Sign In
            </button>
            <button
              type="button"
              className={`auth-nav-tab ${!isLogin ? 'active' : ''}`}
              onClick={() => {
                setIsLogin(false);
                setErrorMsg('');
                setCameraStream(null);
                setFaceImage(null);
                setFaceConsent(false);
              }}
            >
              Sign Up
            </button>
          </div>

          {errorMsg && <div className="auth-error-alert" role="alert">{errorMsg}</div>}

          <form onSubmit={handleAuthSubmit} className="auth-form-body">
            {!isLogin && (
              <div className="auth-input-group">
                <label className="auth-input-label">Full Name</label>
                <input
                  type="text"
                  className="auth-input-control"
                  placeholder="Your full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required={!isLogin}
                />
              </div>
            )}

            <div className="auth-input-group">
              <label className="auth-input-label">Username</label>
              <input
                type="text"
                className="auth-input-control"
                placeholder="Choose a username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>

            <div className="auth-input-group">
              <label className="auth-input-label">Gmail ID / Email</label>
              <input
                type="email"
                className="auth-input-control"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="auth-input-group">
              <label className="auth-input-label">Password</label>
              <input
                type="password"
                className="auth-input-control"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {!isLogin && (
              <div className="auth-input-group">
                <label className="auth-input-label">Required face enrollment</label>
                <p className="auth-subtitle status-notice status-notice--info">
                  Capture one clearly visible face. We store an encrypted InspireFace template, not this image. When you open a private message, CryptChat sends temporary camera frames to the configured face service to verify your face while the text is visible; frames are not stored. This is not a liveness check and cannot detect people outside the camera view or prevent recording.
                </p>
                {cameraStream && !faceImage && (
                  <video
                    ref={videoRef}
                    autoPlay
                    muted
                    playsInline
                    aria-label="Live face enrollment camera"
                    className="auth-face-media"
                  />
                )}
                {faceImage && (
                  <img
                    src={`data:image/jpeg;base64,${faceImage}`}
                    alt="Captured face for enrollment"
                    className="auth-face-media"
                  />
                )}
                <div className="auth-camera-actions">
                  {!cameraStream && (
                    <button
                      type="button"
                      className="auth-primary-btn"
                      onClick={startFaceCamera}
                    >
                      {faceImage ? 'Retake Face Capture' : 'Enable Camera'}
                    </button>
                  )}
                  {cameraStream && (
                    <>
                      <button type="button" className="auth-primary-btn" onClick={captureFace}>
                        Capture Face
                      </button>
                      <button
                        type="button"
                        className="btn-reject"
                        onClick={() => setCameraStream(null)}
                      >
                        Stop Camera
                      </button>
                    </>
                  )}
                </div>
                <label className="auth-consent-label">
                  <input
                    type="checkbox"
                    checked={faceConsent}
                    onChange={(event) => setFaceConsent(event.target.checked)}
                    required
                  />
                  I consent to storing an encrypted face template and using temporary camera frames to verify me while viewing private messages.
                </label>
              </div>
            )}

            <button type="submit" className="auth-primary-btn" disabled={loading}>
              {loading ? 'Please wait...' : isLogin ? 'Sign In' : 'Create Account'}
            </button>
          </form>

        </div>
      </div>
    );
  }

  return (
    currentUser && (
      <ChatViewPanel
        currentUser={currentUser}
        accessToken={accessToken}
        onLogout={handleLogout}
        onUserUpdate={saveUserSession}
      />
    )
  );
}
