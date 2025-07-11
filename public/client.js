// --- client.js ---
const socket = io();

// --- グローバル変数・DOM 要素取得 ---
let currentUsername = '';
let currentRoomId = null;
// 自分の ownerToken（socket.id またはパスワード）
let myOwnerToken = null;

// 「import」のときに一時的に古いトークンを保持しておく
let importOldToken = null;

const unreadRooms = new Set();
const messageCache = new Map(); // messageId → message 情報

// DOM
const usernameModal = document.getElementById('usernameModal');
const modalTitle = document.getElementById('modalTitle');
const usernameInput = document.getElementById('usernameInput');
const usernameSubmit = document.getElementById('usernameSubmit');

const roomListEl = document.getElementById('roomList');
const addRoomBtn = document.getElementById('addRoomBtn');
const currentRoomNameEl = document.getElementById('currentRoomName');
const participantsInfoEl = document.getElementById('participantsInfo');
const noSelectionMessage = document.getElementById('noSelectionMessage');
const messageContainer = document.getElementById('messageContainer');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');

const changeNameBtn = document.getElementById('changeNameBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');

const replyPreview = document.getElementById('replyPreview');

// --- 初期表示／モーダル制御 ---
let isInitialEntry = true;

function openUsernameModal(forChange = false) {
  usernameModal.style.display = 'flex';
  if (forChange) {
    modalTitle.textContent = '名前を変更してください';
    usernameInput.value = currentUsername; // currentUsername を反映
  } else {
    modalTitle.textContent = 'あなたの名前を入力してください';
    usernameInput.value = '';
  }
  usernameInput.focus();
}

function closeUsernameModal() {
  usernameModal.style.display = 'none';
}

usernameSubmit.addEventListener('click', () => {
  const v = usernameInput.value.trim() || `User-${Math.random().toString(36).slice(-4)}`;
  if (isInitialEntry) {
    currentUsername = v;
    socket.emit('joinServer', currentUsername);
    isInitialEntry = false;
  } else {
    currentUsername = v;
    socket.emit('changeUsername', currentUsername);
  }
  closeUsernameModal();
});

document.addEventListener('DOMContentLoaded', () => {
  openUsernameModal(false);
  showNoSelection();
});

usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    usernameSubmit.click();
  }
});

changeNameBtn.addEventListener('click', () => {
  openUsernameModal(true);
});

exportBtn.addEventListener('click', () => {
  const pw = prompt('書き出し用のパスワードを入力してください');
  if (!pw) return;
  socket.emit('exportState', pw);
});
socket.on('exportResult', ({ success, message }) => {
  alert(message);
});

// 「読み込み(import)」ボタンクリック時に現在のトークンを退避
importBtn.addEventListener('click', () => {
  if (myOwnerToken) {
    importOldToken = myOwnerToken;
  }
  const pw = prompt('読み込み用のパスワードを入力してください');
  if (!pw) return;
  socket.emit('importState', pw);
});
socket.on('importResult', ({ success, message, newUsername }) => {
  alert(message);
  if (success && newUsername) {
    // currentUsername を新しいユーザーネームに更新
    currentUsername = newUsername;
  }
  // ユーザーネームそのものを反映させるため、name-change モーダルや表示更新は
  // これから来る roomParticipants / refreshAllMessages イベントに任せます
});

// ── ここからルームまわり ──
function renderRoomList(rooms) {
  roomListEl.innerHTML = '';
  rooms
    .slice()
    .reverse()
    .forEach(({ roomId, name }) => {
      const li = document.createElement('li');
      li.classList.add('room-item');
      li.dataset.roomId = roomId;

      const unreadIndicator = unreadRooms.has(roomId) ? '<span class="unread-dot"></span>' : '';
      li.innerHTML = `
        <span class="room-name">${name}</span>
        ${unreadIndicator}
        <div class="room-actions">
          <button class="renameBtn" title="リネーム">✏️</button>
          <button class="deleteBtn" title="削除">🗑️</button>
        </div>
      `;
      if (roomId === currentRoomId) {
        li.classList.add('selected');
      }
      roomListEl.appendChild(li);
    });
}

socket.on('roomList', (rooms) => {
  renderRoomList(rooms);

  // ── 自分のいるルームが消えていたら未選択に戻す ──
  const exists = rooms.some((r) => r.roomId === currentRoomId);
  if (!exists && currentRoomId !== null) {
    currentRoomId = null;
    currentRoomNameEl.textContent = '(未選択)';
    participantsInfoEl.textContent = '(参加者数: 0)';
    messageContainer.innerHTML = '';
    hideReplyPreview();
    showNoSelection();
  }
});

