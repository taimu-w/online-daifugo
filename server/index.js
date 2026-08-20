'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager, DISCONNECT_GRACE_MS } = require('./roomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

const manager = new RoomManager();
const wiredGames = new WeakSet();

function broadcastLobby(room) {
  io.to(room.code).emit('room:state', room.lobbyState());
}

function broadcastGame(room) {
  if (!room.game) return;
  for (const p of room.playerList) {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('game:state', room.game.getPublicState(p.id));
    }
  }
}

function wireGame(room) {
  const game = room.game;
  if (!game || wiredGames.has(game)) return;
  wiredGames.add(game);
  game.on('update', () => broadcastGame(room));
  game.on('gameEnd', () => {
    broadcastGame(room);
    broadcastLobby(room);
  });
}

io.on('connection', (socket) => {
  function getRoomAndPlayer() {
    const { roomCode, playerId } = socket.data || {};
    if (!roomCode || !playerId) return {};
    const room = manager.getRoom(roomCode);
    if (!room) return {};
    const player = room.getPlayer(playerId);
    if (!player) return { room };
    return { room, player };
  }

  socket.on('room:create', ({ name, roomCode } = {}) => {
    const { room, error: roomError } = manager.createRoom(roomCode);
    if (roomError) {
      socket.emit('error', { message: roomError });
      return;
    }
    const { player, error } = room.addPlayer(name);
    if (error) {
      socket.emit('error', { message: error });
      return;
    }
    player.socketId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.emit('joined', { playerId: player.id, roomCode: room.code, name: player.name });
    broadcastLobby(room);
  });

  socket.on('room:join', ({ roomCode, name } = {}) => {
    const room = manager.getRoom(roomCode);
    if (!room) {
      socket.emit('error', { message: 'ルームが見つかりません' });
      return;
    }
    if (room.game && !room.game.ended) {
      socket.emit('error', { message: 'ゲーム中は参加できません' });
      return;
    }
    const { player, error } = room.addPlayer(name);
    if (error) {
      socket.emit('error', { message: error });
      return;
    }
    player.socketId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.emit('joined', { playerId: player.id, roomCode: room.code, name: player.name });
    broadcastLobby(room);
  });

  socket.on('room:rejoin', ({ roomCode, playerId } = {}) => {
    const room = manager.getRoom(roomCode);
    if (!room || !room.getPlayer(playerId)) {
      socket.emit('error', { message: 'セッションが見つかりません。新しく参加してください' });
      return;
    }
    const player = room.getPlayer(playerId);
    room.clearDisconnectTimer(playerId);
    player.connected = true;
    player.socketId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    if (room.game) {
      room.game.setConnected(playerId, true);
      room.game.setAutoMode(playerId, false);
    }
    socket.emit('joined', { playerId: player.id, roomCode: room.code, name: player.name });
    broadcastLobby(room);
    if (room.game) broadcastGame(room);
  });

  socket.on('room:start', () => {
    const { room, player } = getRoomAndPlayer();
    if (!room || !player) return socket.emit('error', { message: 'ルームに参加していません' });
    const result = room.startGame(player.id);
    if (!result.ok) return socket.emit('error', { message: result.error });
    wireGame(room);
    broadcastLobby(room);
    broadcastGame(room);
  });

  socket.on('room:leave', () => {
    const { room, player } = getRoomAndPlayer();
    if (!room || !player) return;
    if (room.game && !room.game.ended) room.game.voluntaryLeave(player.id);
    room.removePlayerFromRoom(player.id);
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    broadcastLobby(room);
    if (room.game) broadcastGame(room);
    manager.deleteRoomIfEmpty(room.code);
  });

  socket.on('game:play', ({ cardIds, stairsChoice } = {}) => {
    const { room, player } = getRoomAndPlayer();
    if (!room || !player || !room.game) return;
    const result = room.game.playCards(player.id, cardIds || [], stairsChoice);
    if (!result.ok) {
      if (result.needsChoice) {
        socket.emit('game:needsChoice', {
          choiceType: result.choiceType,
          suit: result.suit,
          options: result.options,
          cardIds: cardIds || [],
        });
      } else {
        socket.emit('error', { message: result.error });
      }
    }
  });

  socket.on('game:pass', () => {
    const { room, player } = getRoomAndPlayer();
    if (!room || !player || !room.game) return;
    const result = room.game.pass(player.id);
    if (!result.ok) socket.emit('error', { message: result.error });
  });

  socket.on('game:qbomber', ({ numbers } = {}) => {
    const { room, player } = getRoomAndPlayer();
    if (!room || !player || !room.game) return;
    const result = room.game.resolveQBomber(player.id, numbers || []);
    if (!result.ok) socket.emit('error', { message: result.error });
  });

  socket.on('game:sevenGive', ({ allocation } = {}) => {
    const { room, player } = getRoomAndPlayer();
    if (!room || !player || !room.game) return;
    const result = room.game.resolveSevenGive(player.id, allocation || []);
    if (!result.ok) socket.emit('error', { message: result.error });
  });

  socket.on('game:tenDiscard', ({ cardIds } = {}) => {
    const { room, player } = getRoomAndPlayer();
    if (!room || !player || !room.game) return;
    const result = room.game.resolveTenDiscard(player.id, cardIds || []);
    if (!result.ok) socket.emit('error', { message: result.error });
  });

  socket.on('game:forfeit', () => {
    const { room, player } = getRoomAndPlayer();
    if (!room || !player || !room.game) return;
    room.game.voluntaryLeave(player.id);
  });

  socket.on('disconnect', () => {
    const { room, player } = getRoomAndPlayer();
    if (!room || !player) return;
    player.connected = false;
    player.socketId = null;
    if (room.game) room.game.setConnected(player.id, false);
    broadcastLobby(room);
    if (room.game) broadcastGame(room);

    player.disconnectTimer = setTimeout(() => {
      if (player.connected) return;
      const activeGame = room.game && !room.game.ended;
      if (activeGame) {
        room.game.setAutoMode(player.id, true);
        broadcastGame(room);
      } else {
        room.removePlayerFromRoom(player.id);
        broadcastLobby(room);
        manager.deleteRoomIfEmpty(room.code);
      }
    }, DISCONNECT_GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`オンライン大富豪サーバー起動: http://localhost:${PORT}`);
});
