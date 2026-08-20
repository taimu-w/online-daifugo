'use strict';

const EventEmitter = require('events');
const { createDeck, shuffle, JOKER_RANK, isStrongestNormalRank, sortHand, rankLabel, cardLabel } = require('./cards');
const { classifyHand, canBeat } = require('./handEvaluator');

const TURN_TIMEOUT_MS = 60 * 1000;
const QBOMBER_TIMEOUT_MS = 60 * 1000;
const SEVEN_TIMEOUT_MS = 60 * 1000;
const TEN_DISCARD_TIMEOUT_MS = 60 * 1000;

const ALL_NORMAL_RANKS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

function suitsOfCards(cards) {
  const s = new Set();
  for (const c of cards) if (!c.joker) s.add(c.suit);
  return s;
}

function setSubsetSatisfiable(requiredSuits, presentSuits, jokerCount) {
  if (!requiredSuits || requiredSuits.size === 0) return true;
  let missing = 0;
  for (const s of requiredSuits) if (!presentSuits.has(s)) missing++;
  return missing <= jokerCount;
}

function intersectSets(a, b) {
  const out = new Set();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

class Game extends EventEmitter {
  constructor(players) {
    // players: [{id, name}]
    super();
    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      hand: [],
      status: 'active', // active | finished | foul | left
      rank: null,
      seatIndex: i,
      connected: true,
      autoMode: false,
    }));
    this.seatOrder = this.players.map((p) => p.id);
    this.totalPlayers = this.players.length;

    this.field = { hand: null, cards: [], ownerId: null };
    this.chain = { previousSuits: null, mandatorySuits: null };
    this.revolution = false;
    this.jbackActive = false;
    this.passCount = 0;

    this.nextTopRank = 1;
    this.nextBottomRank = this.totalPlayers;

    this.currentPlayerId = null;
    this.pendingQueue = [];
    this.pendingAction = null; // {type, by, count, deadline, ...}
    this.finalContext = null;

    this.turnTimer = null;
    this.actionTimer = null;
    this.log = [];
    this.ended = false;
    this.loserReveal = null; // 最下位が残していた手札（ゲーム終了時のみ設定）

    this._deal();
    const spade3Holder = this.players.find((p) => p.hand.some((c) => !c.joker && c.suit === 'S' && c.rank === 3));
    this.currentPlayerId = spade3Holder ? spade3Holder.id : this.seatOrder[0];
    this._pushLog(`ゲーム開始。${this.getPlayer(this.currentPlayerId).name} のターンです。`);
    this._startTurnTimer();
  }

  // ---------- 基本ユーティリティ ----------

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  getActivePlayers() {
    return this.players.filter((p) => p.status === 'active');
  }

  get reversed() {
    return this.revolution !== this.jbackActive; // XOR
  }

  _pushLog(message) {
    this.log.push({ message, at: Date.now() });
    if (this.log.length > 200) this.log.shift();
  }

  _deal() {
    const deck = shuffle(createDeck());
    let i = 0;
    for (const card of deck) {
      const player = this.players[i % this.players.length];
      player.hand.push(card);
      i++;
    }
    for (const p of this.players) p.hand = sortHand(p.hand);
  }

  _clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  _clearActionTimer() {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }

  _startTurnTimer() {
    this._clearTurnTimer();
    if (this.ended) return;
    this.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
    this.turnTimer = setTimeout(() => this._handleTurnTimeout(), TURN_TIMEOUT_MS);
  }

  _nextActivePlayerId(afterId) {
    const active = this.getActivePlayers();
    if (active.length === 0) return null;
    const order = this.seatOrder;
    const startIdx = order.indexOf(afterId);
    for (let step = 1; step <= order.length; step++) {
      const id = order[(startIdx + step) % order.length];
      const p = this.getPlayer(id);
      if (p && p.status === 'active') return id;
    }
    return null;
  }

  // ---------- 公開状態 ----------

  getPublicState(viewerId) {
    return {
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        status: p.status,
        rank: p.rank,
        connected: p.connected,
        autoMode: p.autoMode,
        isCurrentTurn: p.id === this.currentPlayerId,
      })),
      field: {
        cards: this.field.cards,
        kind: this.field.hand ? this.field.hand.kind : null,
        ownerId: this.field.ownerId,
      },
      revolution: this.revolution,
      jbackActive: this.jbackActive,
      reversed: this.reversed,
      shibari: this.chain.mandatorySuits ? Array.from(this.chain.mandatorySuits) : null,
      currentPlayerId: this.currentPlayerId,
      turnDeadline: this.turnDeadline || null,
      pendingAction: this.pendingAction,
      myHand: viewerId ? sortHand(this.getPlayer(viewerId)?.hand || []) : [],
      log: this.log.slice(-30),
      ended: this.ended,
      finalRanking: this.ended ? this._rankingSummary() : null,
      loserReveal: this.ended ? this.loserReveal : null,
    };
  }

  _rankingSummary() {
    return this.players
      .map((p) => ({ id: p.id, name: p.name, rank: p.rank, status: p.status }))
      .sort((a, b) => (a.rank || 99) - (b.rank || 99));
  }

  // ---------- プレイ ----------

  playCards(playerId, cardIds, stairsChoice) {
    if (this.ended) return { ok: false, error: 'ゲームは終了しています' };
    if (this.pendingAction) return { ok: false, error: '特殊効果の処理待ちです' };
    if (this.currentPlayerId !== playerId) return { ok: false, error: 'あなたの番ではありません' };
    const player = this.getPlayer(playerId);
    if (!player || player.status !== 'active') return { ok: false, error: '操作できません' };

    if (!cardIds || cardIds.length === 0) return { ok: false, error: 'カードを選択してください' };
    const cards = [];
    for (const id of cardIds) {
      const c = player.hand.find((h) => h.id === id);
      if (!c) return { ok: false, error: '手札にないカードが含まれています' };
      cards.push(c);
    }

    const hand = classifyHand(cards, stairsChoice);
    if (!hand.ok) {
      if (hand.needsChoice) {
        return { ok: false, needsChoice: true, choiceType: hand.choiceType, suit: hand.suit, options: hand.options, error: hand.error };
      }
      return { ok: false, error: hand.error };
    }

    const jokerCount = cards.filter((c) => c.joker).length;

    // スペ3返し判定
    const isSpade3Return =
      this.field.hand &&
      this.field.hand.kind === 'single' &&
      this.field.hand.rank === JOKER_RANK &&
      hand.kind === 'single' &&
      hand.length === 1 &&
      cards[0].suit === 'S' &&
      cards[0].rank === 3;

    if (!isSpade3Return) {
      if (this.field.hand && !canBeat(this.field.hand, hand, this.reversed)) {
        return { ok: false, error: '場の役より強い、同じ種類・枚数の役を出してください' };
      }
      if (!this.field.hand) {
        // 場が空でも縛りが残っていることは通常無いが念のためリセット済み前提
      }
    }

    // マーク縛りチェック（このプレイに対して、直前までの mandatorySuits を満たすか）
    if (this.chain.mandatorySuits && !isSpade3Return) {
      const presentSuits = suitsOfCards(cards);
      if (!setSubsetSatisfiable(this.chain.mandatorySuits, presentSuits, jokerCount)) {
        const req = Array.from(this.chain.mandatorySuits).join('');
        return { ok: false, error: `マーク縛り中です。${req} を含む役を出してください` };
      }
    }

    // ---- 確定：手札から取り除く ----
    const cardIdSet = new Set(cards.map((c) => c.id));
    player.hand = player.hand.filter((c) => !cardIdSet.has(c.id));

    this._clearTurnTimer();

    if (isSpade3Return) {
      this._pushLog(`${player.name} が ♠3返し！ 場を流します。`);
      this._flowField();
      this.currentPlayerId = playerId;
      this.finalContext = { playerId, playedCards: cards, nextTurnId: playerId, fieldFlowedByEight: true };
      return this._finalizePlay(player, cards, { skipRevolutionEtc: true });
    }

    this.field.hand = hand;
    this.field.cards = cards;
    this.field.ownerId = playerId;
    this.passCount = 0;

    // 縛り判定
    this._updateShibari(cards);

    let nextTurnId = this._nextActivePlayerId(playerId);
    let fieldFlowedByEight = false;

    // 革命判定
    if ((hand.kind === 'multi' && hand.length >= 4 && !hand.jokerPair) || (hand.kind === 'stairs' && hand.length >= 4)) {
      this.revolution = !this.revolution;
      this._pushLog(`${this.revolution ? '革命発生！強さが逆転しました。' : '革命返し！強さが元に戻りました。'}`);
    }

    // ジョーカーは任意の数字として扱われるため、7/8/10/J/Qと同じ組（single/multi）で
    // 出された場合はジョーカーの枚数も効果の対象枚数に含める。
    // 階段の場合は、実際にその数字のカードが含まれているか、
    // ジョーカーがその数字の役割を担っている（jokerSlotRanks）場合に発動する。
    const hasRank = (rank) => {
      if (cards.some((c) => !c.joker && c.rank === rank)) return true;
      return hand.kind === 'stairs' && hand.jokerSlotRanks && hand.jokerSlotRanks.has(rank);
    };
    const countRankEffect = (rank) => {
      if ((hand.kind === 'single' || hand.kind === 'multi') && hand.rank === rank) {
        return hand.length;
      }
      if (hand.kind === 'stairs') {
        return hasRank(rank) ? 1 : 0;
      }
      return 0;
    };

    // 8切り判定
    if (hasRank(8)) {
      this._pushLog(`${player.name} が8切り！ 場を流します。`);
      this._flowField();
      nextTurnId = playerId;
      fieldFlowedByEight = true;
    }

    // Jバック判定
    if (hasRank(11)) {
      this.jbackActive = !this.jbackActive;
      this._pushLog(`Jバック発動。強さが${this.jbackActive ? '反転' : '元に戻りました'}。`);
    }

    this.pendingQueue = [];
    const qCount = countRankEffect(12);
    const sevenCount = countRankEffect(7);
    const tenCount = countRankEffect(10);
    if (qCount > 0) this.pendingQueue.push({ type: 'qbomber', count: qCount });
    if (sevenCount > 0) this.pendingQueue.push({ type: 'sevenGive', count: sevenCount });
    if (tenCount > 0) this.pendingQueue.push({ type: 'tenDiscard', count: tenCount });

    this.finalContext = { playerId, playedCards: cards, nextTurnId, fieldFlowedByEight };

    if (this.pendingQueue.length > 0) {
      this._advancePendingQueue();
      return { ok: true };
    }

    return this._finalizePlay(player, cards, {});
  }

  _updateShibari(cards) {
    const thisSuits = suitsOfCards(cards);
    if (this.chain.previousSuits !== null) {
      const overlap = intersectSets(this.chain.previousSuits, thisSuits);
      if (this.chain.mandatorySuits === null) {
        if (overlap.size > 0) {
          this.chain.mandatorySuits = overlap;
          this._pushLog(`マーク縛り発生（${Array.from(overlap).join('')}）`);
        }
      } else {
        this.chain.mandatorySuits = overlap.size > 0 ? overlap : this.chain.mandatorySuits;
      }
    }
    this.chain.previousSuits = thisSuits;
  }

  _flowField() {
    this.field.hand = null;
    this.field.cards = [];
    this.field.ownerId = null;
    this.chain.previousSuits = null;
    this.chain.mandatorySuits = null;
    this.jbackActive = false;
    this.passCount = 0;
  }

  // ---------- Qボンバー ----------

  _advancePendingQueue() {
    if (this.pendingQueue.length === 0) {
      this._concludeTurn();
      return;
    }
    const next = this.pendingQueue.shift();
    let timeoutMs = QBOMBER_TIMEOUT_MS;
    if (next.type === 'qbomber') {
      this.pendingAction = {
        type: 'qbomber',
        by: this.finalContext.playerId,
        count: next.count,
        deadline: Date.now() + QBOMBER_TIMEOUT_MS,
        options: ALL_NORMAL_RANKS,
      };
      timeoutMs = QBOMBER_TIMEOUT_MS;
      this._pushLog(`${this.getPlayer(this.finalContext.playerId).name} がQボンバー！ 数字を${next.count}個選択中...`);
    } else if (next.type === 'sevenGive') {
      const giver = this.getPlayer(this.finalContext.playerId);
      const maxGive = Math.min(next.count, giver.hand.length);
      this.pendingAction = {
        type: 'sevenGive',
        by: this.finalContext.playerId,
        count: maxGive,
        deadline: Date.now() + SEVEN_TIMEOUT_MS,
      };
      timeoutMs = SEVEN_TIMEOUT_MS;
      this._pushLog(`${giver.name} が7わたし！ ${maxGive}枚を配布先選択中...`);
      if (maxGive === 0) {
        this.pendingAction = null;
        this._advancePendingQueue();
        return;
      }
    } else if (next.type === 'tenDiscard') {
      const discarder = this.getPlayer(this.finalContext.playerId);
      const maxDiscard = Math.min(next.count, discarder.hand.length);
      this.pendingAction = {
        type: 'tenDiscard',
        by: this.finalContext.playerId,
        count: maxDiscard,
        deadline: Date.now() + TEN_DISCARD_TIMEOUT_MS,
      };
      timeoutMs = TEN_DISCARD_TIMEOUT_MS;
      this._pushLog(`${discarder.name} が10捨て！ ${maxDiscard}枚を手札から選択中...`);
      if (maxDiscard === 0) {
        this.pendingAction = null;
        this._advancePendingQueue();
        return;
      }
    }
    this._clearActionTimer();
    this.actionTimer = setTimeout(() => this._handleActionTimeout(), timeoutMs);
    this.emit('update');
  }

  resolveQBomber(playerId, numbers) {
    if (this.ended) return { ok: false, error: 'ゲームは終了しています' };
    if (!this.pendingAction || this.pendingAction.type !== 'qbomber') return { ok: false, error: '対象の操作がありません' };
    if (this.pendingAction.by !== playerId) return { ok: false, error: '選択権がありません' };
    const count = this.pendingAction.count;
    const uniq = Array.from(new Set(numbers)).filter((n) => ALL_NORMAL_RANKS.includes(n));
    if (uniq.length !== count) return { ok: false, error: `${count}個の異なる数字を選択してください` };
    this._clearActionTimer();
    this._applyQBomber(uniq);
    this.pendingAction = null;
    this._advancePendingQueue();
    return { ok: true };
  }

  _applyQBomber(numbers) {
    const numSet = new Set(numbers);
    this._pushLog(`指定数字: ${numbers.map((n) => rankLabel(n)).join(', ')} → 全員が廃棄`);
    for (const p of this.players) {
      if (p.status !== 'active') continue;
      const before = p.hand.length;
      p.hand = p.hand.filter((c) => !(!c.joker && numSet.has(c.rank)));
      const discarded = before - p.hand.length;
      if (discarded > 0) this._pushLog(`${p.name} が${discarded}枚廃棄`);
    }
    // 廃棄で0枚になったプレイヤーをあがり処理（反則判定なし）
    this._checkZeroHandAgariForAll();
  }

  // ---------- 7わたし ----------

  resolveSevenGive(playerId, allocation) {
    // allocation: [{cardId, toPlayerId}]
    if (this.ended) return { ok: false, error: 'ゲームは終了しています' };
    if (!this.pendingAction || this.pendingAction.type !== 'sevenGive') return { ok: false, error: '対象の操作がありません' };
    if (this.pendingAction.by !== playerId) return { ok: false, error: '選択権がありません' };
    const giver = this.getPlayer(playerId);
    const needed = this.pendingAction.count;
    if (!Array.isArray(allocation) || allocation.length !== needed) {
      return { ok: false, error: `${needed}枚を指定してください` };
    }
    const usedIds = new Set();
    for (const a of allocation) {
      if (usedIds.has(a.cardId)) return { ok: false, error: 'カードが重複しています' };
      usedIds.add(a.cardId);
      const card = giver.hand.find((c) => c.id === a.cardId);
      if (!card) return { ok: false, error: '手札にないカードです' };
      const target = this.getPlayer(a.toPlayerId);
      if (!target || target.status !== 'active' || target.id === giver.id) {
        return { ok: false, error: '渡し先が不正です' };
      }
    }
    this._clearActionTimer();
    this._applySevenGive(giver, allocation);
    this.pendingAction = null;
    this._advancePendingQueue();
    return { ok: true };
  }

  _applySevenGive(giver, allocation) {
    for (const a of allocation) {
      const idx = giver.hand.findIndex((c) => c.id === a.cardId);
      if (idx === -1) continue;
      const [card] = giver.hand.splice(idx, 1);
      const target = this.getPlayer(a.toPlayerId);
      target.hand.push(card);
      target.hand = sortHand(target.hand);
      this._pushLog(`${giver.name} → ${target.name} へ ${cardLabel(card)} を渡しました`);
    }
    if (giver.hand.length === 0) {
      this._finishPlayer(giver.id, { legit: true });
    }
  }

  // ---------- 10捨て ----------

  resolveTenDiscard(playerId, cardIds) {
    if (this.ended) return { ok: false, error: 'ゲームは終了しています' };
    if (!this.pendingAction || this.pendingAction.type !== 'tenDiscard') return { ok: false, error: '対象の操作がありません' };
    if (this.pendingAction.by !== playerId) return { ok: false, error: '選択権がありません' };
    const discarder = this.getPlayer(playerId);
    const needed = this.pendingAction.count;
    const uniqIds = Array.from(new Set(cardIds || []));
    if (uniqIds.length !== needed) return { ok: false, error: `${needed}枚を選択してください` };
    for (const id of uniqIds) {
      if (!discarder.hand.some((c) => c.id === id)) return { ok: false, error: '手札にないカードです' };
    }
    this._clearActionTimer();
    this._applyTenDiscard(discarder, uniqIds);
    this.pendingAction = null;
    this._advancePendingQueue();
    return { ok: true };
  }

  _applyTenDiscard(discarder, cardIds) {
    const idSet = new Set(cardIds);
    const discarded = discarder.hand.filter((c) => idSet.has(c.id));
    discarder.hand = discarder.hand.filter((c) => !idSet.has(c.id));
    if (discarded.length > 0) {
      this._pushLog(`${discarder.name} が10捨てで ${discarded.map((c) => cardLabel(c)).join(', ')} を捨てました`);
    }
    if (discarder.hand.length === 0) {
      this._finishPlayer(discarder.id, { legit: true });
    }
  }

  _handleActionTimeout() {
    if (!this.pendingAction) return;
    if (this.pendingAction.type === 'qbomber') {
      const shuffled = ALL_NORMAL_RANKS.slice().sort(() => Math.random() - 0.5);
      const numbers = shuffled.slice(0, this.pendingAction.count);
      this._pushLog('Qボンバー：時間切れのためランダム選択');
      this._applyQBomber(numbers);
      this.pendingAction = null;
      this._advancePendingQueue();
    } else if (this.pendingAction.type === 'sevenGive') {
      const giver = this.getPlayer(this.pendingAction.by);
      const others = this.players.filter((p) => p.status === 'active' && p.id !== giver.id);
      const allocation = [];
      const cardsToGive = giver.hand.slice(0, this.pendingAction.count);
      for (const card of cardsToGive) {
        const target = others[Math.floor(Math.random() * others.length)];
        allocation.push({ cardId: card.id, toPlayerId: target.id });
      }
      this._pushLog('7わたし：時間切れのためランダム配布');
      this._applySevenGive(giver, allocation);
      this.pendingAction = null;
      this._advancePendingQueue();
    } else if (this.pendingAction.type === 'tenDiscard') {
      const discarder = this.getPlayer(this.pendingAction.by);
      const shuffled = discarder.hand.slice().sort(() => Math.random() - 0.5);
      const cardIds = shuffled.slice(0, this.pendingAction.count).map((c) => c.id);
      this._pushLog('10捨て：時間切れのためランダム選択');
      this._applyTenDiscard(discarder, cardIds);
      this.pendingAction = null;
      this._advancePendingQueue();
    }
    this.emit('update');
  }

  // ---------- あがり／反則／ターン終了 ----------

  _checkZeroHandAgariForAll() {
    const zeroed = this.players.filter((p) => p.status === 'active' && p.hand.length === 0);
    if (zeroed.length === 0) return;
    const rank = this.nextTopRank;
    for (const p of zeroed) {
      p.status = 'finished';
      p.rank = rank;
      this._pushLog(`${p.name} が上がりました！（${rank}位）`);
    }
    this.nextTopRank += zeroed.length;
    this._checkGameEnd();
  }

  _finishPlayer(playerId, { legit }) {
    const p = this.getPlayer(playerId);
    if (!p || p.status !== 'active') return;
    if (legit) {
      p.status = 'finished';
      p.rank = this.nextTopRank;
      this.nextTopRank += 1;
      this._pushLog(`${p.name} が上がりました！（${p.rank}位）`);
    }
    this._checkGameEnd();
  }

  _faultFinish(playerId, reason) {
    const p = this.getPlayer(playerId);
    if (!p || p.status !== 'active') return;
    p.hand = [];
    p.status = reason; // 'foul' | 'left'
    p.rank = this.nextBottomRank;
    this.nextBottomRank -= 1;
    this._pushLog(`${p.name} が${reason === 'foul' ? '反則負け' : '離脱'}しました（${p.rank}位）`);
    if (this.field.ownerId === playerId) {
      // 場の所有者が抜けた場合、場は流れた扱いにする
      this._flowField();
    }
    if (this.currentPlayerId === playerId && !this.pendingAction) {
      // 特殊効果の処理待ち中は、その解決後の _finalizePlay でターン進行させる
      this._clearTurnTimer();
      const next = this._nextActivePlayerId(playerId);
      this.currentPlayerId = next;
      if (!this._checkGameEnd()) {
        this._startTurnTimer();
      }
    } else {
      this._checkGameEnd();
    }
  }

  _checkGameEnd() {
    if (this.ended) return true;
    const active = this.getActivePlayers();
    if (active.length <= 1) {
      if (active.length === 1) {
        const last = active[0];
        if (last.hand.length > 0) {
          this.loserReveal = { playerId: last.id, name: last.name, cards: sortHand(last.hand.slice()) };
        }
        last.status = 'finished';
        last.rank = this.nextTopRank <= this.nextBottomRank ? this.nextTopRank : this.nextBottomRank;
      }
      this.ended = true;
      this._clearTurnTimer();
      this._clearActionTimer();
      this._pushLog('ゲーム終了！');
      this.emit('gameEnd', this._rankingSummary());
      this.emit('update');
      return true;
    }
    return false;
  }

  _finalizePlay(player, playedCards, { skipRevolutionEtc }) {
    const ctx = this.finalContext || { playerId: player.id, playedCards, nextTurnId: this._nextActivePlayerId(player.id), fieldFlowedByEight: false };

    // 上がり判定（直接プレイによるもの）
    if (player.hand.length === 0 && player.status === 'active') {
      const isForbidden = playedCards.some((c) => {
        if (c.joker) return true;
        if (c.rank === 8) return true;
        if (c.rank === 11) return true;
        if (c.suit === 'S' && c.rank === 3) return true;
        if (isStrongestNormalRank(c.rank, this.revolution)) return true;
        return false;
      });
      if (isForbidden) {
        this._pushLog(`${player.name} は禁止カードで上がったため反則負けです。`);
        this._faultFinish(player.id, 'foul');
        this.finalContext = null;
        this.emit('update');
        return { ok: true, foul: true };
      }
      this._finishPlayer(player.id, { legit: true });
    }

    if (this.ended) {
      this.finalContext = null;
      this.emit('update');
      return { ok: true };
    }

    // ターン進行（自分が上がった/反則負けした場合は「再開」せず次の走者へ）
    const continuesSelf = ctx.fieldFlowedByEight && player.status === 'active';
    const nextId = continuesSelf ? player.id : this._nextActivePlayerId(player.id);
    this.currentPlayerId = nextId;
    this.finalContext = null;
    if (this.currentPlayerId) this._startTurnTimer();
    this.emit('update');
    return { ok: true };
  }

  _concludeTurn() {
    const ctx = this.finalContext;
    if (!ctx) return;
    const player = this.getPlayer(ctx.playerId);
    this._finalizePlay(player, ctx.playedCards, { skipRevolutionEtc: true });
  }

  pass(playerId) {
    if (this.ended) return { ok: false, error: 'ゲームは終了しています' };
    if (this.pendingAction) return { ok: false, error: '特殊効果の処理待ちです' };
    if (this.currentPlayerId !== playerId) return { ok: false, error: 'あなたの番ではありません' };
    if (!this.field.hand) return { ok: false, error: '場が空のときはパスできません' };
    const player = this.getPlayer(playerId);
    if (!player || player.status !== 'active') return { ok: false, error: '操作できません' };

    this._clearTurnTimer();
    this._pushLog(`${player.name} がパスしました。`);
    this.passCount += 1;

    const active = this.getActivePlayers();
    const ownerActive = this.field.ownerId && this.getPlayer(this.field.ownerId)?.status === 'active';
    const required = ownerActive ? active.length - 1 : active.length;

    if (this.passCount >= Math.max(required, 1)) {
      const ownerId = this.field.ownerId;
      this._flowField();
      const nextId = ownerActive ? ownerId : this._nextActivePlayerId(playerId);
      this.currentPlayerId = nextId;
      this._pushLog('場が流れました。');
    } else {
      this.currentPlayerId = this._nextActivePlayerId(playerId);
    }

    if (!this._checkGameEnd() && this.currentPlayerId) this._startTurnTimer();
    this.emit('update');
    return { ok: true };
  }

  _handleTurnTimeout() {
    if (this.ended || this.pendingAction) return;
    const playerId = this.currentPlayerId;
    const player = this.getPlayer(playerId);
    if (!player) return;
    if (this.field.hand) {
      this._pushLog(`${player.name} は時間切れのため自動パスしました。`);
      this.pass(playerId);
    } else {
      // 場が空：最弱の単騎を自動で出す
      const lowest = player.hand.filter((c) => !c.joker).sort((a, b) => a.rank - b.rank)[0] || player.hand[0];
      this._pushLog(`${player.name} は時間切れのため自動でカードを出しました。`);
      if (lowest) this.playCards(playerId, [lowest.id]);
    }
  }

  // ---------- 離脱・切断 ----------

  voluntaryLeave(playerId) {
    const p = this.getPlayer(playerId);
    if (!p || p.status !== 'active') return;
    this._faultFinish(playerId, 'left');
    this.emit('update');
  }

  setConnected(playerId, connected) {
    const p = this.getPlayer(playerId);
    if (!p) return;
    p.connected = connected;
    this.emit('update');
  }

  setAutoMode(playerId, autoMode) {
    const p = this.getPlayer(playerId);
    if (!p) return;
    p.autoMode = autoMode;
    this.emit('update');
    if (autoMode && this.currentPlayerId === playerId) {
      this._handleTurnTimeout();
    }
  }

  destroy() {
    this._clearTurnTimer();
    this._clearActionTimer();
  }
}

module.exports = Game;
