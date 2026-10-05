'use strict';

const crypto = require('crypto');
const Game = require('./game/Game');
const { assignClasses, buildExchangePlan } = require('./game/classRules');

const MAX_PLAYERS = 7;
const MIN_PLAYERS = 2;
const DISCONNECT_GRACE_MS = 60 * 1000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
const CUSTOM_ROOM_CODE_MAX_LENGTH = 20;

// アイコン（プリセット写真）まわり。実URLはクライアント側の定数が持ち、
// サーバーはID・パン・ズームの数値だけを中継する（なりすまし・不正な値の混入だけ弾く）。
const AVATAR_IDS = new Set(['p1', 'p2', 'p3', 'p4', 'p5']);
const AVATAR_SCALE_MIN = 1;
const AVATAR_SCALE_MAX = 3;
const AVATAR_OFFSET_LIMIT = 60; // クライアント側のクランプ計算に多少の余裕を持たせた上限

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeAvatar(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!AVATAR_IDS.has(raw.avatarId)) return null;
  return {
    avatarId: raw.avatarId,
    scale: clampNumber(raw.scale, AVATAR_SCALE_MIN, AVATAR_SCALE_MAX, 1),
    offsetX: clampNumber(raw.offsetX, -AVATAR_OFFSET_LIMIT, AVATAR_OFFSET_LIMIT, 0),
    offsetY: clampNumber(raw.offsetY, -AVATAR_OFFSET_LIMIT, AVATAR_OFFSET_LIMIT, 0),
  };
}

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

    // 連続対戦オプション（階級制・都落ち）。オーナーがロビーでいつでもトグルでき、
    // 「もう一度プレイ」時に前回の結果を引き継いでカード交換を行う。
    this.classRule = false;
    this.miyakoOchi = false;
    this.lastRanking = null; // [{id, rank}] 直前に終了したゲームの結果（このルームで一度も終わっていなければnull）
    this.tributeBoostPlayerId = null; // 都落ち発生時、次回の献上を3枚に増やすプレイヤーID
  }

  get playerList() {
    return Array.from(this.players.values());
  }

  addPlayer(name, avatar) {
    if (this.players.size >= MAX_PLAYERS) return { error: 'ルームが満員です（最大7人）' };
    const id = genId();
    const player = {
      id,
      name: name || `プレイヤー${this.players.size + 1}`,
      connected: true,
      disconnectTimer: null,
      avatar: normalizeAvatar(avatar),
    };
    this.players.set(id, player);
    if (!this.ownerId) this.ownerId = id;
    return { player };
  }

  getPlayer(id) {
    return this.players.get(id);
  }

  setAvatar(id, avatar) {
    const player = this.players.get(id);
    if (!player) return { ok: false, error: 'プレイヤーが見つかりません' };
    player.avatar = normalizeAvatar(avatar);
    return { ok: true };
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
      players: this.playerList.map((p) => ({ id: p.id, name: p.name, connected: p.connected, isOwner: p.id === this.ownerId, avatar: p.avatar })),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      classRule: this.classRule,
      miyakoOchi: this.miyakoOchi,
    };
  }

  setOptions(byPlayerId, { classRule, miyakoOchi } = {}) {
    if (byPlayerId !== this.ownerId) return { ok: false, error: 'ルームオーナーのみ設定を変更できます' };
    if (this.game && !this.game.ended) return { ok: false, error: 'ゲーム中は設定を変更できません' };
    if (typeof classRule === 'boolean') this.classRule = classRule;
    if (typeof miyakoOchi === 'boolean') this.miyakoOchi = miyakoOchi;
    if (!this.classRule) this.miyakoOchi = false; // 階級制オフなら都落ちも無効化
    return { ok: true };
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

    let exchangePlan = null;
    let enteredClasses = null;
    let firstPlayerId = null;

    if (this.classRule && this.lastRanking) {
      const rosterIds = new Set(roster.map((p) => p.id));
      const lastIds = new Set(this.lastRanking.map((r) => r.id));
      const sameRoster = rosterIds.size === lastIds.size && [...rosterIds].every((id) => lastIds.has(id));
      if (sameRoster) {
        const orderedIds = this.lastRanking.slice().sort((a, b) => a.rank - b.rank).map((r) => r.id);
        enteredClasses = assignClasses(orderedIds);
        const boostId = this.miyakoOchi ? this.tributeBoostPlayerId : null;
        exchangePlan = buildExchangePlan(enteredClasses, boostId);
        // 前回の大貧民が今回の先手（大貧民から始まるのが階級制の慣習）
        for (const [id, cls] of enteredClasses) if (cls === 'daihinmin') firstPlayerId = id;
      }
    }

    this.game = new Game(roster, { exchangePlan, enteredClasses, firstPlayerId });
    return { ok: true, game: this.game };
  }

  // ゲーム終了時に呼ぶ。次回の階級判定・都落ち判定のために結果を保存する。
  recordGameResult(ranking, enteredClasses) {
    this.lastRanking = ranking.map((r) => ({ id: r.id, rank: r.rank }));
    this.tributeBoostPlayerId = null;
    if (enteredClasses) {
      const total = ranking.length;
      for (const r of ranking) {
        if (enteredClasses.get(r.id) === 'daifugo' && r.rank === total) {
          this.tributeBoostPlayerId = r.id; // 都落ち発生：次回は献上3枚
        }
      }
    }
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
