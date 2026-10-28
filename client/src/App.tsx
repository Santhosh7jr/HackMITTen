import React, { useState, useEffect, useRef } from 'react';
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
  timestamp: string;
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

interface ChatViewPanelProps {
  currentUser: User;
  onLogout?: () => void;
  paneTitle?: string;
  forcedActiveUserId?: string;
  onToggleSplit?: () => void;
  isSplitActive?: boolean;
  onUserUpdate?: (updatedUser: User) => void;
}

function ChatViewPanel({
  currentUser,
  onLogout,
  paneTitle,
  forcedActiveUserId,
  onToggleSplit,
  isSplitActive,
  onUserUpdate,
}: ChatViewPanelProps) {
  const [activeTab, setActiveTab] = useState<'chats' | 'friends' | 'profile'>('chats');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // Friends & Requests
  const [friends, setFriends] = useState<User[]>([]);
  const [pendingIncoming, setPendingIncoming] = useState<FriendRequestItem[]>([]);
  const [pendingOutgoing, setPendingOutgoing] = useState<FriendRequestItem[]>([]);

  // Active chat
  const [activeContact, setActiveContact] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageAllowed, setMessageAllowed] = useState(true);

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

  // Typing
  const [otherIsTyping, setOtherIsTyping] = useState(false);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

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

  // Load Friends Data
  const loadFriendsData = async () => {
    try {
      const res = await fetch(`/api/friends?userId=${currentUser.id}`);
      if (res.ok) {
        const data = await res.json();
        setFriends(data.friends || []);
        setPendingIncoming(data.pendingIncoming || []);
        setPendingOutgoing(data.pendingOutgoing || []);

        if (!activeContact && data.friends && data.friends.length > 0) {
          if (forcedActiveUserId) {
            const found = data.friends.find((f: User) => f.id === forcedActiveUserId);
            setActiveContact(found || data.friends[0]);
          } else {
            setActiveContact(data.friends[0]);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load friends:', err);
    }
  };

  useEffect(() => {
    loadFriendsData();
  }, [currentUser.id]);

  // Load conversation messages
  useEffect(() => {
    if (!activeContact) {
      setMessages([]);
      return;
    }

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/messages?user1=${currentUser.id}&user2=${activeContact.id}`);
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
    setOtherIsTyping(false);
  }, [activeContact?.id, currentUser.id]);

  // WebSocket lifecycle
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws?userId=${encodeURIComponent(currentUser.id)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'new_message') {
          const msg: Message = data.message;
          if (
            (msg.senderId === activeContact?.id && msg.receiverId === currentUser.id) ||
            (msg.senderId === currentUser.id && msg.receiverId === activeContact?.id)
          ) {
            setMessages((prev) => [...prev, msg]);
            if (msg.senderId === activeContact?.id) {
              playChime();
            }
          }

          setFriends((prev) =>
            prev.map((f) => {
              if (f.id === msg.senderId || f.id === msg.receiverId) {
                let preview = msg.content;
                if (msg.messageType === 'image') preview = '📷 Photo';
                else if (msg.messageType === 'file') preview = `📄 ${msg.fileName || 'File'}`;
                return { ...f, lastMessage: preview, lastMessageTime: msg.timestamp };
              }
              return f;
            })
          );
        } else if (data.type === 'user_status') {
          setFriends((prev) =>
            prev.map((f) => (f.id === data.userId ? { ...f, online: data.online } : f))
          );
          if (activeContact?.id === data.userId) {
            setActiveContact((prev) => (prev ? { ...prev, online: data.online } : null));
          }
        } else if (data.type === 'typing_indicator') {
          if (data.senderId === activeContact?.id) {
            setOtherIsTyping(data.isTyping);
          }
        } else if (data.type === 'friend_request_received') {
          playChime();
          loadFriendsData();
        } else if (data.type === 'friend_request_accepted') {
          playChime();
          loadFriendsData();
        }
      } catch (err) {
        console.error('WS error:', err);
      }
    };

    return () => {
      ws.close();
    };
  }, [currentUser.id, activeContact?.id]);

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

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
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
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const uploadData = await res.json();
      if (res.ok) {
        // Send message with file
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
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
          await fetch('/api/messages', {
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
        }
      }
    } catch (err) {
      console.error('File upload error:', err);
    } finally {
      setUploading(false);
      if (e.target) e.target.value = '';
    }
  };

  const handleSelectEmoji = (emoji: string) => {
    setInputVal((prev) => prev + emoji);
  };

  // Typing status broadcast
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputVal(e.target.value);
    if (!activeContact || !messageAllowed) return;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
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
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && activeContact) {
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
    <div className="chatvia-app">
      {/* 1. Leftmost Navigation Rail */}
      <aside className="nav-rail">
        <div className="rail-top">
          <div className="rail-brand-logo" title="Chatvia Messenger">
            💬
          </div>

          <div className="rail-nav-menu">
            <button
              type="button"
              className={`rail-nav-btn ${activeTab === 'chats' ? 'active' : ''}`}
              onClick={() => setActiveTab('chats')}
              title="Chats"
            >
              💭
            </button>

            <button
              type="button"
              className={`rail-nav-btn ${activeTab === 'friends' ? 'active' : ''}`}
              onClick={() => setActiveTab('friends')}
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
              onClick={() => setActiveTab('profile')}
              title="My Profile"
            >
              👤
            </button>

            {onToggleSplit && (
              <button
                type="button"
                className={`rail-nav-btn ${isSplitActive ? 'active' : ''}`}
                onClick={onToggleSplit}
                title="Split-Screen Demo (2 Users side-by-side)"
              >
                ⚡
              </button>
            )}
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
            onClick={() => setActiveTab('profile')}
          >
            <img src={currentUser.avatar} alt={currentUser.fullName} />
            <span className="rail-user-status" />
          </div>
        </div>
      </aside>

      {/* 2. Middle Panel: Chats / Friends / Profile */}
      <div className="sidebar-panel">
        {activeTab === 'chats' && (
          <>
            <div className="panel-header">
              <div className="panel-title-row">
                <h2 className="panel-heading">{paneTitle || 'Chats'}</h2>
                <button
                  type="button"
                  className="panel-add-btn"
                  title="Add Friend by ID"
                  onClick={() => setActiveTab('friends')}
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
                    setActiveContact(f);
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
                        setActiveContact(friend);
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
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  fontSize: 13,
                  backgroundColor: idActionMsg.isError ? 'rgba(239, 71, 111, 0.12)' : 'rgba(6, 214, 160, 0.12)',
                  color: idActionMsg.isError ? 'var(--badge-danger)' : 'var(--badge-online)',
                  border: `1px solid ${idActionMsg.isError ? 'rgba(239, 71, 111, 0.25)' : 'rgba(6, 214, 160, 0.25)'}`,
                }}
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
                Ask your friend for their User ID (e.g. <code>UID-7002</code>, <code>UID-7004</code>) to reveal their profile and connect:
              </p>
              <form onSubmit={handleLookupUserId} className="friend-send-form">
                <input
                  type="text"
                  className="friend-send-input"
                  placeholder="Enter User ID (e.g. UID-7004)"
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
                            setActiveContact(friendObj);
                            setMessageAllowed(true);
                            setActiveTab('chats');
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
                <p className="profile-bio-text">{currentUser.bio || 'Hey there! I am using Chatvia.'}</p>
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
      </div>

      {/* 3. Main Chat View Area */}
      <div className="chat-main-area">
        {activeContact ? (
          <>
            {/* Header */}
            <div className="chat-header-bar">
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
                <button type="button" className="header-icon-btn" title="Voice Call">📞</button>
                <button type="button" className="header-icon-btn" title="Video Call">📹</button>
                <button type="button" className="header-icon-btn" title="Profile Details" onClick={() => setActiveTab('profile')}>ℹ️</button>
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
                          {m.messageType === 'image' && m.fileUrl ? (
                            <div className="msg-image-bubble">
                              <a href={m.fileUrl} target="_blank" rel="noopener noreferrer">
                                <img src={m.fileUrl} alt={m.fileName || 'Attached Photo'} />
                              </a>
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
                                href={m.fileUrl}
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

            {/* Input Bar */}
            {messageAllowed && (
              <form onSubmit={handleSendMessage} className="chat-input-bar">
                <div className="input-container-pill">
                  <input
                    type="text"
                    className="chat-input-field"
                    placeholder={uploading ? 'Uploading file...' : 'Enter Message...'}
                    value={inputVal}
                    onChange={handleInputChange}
                    disabled={uploading}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="input-action-btn"
                    title="Insert Emoji"
                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  >
                    😊
                  </button>
                  <button
                    type="button"
                    className="input-action-btn"
                    title="Attach Image"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={uploading}
                  >
                    📷
                  </button>
                  <button
                    type="button"
                    className="input-action-btn"
                    title="Attach File/Document"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    📎
                  </button>
                </div>
                <button
                  type="submit"
                  className="chat-send-submit-btn"
                  disabled={!inputVal.trim() || uploading}
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
            <h3 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>Welcome to Chatvia</h3>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 6, maxWidth: 320 }}>
              Select a friend from the left sidebar or click <strong>👥 Friends</strong> to connect using a User ID!
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    const saved = sessionStorage.getItem('chatvia_user_pg');
    return saved ? JSON.parse(saved) : null;
  });

  const [dualMode, setDualMode] = useState(false);
  const [dualUserPatrick, setDualUserPatrick] = useState<User | null>(null);

  // Auth Form State
  const [isLogin, setIsLogin] = useState(true);
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const saveUserSession = (user: User) => {
    setCurrentUser(user);
    sessionStorage.setItem('chatvia_user_pg', JSON.stringify(user));
  };

  const handleLogout = () => {
    setCurrentUser(null);
    sessionStorage.removeItem('chatvia_user_pg');
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

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
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'Authentication failed.');
      } else {
        saveUserSession(data.user);
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

  const quickLogin = async (uname: string, uemail: string, pword: string) => {
    setErrorMsg('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uname, email: uemail, password: pword }),
      });
      const data = await res.json();
      if (res.ok) {
        saveUserSession(data.user);
      } else {
        setErrorMsg(data.error || 'Login failed.');
      }
    } catch {
      setErrorMsg('Failed to connect to backend.');
    } finally {
      setLoading(false);
    }
  };

  // Toggle Dual Mode (Doris UID-7001 on left, Patrick UID-7002 on right)
  const toggleDualMode = async () => {
    if (!dualMode) {
      try {
        const resDoris = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'doris', email: 'doris@gmail.com', password: 'doris123' }),
        });
        const dataDoris = await resDoris.json();

        const resPatrick = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'patrick', email: 'patrick@gmail.com', password: 'patrick123' }),
        });
        const dataPatrick = await resPatrick.json();

        if (resDoris.ok && resPatrick.ok) {
          saveUserSession(dataDoris.user);
          setDualUserPatrick(dataPatrick.user);
          setDualMode(true);
          return;
        }
      } catch (err) {
        console.error('Failed to init dual view:', err);
      }
    }
    setDualMode(!dualMode);
  };

  if (!currentUser && !dualMode) {
    return (
      <div className="auth-page-wrapper">
        <div className="auth-modal-card">
          <div className="auth-card-header">
            <div className="auth-brand-badge">💬</div>
            <h1 className="auth-title">
              {isLogin ? 'Sign in to Chatvia' : 'Create Chatvia Account'}
            </h1>
            <p className="auth-subtitle">
              {isLogin
                ? 'Sign in with your Username, Gmail ID, and Password'
                : 'Join Chatvia to connect with friends via User ID'}
            </p>
          </div>

          <div className="auth-nav-tabs">
            <button
              type="button"
              className={`auth-nav-tab ${isLogin ? 'active' : ''}`}
              onClick={() => {
                setIsLogin(true);
                setErrorMsg('');
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
              }}
            >
              Sign Up
            </button>
          </div>

          {errorMsg && <div className="auth-error-alert">⚠️ {errorMsg}</div>}

          <form onSubmit={handleAuthSubmit} className="auth-form-body">
            {!isLogin && (
              <div className="auth-input-group">
                <label className="auth-input-label">Full Name</label>
                <input
                  type="text"
                  className="auth-input-control"
                  placeholder="e.g. Doris Brown"
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
                placeholder="e.g. doris"
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
                placeholder="e.g. doris@gmail.com"
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

            <button type="submit" className="auth-primary-btn" disabled={loading}>
              {loading ? 'Please wait...' : isLogin ? 'Sign In' : 'Create Account'}
            </button>
          </form>

          {/* Quick 1-Click Demo Accounts */}
          <div className="auth-quick-select">
            <span className="auth-quick-title">⚡ Instant Demo Logins</span>
            <div className="quick-users-grid">
              <div
                className="quick-user-card"
                onClick={() => quickLogin('doris', 'doris@gmail.com', 'doris123')}
              >
                <img
                  src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150"
                  alt="Doris"
                  className="quick-user-avatar"
                />
                <span className="quick-user-name">Doris Brown</span>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>UID-7001</span>
              </div>

              <div
                className="quick-user-card"
                onClick={() => quickLogin('patrick', 'patrick@gmail.com', 'patrick123')}
              >
                <img
                  src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150"
                  alt="Patrick"
                  className="quick-user-avatar"
                />
                <span className="quick-user-name">Patrick H.</span>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>UID-7002</span>
              </div>

              <div
                className="quick-user-card"
                onClick={() => quickLogin('steve', 'steve@gmail.com', 'steve123')}
              >
                <img
                  src="https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150"
                  alt="Steve"
                  className="quick-user-avatar"
                />
                <span className="quick-user-name">Steve Walker</span>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>UID-7004</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Dual View Mode (Doris on left, Patrick on right)
  if (dualMode && dualUserPatrick && currentUser) {
    return (
      <div className="split-mode-container">
        <div className="split-pane-half">
          <div className="split-top-bar">
            👤 User 1: @{currentUser.username} ({currentUser.userIdCode})
          </div>
          <ChatViewPanel
            currentUser={currentUser}
            paneTitle={`@${currentUser.username}`}
            forcedActiveUserId={dualUserPatrick.id}
            onToggleSplit={toggleDualMode}
            isSplitActive={true}
            onUserUpdate={saveUserSession}
          />
        </div>

        <div className="split-pane-half">
          <div className="split-top-bar">
            👤 User 2: @{dualUserPatrick.username} ({dualUserPatrick.userIdCode})
          </div>
          <ChatViewPanel
            currentUser={dualUserPatrick}
            paneTitle={`@${dualUserPatrick.username}`}
            forcedActiveUserId={currentUser.id}
            onToggleSplit={toggleDualMode}
            isSplitActive={true}
          />
        </div>
      </div>
    );
  }

  // Single Standard Mode
  return (
    currentUser && (
      <ChatViewPanel
        currentUser={currentUser}
        onLogout={handleLogout}
        onToggleSplit={toggleDualMode}
        isSplitActive={false}
        onUserUpdate={saveUserSession}
      />
    )
  );
}