addRoomBtn.addEventListener('click', () => {
  const roomName = prompt('ルーム名を入力してください');
  if (roomName) {
    socket.emit('createRoom', roomName);
  }
});

// サーバーから「createdRoom」を受け取ったら、自動的に移動
socket.on('createdRoom', ({ roomId, name }) => {
  currentRoomId = roomId;

  // チャット欄をクリア（作成前のメッセージが残らないように）
  messageContainer.innerHTML = '';

  // 画面上部のルーム名を更新
  currentRoomNameEl.textContent = name;
  // 参加者表示はこれから来る roomParticipants によって上書きされるので、
  // とりあえず「参加者数: 1 (自分のみ)」を仮表示
  participantsInfoEl.textContent = `(参加者数: 1) ${currentUsername}`;

  // ルーム一覧のハイライト更新
  document.querySelectorAll('.room-item').forEach((elem) => {
    elem.classList.toggle('selected', elem.dataset.roomId === roomId);
  });

  // チャット欄を有効化
  hideNoSelection();

  // メッセージ入力欄に自動的にフォーカス
  messageInput.focus();

  // 最新のルーム一覧をもらってサイドバーを更新
  socket.emit('getRooms');
});

// ルーム一覧クリック時
roomListEl.addEventListener('click', (e) => {
  const li = e.target.closest('.room-item');
  if (!li) return;
  const roomId = li.dataset.roomId;

  if (e.target.classList.contains('renameBtn')) {
    const newName = prompt('新しいルーム名を入力してください');
    if (newName) {
      socket.emit('renameRoom', { roomId, newName });
    }
    return;
  }
  if (e.target.classList.contains('deleteBtn')) {
    if (confirm('本当にこのルームを削除しますか？')) {
      socket.emit('deleteRoom', roomId);
    }
    return;
  }

  if (unreadRooms.has(roomId)) {
    unreadRooms.delete(roomId);
  }

  currentRoomId = roomId;
  socket.emit('joinRoom', roomId);

  document.querySelectorAll('.room-item').forEach((elem) => {
    elem.classList.toggle('selected', elem.dataset.roomId === roomId);
  });
  socket.emit('getRooms');
  hideNoSelection();
});

// ── 参加者情報更新 ──
let participantsMap = {}; // ownerToken → { username, isIdle }

socket.on('roomParticipants', ({ roomId, participants }) => {
  if (roomId === currentRoomId) {
    participantsMap = {};
    participants.forEach(({ userId, username, isIdle, ownerToken }) => {
      participantsMap[ownerToken] = { username, isIdle };
      if (socket.id === userId) {
        myOwnerToken = ownerToken;
      }
    });
    updateParticipantsInfo();
    Object.keys(participantsMap).forEach((token) => {
      updateAllMessagesAuthor(token, participantsMap[token].username);
    });
    updateAllOwnMarks();
    updateAllEditButtons();
    updateAllReplyPreviews();
  }
});

// インポート直後にサーバー側で更新されたメッセージを再描画するためのイベント
socket.on('refreshAllMessages', ({ oldToken, newToken, newUsername }) => {
  // メッセージ要素の data-owner-token を置き換えつつ、
  // 既存の DOM にあるユーザーネームも新ユーザーネームに書き換える
  document
    .querySelectorAll(`.message[data-owner-token="${oldToken}"]`)
    .forEach((msgDiv) => {
      // data-owner-token を新トークンに置換
      msgDiv.dataset.ownerToken = newToken;
      // .meta .username のテキストを新ユーザーネームに
      const usernameSpan = msgDiv.querySelector('.meta .username');
      if (usernameSpan) {
        usernameSpan.textContent = newUsername;
      }
    });
  // importOldToken をクリア
  importOldToken = null;
});

// 「refreshAllMessages」に続いて、新しい roomParticipants／roomHistory が来る流れで
// 再描画および最新情報の反映がされる

/**
 * 参加者数の隣にユーザーネームを表示
 * → innerHTML ではなく textContent ＋ append で title 属性が消えないように
 */
