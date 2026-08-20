'use strict';

const crypto = require('crypto');
const Game = require('./game/Game');

const MAX_PLAYERS = 7;
const MIN_PLAYERS = 2;
const DISCONNECT_GRACE_MS = 60 * 1000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
const CUSTOM_ROOM_CODE_MAX_LENGTH = 20;

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

function genRoomCode(existingCodes) {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (existingCodes.has(code));
  return code;
}

function normalizeCustomRoomCode(raw) {
  return (raw || '').trim().toUpperCase();
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // playerId -> {id, name, connected, disconnectTimer}
    this.ownerId = null;
    this.game = null;
    this.createdAt = Date.now();
  }

  get playerList() {
    return Array.from(this.players.values());
  }

  addPlayer(name) {
    if (this.players.size >= MAX_PLAYERS) return { error: 'ルームが満員です（最大7人）' };
    const id = genId();
    const player = { id, name: name || `プレイヤー${this.players.size + 1}`, connected: true, disconnectTimer: null };
    this.players.set(id, player);
    if (!this.ownerId) this.ownerId = id;
    return { player };
  }

  getPlayer(id) {
    return this.players.get(id);
  }

  clearDisconnectTimer(id) {
    const p = this.players.get(id);
    if (p && p.disconnectTimer) {
      clearTimeout(p.disconnectTimer);
      p.disconnectTimer = null;
    }
  }

  transferOwnerIfNeeded() {
    if (this.ownerId && this.players.has(this.ownerId)) return;
    const remaining = this.playerList;
    this.ownerId = remaining.length > 0 ? remaining[0].id : null;
  }

  removePlayerFromRoom(id) {
    this.clearDisconnectTimer(id);
    this.players.delete(id);
    this.transferOwnerIfNeeded();
  }

  isEmpty() {
    return this.players.size === 0;
  }

  lobbyState() {
    return {
      roomCode: this.code,
      ownerId: this.ownerId,
      started: !!(this.game && !this.game.ended),
      gameOver: !!(this.game && this.game.ended),
      players: this.playerList.map((p) => ({ id: p.id, name: p.name, connected: p.connected, isOwner: p.id === this.ownerId })),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    };
  }

  canStart(byPlayerId) {
    if (byPlayerId !== this.ownerId) return { ok: false, error: 'ルームオーナーのみ開始できます' };
    if (this.game && !this.game.ended) return { ok: false, error: 'すでにゲーム中です' };
    const connectedPlayers = this.playerList.filter((p) => p.connected);
    if (connectedPlayers.length < MIN_PLAYERS) return { ok: false, error: `開始には${MIN_PLAYERS}人以上必要です` };
    return { ok: true };
  }

  startGame(byPlayerId) {
    const check = this.canStart(byPlayerId);
    if (!check.ok) return check;
    const roster = this.playerList.filter((p) => p.connected).map((p) => ({ id: p.id, name: p.name }));
    this.game = new Game(roster);
    return { ok: true, game: this.game };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(customCode) {
    let code;
    if (customCode) {
      const normalized = normalizeCustomRoomCode(customCode);
      if (!normalized) return { error: 'ルームIDを入力してください' };
      if (normalized.length > CUSTOM_ROOM_CODE_MAX_LENGTH) {
        return { error: `ルームIDは${CUSTOM_ROOM_CODE_MAX_LENGTH}文字以内で入力してください` };
      }
      if (this.rooms.has(normalized)) return { error: 'このルームIDは既に使用されています' };
      code = normalized;
    } else {
      code = genRoomCode(new Set(this.rooms.keys()));
    }
    const room = new Room(code);
    this.rooms.set(code, room);
    return { room };
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  deleteRoomIfEmpty(code) {
    const room = this.rooms.get(code);
    if (room && room.isEmpty()) {
      if (room.game) room.game.destroy();
      this.rooms.delete(code);
    }
  }
}

module.exports = { RoomManager, MAX_PLAYERS, MIN_PLAYERS, DISCONNECT_GRACE_MS };
