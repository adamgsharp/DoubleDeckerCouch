const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PLAYER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#F7DC6F',
  '#DDA0DD', '#F0B27A', '#82E0AA', '#F1948A', '#85C1E9'
];

// rooms: Map<code, { code, players: Map<socketId, player>, feed: [] }>
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getNextColor(room) {
  const used = new Set(Array.from(room.players.values()).map(p => p.color));
  return PLAYER_COLORS.find(c => !used.has(c)) ?? PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
}

function roomSnapshot(room) {
  return Array.from(room.players.values());
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on('create-room', ({ playerName }, cb) => {
    if (!playerName?.trim()) return cb({ success: false, error: 'Name required' });

    const code = generateCode();
    const room = { code, players: new Map(), feed: [] };
    rooms.set(code, room);

    socket.join(code);
    socket.roomCode = code;

    const player = {
      id: socket.id,
      name: playerName.trim(),
      color: PLAYER_COLORS[0],
      emoji: null,
      ruleName: null,
      count: 0,
      isHost: true
    };
    room.players.set(socket.id, player);

    console.log(`[room] ${code} created by "${player.name}"`);
    cb({ success: true, roomCode: code, player, players: roomSnapshot(room), feed: [] });
  });

  socket.on('join-room', ({ roomCode, playerName }, cb) => {
    const code = roomCode?.toUpperCase().trim();
    if (!code || !playerName?.trim()) return cb({ success: false, error: 'Room code and name required' });

    const room = rooms.get(code);
    if (!room) return cb({ success: false, error: 'Room not found — check the code!' });

    const nameTaken = Array.from(room.players.values())
      .some(p => p.name.toLowerCase() === playerName.trim().toLowerCase());
    if (nameTaken) return cb({ success: false, error: 'That name is taken in this room.' });

    socket.join(code);
    socket.roomCode = code;

    const player = {
      id: socket.id,
      name: playerName.trim(),
      color: getNextColor(room),
      emoji: null,
      ruleName: null,
      count: 0,
      isHost: false
    };
    room.players.set(socket.id, player);

    console.log(`[room] ${code} joined by "${player.name}"`);
    cb({ success: true, roomCode: code, player, players: roomSnapshot(room), feed: room.feed.slice(0, 30) });
    socket.to(code).emit('player-joined', { player });
  });

  socket.on('set-rule', ({ emoji, ruleName }) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !ruleName?.trim() || !emoji) return;

    player.emoji = emoji;
    player.ruleName = ruleName.trim();

    io.to(socket.roomCode).emit('rule-set', {
      playerId: socket.id,
      playerName: player.name,
      color: player.color,
      emoji: player.emoji,
      ruleName: player.ruleName
    });
  });

  socket.on('trigger-rule', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player?.ruleName) return;

    player.count++;

    const event = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      playerId: socket.id,
      playerName: player.name,
      color: player.color,
      emoji: player.emoji,
      ruleName: player.ruleName,
      count: player.count,
      timestamp: Date.now()
    };

    room.feed.unshift(event);
    if (room.feed.length > 100) room.feed.length = 100;

    io.to(socket.roomCode).emit('rule-triggered', event);
  });

  // Used by the OBS overlay to subscribe to a room without a player slot
  socket.on('watch-room', ({ roomCode }, cb) => {
    const code = roomCode?.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ success: false, error: 'Room not found' });

    socket.join(code);
    socket.watchingRoom = code;
    cb?.({ success: true, players: roomSnapshot(room), feed: room.feed.slice(0, 30) });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    const player = room.players.get(socket.id);
    room.players.delete(socket.id);
    console.log(`[-] "${player?.name}" left ${socket.roomCode}`);

    if (player) {
      io.to(socket.roomCode).emit('player-left', { playerId: socket.id, playerName: player.name });
    }

    // Clean up empty rooms after a grace period
    if (room.players.size === 0) {
      setTimeout(() => {
        if (rooms.get(socket.roomCode)?.players.size === 0) {
          rooms.delete(socket.roomCode);
          console.log(`[room] ${socket.roomCode} cleaned up`);
        }
      }, 120_000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`DoubleDeckerCouch running at http://localhost:${PORT}`);
  console.log(`OBS overlay: http://localhost:${PORT}/overlay.html?room=XXXX`);
});