function updateParticipantsInfo() {
  const tokens = Object.keys(participantsMap);
  const count = tokens.length;

  if (count === 0) {
    participantsInfoEl.textContent = '(参加者数: 0)';
    return;
  }
  participantsInfoEl.textContent = `(参加者数: ${count}) `;
  tokens.forEach((token, idx) => {
    const { username, isIdle } = participantsMap[token];
    const span = document.createElement('span');
    span.classList.add('participant-name');
    if (isIdle) span.classList.add('idle');
    span.textContent = username;
    participantsInfoEl.appendChild(span);
    if (idx !== tokens.length - 1) {
      participantsInfoEl.append(', ');
    }
  });
}

// ── サイト全体参加ユーザー情報の取得＆ツールチップ表示 ──
participantsInfoEl.addEventListener('mouseenter', () => {
  socket.emit('requestAllUsers');
});
socket.on('allUsers', (userList) => {
  const count = userList.length;
  const titleText = `サイト全体 (${count}名): ${userList.join(', ')}`;
  participantsInfoEl.title = titleText;
});
participantsInfoEl.addEventListener('mouseleave', () => {
  participantsInfoEl.removeAttribute('title');
});

// ── 「スレッド未選択時」の表示切替──
function showNoSelection() {
  noSelectionMessage.style.display = 'flex';
  messageContainer.style.display = 'none';
  sendBtn.disabled = true;
  messageInput.disabled = true;
  replyPreview.style.display = 'none';
  currentRoomNameEl.textContent = '(未選択)';
  participantsInfoEl.textContent = '(参加者数: 0)';
}

function hideNoSelection() {
  noSelectionMessage.style.display = 'none';
  messageContainer.style.display = 'block';
  sendBtn.disabled = false;
  messageInput.disabled = false;
}

// ── 返信プレビューを隠す ──
function hideReplyPreview() {
  replyPreview.innerHTML = '';
  replyPreview.style.display = 'none';
}

// ── チャット履歴受信 ──
socket.on('roomHistory', ({ roomId, name, messages }) => {
  if (roomId !== currentRoomId) return;
  currentRoomNameEl.textContent = name;
  // チャット欄をクリア
  messageContainer.innerHTML = '';
  messageCache.clear();
  messages.forEach((msg) => {
    messageCache.set(msg.id, msg);
    appendMessageToContainer(msg, msg.ownerToken === myOwnerToken);
  });
  scrollToBottom();
});

// ── 新着メッセージ ──
socket.on('newMessage', ({ roomId, message }) => {
  messageCache.set(message.id, message);
  if (roomId !== currentRoomId) {
    unreadRooms.add(roomId);
    socket.emit('getRooms');
  } else {
    appendMessageToContainer(message, message.ownerToken === myOwnerToken);
    scrollToBottom();
  }
});

// ── メッセージ編集 ──
socket.on('messageEdited', ({ roomId, message }) => {
  if (roomId !== currentRoomId) return;
  messageCache.set(message.id, message);
  const el = document.querySelector(`.message[data-id="${message.id}"]`);
  if (el) {
    el.querySelector('.content').innerHTML = linkify(message.content);
    const metaEl = el.querySelector('.meta .edited-label');
    if (message.edited && !metaEl) {
      const newEditedLabel = document.createElement('span');
      newEditedLabel.classList.add('edited-label');
      newEditedLabel.textContent = '(編集済み)';
      el.querySelector('.meta').appendChild(newEditedLabel);
    }
  }
});

// ── メッセージ削除 ──
socket.on('messageDeleted', ({ roomId, messageId }) => {
  if (roomId !== currentRoomId) return;
  messageCache.delete(messageId);
  const el = document.querySelector(`.message[data-id="${messageId}"]`);
  if (el) el.remove();
});

// ── ユーザーネーム変更通知 ──
socket.on('userNameUpdated', ({ ownerToken, newUsername }) => {
  // 参加者リストに存在していれば更新しつつ、メッセージ内も書き換える
  if (participantsMap[ownerToken]) {
    participantsMap[ownerToken].username = newUsername;
    updateParticipantsInfo();
    updateAllMessagesAuthor(ownerToken, newUsername);
  }
});

