const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};
let socketRoomMap = {};
let socketUserMap = {};
let socketTokenMap = {};
let tokenStore = {};
let lastActiveMap = {};

const IDLE_THRESHOLD = 60 * 1000;

function makeMessageId() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

// 初期ルーム
const DEFAULT_ROOM_ID = 'room-1';
rooms[DEFAULT_ROOM_ID] = {
  name: 'General',
  messages: [],
  participants: {}
};

function markActive(socketId) {
  lastActiveMap[socketId] = Date.now();
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socketTokenMap[socket.id] = socket.id;
  markActive(socket.id);

  // 1) ユーザー名登録
  socket.on('joinServer', (username) => {
    markActive(socket.id);
    socketUserMap[socket.id] = username || `User-${socket.id.slice(-4)}`;
    socket.emit('roomList', getRoomList());
  });

  // (A) 名前変更
  socket.on('changeUsername', (newUsername) => {
    markActive(socket.id);
    const oldUsername = socketUserMap[socket.id];
    socketUserMap[socket.id] = newUsername || `User-${socket.id.slice(-4)}`;
    const currentRoom = socketRoomMap[socket.id];
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].participants[socket.id] = socketUserMap[socket.id];
      updateRoomParticipants(currentRoom);
      rooms[currentRoom].messages.forEach((msg) => {
        if (msg.ownerToken === socketTokenMap[socket.id]) {
          msg.user = socketUserMap[socket.id];
        }
      });
      io.to(currentRoom).emit('userNameUpdated', {
        ownerToken: socketTokenMap[socket.id],
        newUsername: socketUserMap[socket.id]
      });
    }
    console.log(`Socket ${socket.id} changed username: ${oldUsername} → ${newUsername}`);
  });

  // (B) exportState
  socket.on('exportState', (password) => {
    markActive(socket.id);
    if (!password) {
      socket.emit('exportResult', { success: false, message: 'パスワードを入力してください。' });
      return;
    }
    const oldToken = socketTokenMap[socket.id];
    const username = socketUserMap[socket.id];
    const newToken = password;
    tokenStore[newToken] = { username };

    // メッセージ・参加者情報のトークンとユーザーネームを更新
    Object.values(rooms).forEach((room) => {
      room.messages.forEach((msg) => {
        if (msg.ownerToken === oldToken) {
          msg.ownerToken = newToken;
          msg.user = username;
        }
      });
      if (room.participants[socket.id]) {
        room.participants[socket.id] = username;
      }
    });
    socketTokenMap[socket.id] = newToken;

    const currentRoom = socketRoomMap[socket.id];
    if (currentRoom) {
      updateRoomParticipants(currentRoom);
    }
    socket.emit('exportResult', { success: true, message: 'エクスポートが完了しました。' });
    console.log(`Socket ${socket.id} exported state under password '${password}'`);
  });

  // (C) importState
  socket.on('importState', (password) => {
    markActive(socket.id);
    if (!password || !tokenStore[password]) {
      socket.emit('importResult', { success: false, message: '無効なパスワードです。' });
      return;
    }
    // 読み込み前の古いトークンを保持
    const oldToken = socketTokenMap[socket.id];
    const saved = tokenStore[password];
    const newUsername = saved.username;
    socketUserMap[socket.id] = newUsername;
    socketTokenMap[socket.id] = password;

    // メッセージ・参加者情報を古いトークン→新トークンに置き換え
    Object.values(rooms).forEach((room) => {
      room.messages.forEach((msg) => {
        if (msg.ownerToken === oldToken) {
          msg.ownerToken = password;
          msg.user = newUsername;
        }
      });
      if (room.participants[socket.id]) {
        room.participants[socket.id] = newUsername;
      }
    });

    const currentRoom = socketRoomMap[socket.id];
    if (currentRoom && rooms[currentRoom]) {
      updateRoomParticipants(currentRoom);
      // クライアントに「読み込み後のユーザーネーム」を通知
      io.to(currentRoom).emit('refreshAllMessages', {
        oldToken: oldToken,
        newToken: password,
        newUsername: newUsername
      });
    }
    // importResult で newUsername を返すように変更
    socket.emit('importResult', { success: true, message: 'インポートが完了しました。', newUsername });
    console.log(`Socket ${socket.id} imported state with password '${password}'`);
  });

  // (D) 全体参加者リスト要求
  socket.on('requestAllUsers', () => {
    markActive(socket.id);
    const allUsers = Object.values(socketUserMap);
    socket.emit('allUsers', allUsers);
  });

  // 2) ルーム一覧返却
  socket.on('getRooms', () => {
    markActive(socket.id);
    socket.emit('roomList', getRoomList());
  });

  // 3) ルーム作成 → 作成者を自動的にそのルームに join
  socket.on('createRoom', (roomName) => {
    markActive(socket.id);
    const newId = `room-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    rooms[newId] = {
      name: roomName || 'New Room',
      messages: [],
      participants: {}
    };

    // （1）既存ルームから抜ける
    const prevRoom = socketRoomMap[socket.id];
    if (prevRoom && rooms[prevRoom]) {
      socket.leave(prevRoom);
      delete rooms[prevRoom].participants[socket.id];
      updateRoomParticipants(prevRoom);
    }

    // （2）新ルームに参加
    socket.join(newId);
    rooms[newId].participants[socket.id] = socketUserMap[socket.id];
    socketRoomMap[socket.id] = newId;

    // （3）新ルームの履歴を送信（空配列）
    socket.emit('roomHistory', {
      roomId: newId,
      name: rooms[newId].name,
      messages: rooms[newId].messages.slice(-500)
    });
    // 新ルームの参加者情報を送信
    updateRoomParticipants(newId);

    // （4）クライアントに「新規作成して参加した」ことを通知
    socket.emit('createdRoom', { roomId: newId, name: rooms[newId].name });

    // （5）全クライアントにルーム一覧を通知
    io.emit('roomList', getRoomList());
  });

  // 4) ルームリネーム
  socket.on('renameRoom', ({ roomId, newName }) => {
    markActive(socket.id);
    if (rooms[roomId]) {
      rooms[roomId].name = newName;
      io.emit('roomList', getRoomList());
    }
  });

  // 5) ルーム削除
  socket.on('deleteRoom', (roomId) => {
    markActive(socket.id);
    if (rooms[roomId]) {
      const participants = Object.keys(rooms[roomId].participants);
      participants.forEach((sid) => {
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          sock.leave(roomId);
          delete rooms[roomId].participants[sid];
          socketRoomMap[sid] = null;
          updateRoomParticipants(roomId);
        }
      });
      delete rooms[roomId];
      io.emit('roomList', getRoomList());
    }
  });

  // 6) ルーム参加
  socket.on('joinRoom', (roomId) => {
    markActive(socket.id);
    const prevRoom = socketRoomMap[socket.id];
    if (prevRoom && rooms[prevRoom]) {
      socket.leave(prevRoom);
      delete rooms[prevRoom].participants[socket.id];
      updateRoomParticipants(prevRoom);
    }
    if (rooms[roomId]) {
      socket.join(roomId);
      rooms[roomId].participants[socket.id] = socketUserMap[socket.id];
      socketRoomMap[socket.id] = roomId;
      markActive(socket.id);

      socket.emit('roomHistory', {
        roomId,
        name: rooms[roomId].name,
        messages: rooms[roomId].messages.slice(-500)
      });
      updateRoomParticipants(roomId);
    }
  });

  // 7) メッセージ送信
  socket.on('sendMessage', ({ roomId, content, replyTo }) => {
    markActive(socket.id);
    if (!rooms[roomId]) return;
    const msgObj = {
      id: makeMessageId(),
      user: socketUserMap[socket.id] || 'Anonymous',
      ownerToken: socketTokenMap[socket.id],
      content: content,
      timestamp: Date.now(),
      replyTo: replyTo || null
    };
    rooms[roomId].messages.push(msgObj);
    io.to(roomId).emit('newMessage', { roomId, message: msgObj });
  });

  // 8) メッセージ編集
  socket.on('editMessage', ({ roomId, messageId, newContent }) => {
    markActive(socket.id);
    if (!rooms[roomId]) return;
    const msgList = rooms[roomId].messages;
    const idx = msgList.findIndex((m) => m.id === messageId);
    if (idx !== -1 && msgList[idx].ownerToken === socketTokenMap[socket.id]) {
      msgList[idx].content = newContent;
      msgList[idx].edited = true;
      io.to(roomId).emit('messageEdited', {
        roomId,
        message: msgList[idx]
      });
    }
  });

  // 9) メッセージ削除
  socket.on('deleteMessage', ({ roomId, messageId }) => {
    markActive(socket.id);
    if (!rooms[roomId]) return;
    const msgList = rooms[roomId].messages;
    const idx = msgList.findIndex((m) => m.id === messageId);
    if (idx !== -1 && msgList[idx].ownerToken === socketTokenMap[socket.id]) {
      msgList.splice(idx, 1);
      io.to(roomId).emit('messageDeleted', { roomId, messageId });
    }
  });

  // 切断
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
    const lastRoom = socketRoomMap[socket.id];
    if (lastRoom && rooms[lastRoom]) {
      delete rooms[lastRoom].participants[socket.id];
      updateRoomParticipants(lastRoom);
    }
    delete socketRoomMap[socket.id];
    delete socketUserMap[socket.id];
    delete socketTokenMap[socket.id];
    delete lastActiveMap[socket.id];
  });
});

function getRoomList() {
  return Object.keys(rooms).map((roomId) => ({
    roomId,
    name: rooms[roomId].name
  }));
}

function updateRoomParticipants(roomId) {
  if (!rooms[roomId]) return;
  const now = Date.now();
  const participants = Object.keys(rooms[roomId].participants).map((sid) => {
    const username = rooms[roomId].participants[sid];
    const last = lastActiveMap[sid] || 0;
    const isIdle = now - last > IDLE_THRESHOLD;
    return { userId: sid, username, isIdle, ownerToken: socketTokenMap[sid] };
  });
  io.to(roomId).emit('roomParticipants', {
    roomId,
    participants
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