// ── メッセージ送信／編集処理 ──
sendBtn.addEventListener('click', () => {
  sendMessage();
});
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function sendMessage() {
  if (!currentRoomId) return;
  const content = messageInput.value.trim();
  if (!content) return;
  const editingMessageId = messageInput.dataset.editingId;
  const replyToId = messageInput.dataset.replyToId || null;

  if (editingMessageId) {
    socket.emit('editMessage', {
      roomId: currentRoomId,
      messageId: editingMessageId,
      newContent: content
    });
    delete messageInput.dataset.editingId;
    sendBtn.textContent = '送信';
  } else {
    socket.emit('sendMessage', {
      roomId: currentRoomId,
      content,
      replyTo: replyToId
    });
  }
  messageInput.value = '';
  delete messageInput.dataset.replyToId;
  hideReplyPreview();
}

// ── リンクを検出して <a> にするヘルパー ──
function linkify(text) {
  const urlRegex = /(\bhttps?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

// ── メッセージ要素を追加 ──
function appendMessageToContainer(message, isOwn) {
  const msgDiv = document.createElement('div');
  msgDiv.classList.add('message');
  if (isOwn) msgDiv.classList.add('own');
  msgDiv.dataset.id = message.id;
  msgDiv.dataset.ownerToken = message.ownerToken;

  // メタ情報
  const metaDiv = document.createElement('div');
  metaDiv.classList.add('meta');
  const usernameSpan = document.createElement('span');
  usernameSpan.classList.add('username');
  usernameSpan.textContent = message.user;

  const timestampSpan = document.createElement('span');
  timestampSpan.classList.add('timestamp');
  const dt = new Date(message.timestamp);
  const month = dt.getMonth() + 1;
  const day = dt.getDate();
  const timeStr = dt.toLocaleTimeString();
  timestampSpan.textContent = `${month}/${day} ${timeStr}`;

  metaDiv.appendChild(usernameSpan);
  metaDiv.appendChild(timestampSpan);

  if (message.edited) {
    const editedLabel = document.createElement('span');
    editedLabel.classList.add('edited-label');
    editedLabel.textContent = '(編集済み)';
    metaDiv.appendChild(editedLabel);
  }
  msgDiv.appendChild(metaDiv);

  // 返信先プレビュー
  if (message.replyTo) {
    const refMsg = messageCache.get(message.replyTo);
    if (refMsg) {
      const previewDiv = document.createElement('div');
      previewDiv.classList.add('reply-preview');
      const refUserSpan = document.createElement('div');
      refUserSpan.classList.add('reply-username');
      refUserSpan.textContent = refMsg.user;
      const refContentSpan = document.createElement('div');
      refContentSpan.classList.add('reply-content');
      refContentSpan.textContent = refMsg.content.length > 50
        ? refMsg.content.slice(0, 50) + '…'
        : refMsg.content;
      previewDiv.appendChild(refUserSpan);
      previewDiv.appendChild(refContentSpan);
      msgDiv.appendChild(previewDiv);
    }
  }

  // 本文（リンク化）
  const contentDiv = document.createElement('div');
  contentDiv.classList.add('content');
  contentDiv.innerHTML = linkify(message.content);
  msgDiv.appendChild(contentDiv);

  // アクション
  const actionsDiv = document.createElement('div');
  actionsDiv.classList.add('actions');

  // 返信ボタン
  const replyBtn = document.createElement('button');
  replyBtn.textContent = '返信';
  replyBtn.addEventListener('click', () => {
    showReplyPreview(message.id);
    messageInput.focus(); // フォーカスを戻す
  });
  actionsDiv.appendChild(replyBtn);

  // 自分のメッセージなら編集・削除
  if (isOwn) {
    const editBtn = document.createElement('button');
    editBtn.textContent = '編集';
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '削除';
    actionsDiv.appendChild(editBtn);
    actionsDiv.appendChild(deleteBtn);
    editBtn.addEventListener('click', () => {
      messageInput.value = message.content;
      messageInput.focus();
      sendBtn.textContent = '更新';
      messageInput.dataset.editingId = message.id;
    });
    deleteBtn.addEventListener('click', () => {
      if (confirm('本当にこのメッセージを削除しますか？')) {
        socket.emit('deleteMessage', {
          roomId: currentRoomId,
          messageId: message.id
        });
      }
    });
  }

  msgDiv.appendChild(actionsDiv);
  messageContainer.appendChild(msgDiv);
}

// ── 自動スクロール ──
function scrollToBottom() {
  messageContainer.scrollTop = messageContainer.scrollHeight;
}

// ── ユーザー名更新: メッセージ上の表示を更新 ──
function updateAllMessagesAuthor(ownerToken, newUsername) {
  const nodes = document.querySelectorAll(`.message[data-owner-token="${ownerToken}"]`);
  nodes.forEach((msgDiv) => {
    const usernameSpan = msgDiv.querySelector('.meta .username');
    if (usernameSpan) {
      usernameSpan.textContent = newUsername;
      if (participantsMap[ownerToken]?.isIdle) {
        usernameSpan.style.color = '#888';
        usernameSpan.style.fontStyle = 'italic';
      } else {
        usernameSpan.style.color = '';
        usernameSpan.style.fontStyle = '';
      }
    }
  });
}

// ── 自分のメッセージ目印を後付け ──
function updateAllOwnMarks() {
  document.querySelectorAll('.message').forEach((msgDiv) => {
    const token = msgDiv.dataset.ownerToken;
    if (token === myOwnerToken) {
      msgDiv.classList.add('own');
    }
  });
}

// ── 自分のメッセージに編集・削除を後付け ──
function updateAllEditButtons() {
  document.querySelectorAll('.message').forEach((msgDiv) => {
    const token = msgDiv.dataset.ownerToken;
    if (token === myOwnerToken && !msgDiv.querySelector('.actions button:nth-child(2)')) {
      const actionsDiv = msgDiv.querySelector('.actions');
      const messageId = msgDiv.dataset.id;

      const editBtn = document.createElement('button');
      editBtn.textContent = '編集';
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '削除';
      actionsDiv.appendChild(editBtn);
      actionsDiv.appendChild(deleteBtn);

      editBtn.addEventListener('click', () => {
        messageInput.value = msgDiv.querySelector('.content').textContent;
        messageInput.focus();
        sendBtn.textContent = '更新';
        messageInput.dataset.editingId = messageId;
      });
      deleteBtn.addEventListener('click', () => {
        if (confirm('本当にこのメッセージを削除しますか？')) {
          socket.emit('deleteMessage', {
            roomId: currentRoomId,
            messageId: messageId
          });
        }
      });
    }
  });
}

// ── 返信プレビューを表示 ──
function showReplyPreview(messageId) {
  const refMsg = messageCache.get(messageId);
  if (!refMsg) return;
  replyPreview.innerHTML = '';
  const clearBtn = document.createElement('span');
  clearBtn.textContent = '×';
  clearBtn.style.float = 'right';
  clearBtn.style.cursor = 'pointer';
  clearBtn.addEventListener('click', () => {
    hideReplyPreview();
    delete messageInput.dataset.replyToId;
    messageInput.focus();
  });
  const refUserSpan = document.createElement('div');
  refUserSpan.classList.add('reply-username');
  refUserSpan.textContent = refMsg.user;
  const refContentSpan = document.createElement('div');
  refContentSpan.classList.add('reply-content');
  refContentSpan.textContent = refMsg.content.length > 50
    ? refMsg.content.slice(0, 50) + '…'
    : refMsg.content;

  replyPreview.appendChild(clearBtn);
  replyPreview.appendChild(refUserSpan);
  replyPreview.appendChild(refContentSpan);
  replyPreview.style.display = 'block';
  messageInput.dataset.replyToId = messageId;
  messageInput.focus();
}

function hideReplyPreview() {
  replyPreview.innerHTML = '';
  replyPreview.style.display = 'none';
}

// ── 既存メッセージに返信プレビューを再適用 ──
function updateAllReplyPreviews() {
  document.querySelectorAll('.message').forEach((msgDiv) => {
    const messageId = msgDiv.dataset.id;
    const msgObj = messageCache.get(messageId);
    const existing = msgDiv.querySelector('.reply-preview');
    if (existing) existing.remove();

    if (msgObj.replyTo) {
      const refMsg = messageCache.get(msgObj.replyTo);
      if (refMsg) {
        const previewDiv = document.createElement('div');
        previewDiv.classList.add('reply-preview');
        const refUserSpan = document.createElement('div');
        refUserSpan.classList.add('reply-username');
        refUserSpan.textContent = refMsg.user;
        const refContentSpan = document.createElement('div');
        refContentSpan.classList.add('reply-content');
        refContentSpan.textContent = refMsg.content.length > 50
          ? refMsg.content.slice(0, 50) + '…'
          : refMsg.content;
        previewDiv.appendChild(refUserSpan);
        previewDiv.appendChild(refContentSpan);
        const contentNode = msgDiv.querySelector('.content');
        msgDiv.insertBefore(previewDiv, contentNode);
      }
    }
  });
}
