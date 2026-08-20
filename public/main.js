'use strict';

const SUIT_MARK = { S: '♠', H: '♡', D: '♢', C: '♣' };
const RANK_LABEL = { 3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'2' };
const ALL_NORMAL_RANKS = [14,15,3,4,5,6,7,8,9,10,11,12,13]; // A,2,3..K の順で表示

const socket = io();

// ---------- ローカル状態 ----------
let myPlayerId = null;
let myRoomCode = null;
let myName = null;

let latestLobby = null;
let latestGame = null;

let selectedCardIds = new Set();
let pendingStairsPlay = null; // { cardIds, suit, options }
let qbomberPicked = new Set();
let sevenSelected = []; // cardId の配列（選択順）
let sevenAssign = {};   // cardId -> toPlayerId
let tenSelected = [];   // cardId の配列（選択順）

let resultModalOpenedFor = null; // 二重表示防止

// ---------- ユーティリティ ----------
function $(sel) { return document.querySelector(sel); }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function showToast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function showScreen(name) {
  for (const s of ['home', 'lobby', 'game']) {
    $(`#screen-${s}`).classList.toggle('hidden', s !== name);
  }
}

function saveSession(session) {
  localStorage.setItem('daifugo_session', JSON.stringify(session));
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem('daifugo_session')); } catch { return null; }
}
function clearSession() {
  localStorage.removeItem('daifugo_session');
}

function cardLabel(card) {
  if (card.joker) return 'JOKER';
  return `${SUIT_MARK[card.suit]}${RANK_LABEL[card.rank]}`;
}

function renderCardEl(card, opts = {}) {
  const c = el('div', 'card' + (card.joker ? ' joker' : ` suit-${card.suit}`) + (opts.small ? ' small' : '') + (opts.fieldCard ? ' field-card' : ''));
  if (card.joker) {
    c.innerHTML = `<div class="card-corner">JOKER</div><div class="card-center">🃏</div>`;
  } else {
    const mark = SUIT_MARK[card.suit];
    const label = RANK_LABEL[card.rank];
    c.innerHTML = `<div class="card-corner"><span class="corner-rank">${label}</span><span class="corner-suit">${mark}</span></div><div class="card-center">${mark}</div>`;
  }
  if (opts.selected) c.classList.add('selected');
  if (opts.onClick) c.addEventListener('click', opts.onClick);
  return c;
}

function stringToHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function avatarInitial(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function vibrate(ms) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* noop */ }
}

// ---------- ソケットイベント ----------

socket.on('connect', () => {
  const saved = loadSession();
  if (saved && saved.roomCode && saved.playerId) {
    socket.emit('room:rejoin', { roomCode: saved.roomCode, playerId: saved.playerId });
  }
});

socket.on('joined', ({ playerId, roomCode, name }) => {
  myPlayerId = playerId;
  myRoomCode = roomCode;
  myName = name;
  saveSession({ playerId, roomCode, name });
});

socket.on('room:state', (state) => {
  latestLobby = state;
  const amIn = state.players.some((p) => p.id === myPlayerId);
  if (!amIn) {
    clearSession();
    if ($('#screen-home').classList.contains('hidden') === false) return;
    showScreen('home');
    return;
  }
  if (state.started || state.gameOver) {
    showScreen('game');
  } else {
    lastLogLen = -1;
    showScreen('lobby');
  }
  renderLobby(state);
});

socket.on('game:state', (state) => {
  latestGame = state;
  renderGame(state);
});

socket.on('error', ({ message }) => showToast(message));

socket.on('game:needsChoice', ({ choiceType, suit, options, cardIds }) => {
  if (choiceType === 'stairsJokerExtend') {
    pendingStairsPlay = { cardIds, suit, options };
    renderStairsJokerModal();
  }
});

// ---------- ホーム画面 ----------

$('#btn-create-room').addEventListener('click', () => {
  const name = $('#input-name').value.trim();
  if (!name) return showToast('名前を入力してください');
  socket.emit('room:create', { name });
});

$('#btn-join-room').addEventListener('click', () => {
  const name = $('#input-name').value.trim();
  const roomCode = $('#input-roomcode').value.trim().toUpperCase();
  if (!name) return showToast('名前を入力してください');
  if (!roomCode) return showToast('ルームIDを入力してください');
  socket.emit('room:join', { roomCode, name });
});

// ---------- ロビー画面 ----------

function renderLobby(state) {
  $('#lobby-room-code').textContent = state.roomCode;
  const list = $('#lobby-players');
  list.innerHTML = '';
  for (const p of state.players) {
    const li = el('li');
    if (!p.connected) li.classList.add('disconnected');
    const dot = el('span', 'dot');
    const crown = el('span', 'crown', p.isOwner ? '👑' : '');
    const name = el('span', 'name', p.name + (p.id === myPlayerId ? '（あなた）' : ''));
    li.append(dot, crown, name);
    if (!p.connected) li.append(el('span', 'hint', '切断中'));
    list.appendChild(li);
  }

  const isOwner = state.ownerId === myPlayerId;
  const connectedCount = state.players.filter((p) => p.connected).length;
  const startBtn = $('#btn-start-game');
  startBtn.disabled = !(isOwner && connectedCount >= state.minPlayers);
  startBtn.textContent = state.gameOver ? 'もう一度プレイ' : 'ゲーム開始';

  const hint = $('#lobby-hint');
  if (!isOwner) hint.textContent = 'ルームオーナーの開始を待っています';
  else if (connectedCount < state.minPlayers) hint.textContent = `開始には あと${state.minPlayers - connectedCount}人 必要です`;
  else hint.textContent = `${state.players.length}人 参加中（最大${state.maxPlayers}人）`;
}

$('#btn-start-game').addEventListener('click', () => socket.emit('room:start'));
$('#btn-leave-room').addEventListener('click', () => {
  socket.emit('room:leave');
  clearSession();
  showScreen('home');
});
$('#btn-copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#lobby-room-code').textContent);
    showToast('コピーしました');
  } catch {
    showToast($('#lobby-room-code').textContent);
  }
});

// ---------- ゲーム画面 ----------

let timerInterval = null;

function renderGame(state) {
  renderTop(state);
  renderBadges(state);
  renderSpecialBanner(state);
  renderField(state);
  renderTimer(state);
  renderLog(state);
  renderHand(state);
  renderPendingModals(state);
  renderResult(state);
  if (pendingStairsPlay && (state.currentPlayerId !== myPlayerId || state.pendingAction)) {
    pendingStairsPlay = null;
  }
  renderStairsJokerModal();
}

// ---------- 階段ジョーカー役割選択 モーダル ----------

function renderStairsJokerModal() {
  const modal = $('#modal-stairs-joker');
  if (!pendingStairsPlay) {
    modal.classList.add('hidden');
    return;
  }
  modal.classList.remove('hidden');
  const { cardIds, suit, options } = pendingStairsPlay;
  const myHand = (latestGame && latestGame.myHand) || [];
  const selectedCards = cardIds.map((id) => myHand.find((c) => c.id === id)).filter(Boolean);
  const nonJokerRanks = new Set(selectedCards.filter((c) => !c.joker).map((c) => c.rank));

  const grid = $('#stairs-joker-options');
  grid.innerHTML = '';
  for (const opt of options) {
    const ranks = [];
    for (let r = opt.finalMin; r <= opt.finalMax; r++) ranks.push(r);
    const label = ranks
      .map((r) => (nonJokerRanks.has(r) ? RANK_LABEL[r] : `[${RANK_LABEL[r]}]`))
      .join(' ');
    const chip = el('div', 'chip', `${SUIT_MARK[suit]} ${label}`);
    chip.addEventListener('click', () => {
      socket.emit('game:play', { cardIds, stairsChoice: { extendDown: opt.extendDown } });
      pendingStairsPlay = null;
      renderStairsJokerModal();
    });
    grid.appendChild(chip);
  }
}

const RANK_MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

function renderTop(state) {
  const top = $('#game-top');
  top.innerHTML = '';
  for (const p of state.players) {
    const chip = el('div', 'player-chip');
    if (p.isCurrentTurn) chip.classList.add('turn');
    if (p.status === 'finished') chip.classList.add('finished');
    if (p.status === 'foul' || p.status === 'left') chip.classList.add('gone');
    if (p.rank) {
      const medal = RANK_MEDAL[p.rank];
      const b = el('div', 'pbadge' + (medal ? ' medal' : ''), medal || `${p.rank}位`);
      chip.appendChild(b);
    }
    const avatar = el('div', 'avatar', avatarInitial(p.name));
    avatar.style.background = `hsl(${stringToHue(p.id)}, 55%, 42%)`;
    const name = el('div', 'pname', p.name + (p.id === myPlayerId ? '（あなた）' : '') + (p.autoMode ? ' 🤖' : '') + (!p.connected ? ' 📶' : ''));
    const count = el('div', 'pcount', p.status === 'active' ? `${p.handCount}枚` : (p.status === 'finished' ? '上がり' : p.status === 'foul' ? '反則負け' : '離脱'));
    chip.append(avatar, name, count);
    top.appendChild(chip);
  }
}

function renderBadges(state) {
  const wrap = $('#status-badges');
  wrap.innerHTML = '';
  if (state.revolution) wrap.appendChild(el('span', 'badge revolution', '革命中'));
  if (state.jbackActive) wrap.appendChild(el('span', 'badge jback', 'Jバック'));
  if (state.shibari && state.shibari.length) {
    wrap.appendChild(el('span', 'badge shibari', `縛り: ${state.shibari.map((s) => SUIT_MARK[s]).join('')}`));
  }
}

function renderSpecialBanner(state) {
  const banner = $('#special-banner');
  if (!state.pendingAction) {
    banner.classList.add('hidden');
    return;
  }
  const by = state.players.find((p) => p.id === state.pendingAction.by);
  const byName = by ? by.name : '';
  let text = '';
  if (state.pendingAction.type === 'qbomber') {
    text = state.pendingAction.by === myPlayerId
      ? `Qボンバー！ 数字を${state.pendingAction.count}個選んでください`
      : `${byName} さんがQボンバー選択中...`;
  } else if (state.pendingAction.type === 'sevenGive') {
    text = state.pendingAction.by === myPlayerId
      ? `7わたし！ ${state.pendingAction.count}枚を配布してください`
      : `${byName} さんが7わたし選択中...`;
  } else if (state.pendingAction.type === 'tenDiscard') {
    text = state.pendingAction.by === myPlayerId
      ? `10捨て！ 手札から${state.pendingAction.count}枚選んで捨ててください`
      : `${byName} さんが10捨て選択中...`;
  }
  banner.textContent = text;
  banner.classList.remove('hidden');
}

function renderField(state) {
  const wrap = $('#field-cards');
  wrap.innerHTML = '';
  for (const c of state.field.cards) {
    wrap.appendChild(renderCardEl(c, { fieldCard: true }));
  }
}

function renderTimer(state) {
  const indicator = $('#turn-indicator');
  const cur = state.players.find((p) => p.id === state.currentPlayerId);
  const mine = state.currentPlayerId === myPlayerId;
  indicator.classList.toggle('mine', mine && !state.pendingAction);
  if (state.ended) {
    indicator.textContent = 'ゲーム終了';
  } else if (state.pendingAction) {
    indicator.textContent = '特殊効果処理中';
  } else {
    indicator.textContent = mine ? 'あなたの番です' : `${cur ? cur.name : ''} の番です`;
  }

  clearInterval(timerInterval);
  const deadline = state.pendingAction ? state.pendingAction.deadline : state.turnDeadline;
  const totalMs = state.pendingAction ? 60000 : 60000;
  const fill = $('#timer-fill');
  function tick() {
    if (!deadline) { fill.style.width = '100%'; fill.classList.remove('urgent'); return; }
    const remain = Math.max(0, deadline - Date.now());
    fill.style.width = `${Math.min(100, (remain / totalMs) * 100)}%`;
    fill.classList.toggle('urgent', remain > 0 && remain <= 10000);
  }
  tick();
  if (deadline && !state.ended) timerInterval = setInterval(tick, 300);
}

let lastLogLen = -1;
const LOG_POPUP_LIFETIME_MS = 2800;
const LOG_POPUP_MAX_STACK = 4;

const LOG_CATEGORIES = [
  { test: /上がりました|ゲーム開始|ゲーム終了/, cat: 'win', icon: '🏆' },
  { test: /革命/, cat: 'revolution', icon: '⚡' },
  { test: /反則負け|離脱/, cat: 'danger', icon: '💥' },
  { test: /8切り/, cat: 'special', icon: '✂️' },
  { test: /Jバック/, cat: 'special', icon: '🔄' },
  { test: /縛り/, cat: 'special', icon: '🔒' },
  { test: /Qボンバー/, cat: 'special', icon: '💣' },
  { test: /7わたし|渡しました/, cat: 'special', icon: '🎁' },
  { test: /10捨て|廃棄/, cat: 'special', icon: '🗑️' },
  { test: /♠3返し/, cat: 'special', icon: '↩️' },
  { test: /場が流れました/, cat: 'clear', icon: '🌊' },
  { test: /時間切れ/, cat: 'timeout', icon: '⏰' },
  { test: /パスしました/, cat: 'pass', icon: '💨' },
];

function classifyLog(message) {
  for (const c of LOG_CATEGORIES) if (c.test.test(message)) return c;
  return { cat: 'default', icon: '▶' };
}

function renderLog(state) {
  const log = state.log || [];
  if (lastLogLen === -1 || log.length < lastLogLen) {
    // 初回描画 or ゲームリセット時は既存ログを一気にポップアップさせない
    lastLogLen = log.length;
    return;
  }
  const newEntries = log.slice(lastLogLen);
  lastLogLen = log.length;
  for (const entry of newEntries) showLogPopup(entry.message);
}

function showLogPopup(message) {
  const popup = $('#log-popup');
  while (popup.children.length >= LOG_POPUP_MAX_STACK) popup.firstElementChild.remove();

  const { cat, icon } = classifyLog(message);
  const item = el('div', `log-popup-item cat-${cat}`);
  item.append(el('span', 'log-icon', icon), el('span', 'log-text', message));
  popup.appendChild(item);
  setTimeout(() => item.remove(), LOG_POPUP_LIFETIME_MS);
}

function updateHandOverlap(wrap, cardCount) {
  if (cardCount <= 1) { wrap.style.removeProperty('--overlap'); return; }
  const firstCard = wrap.querySelector('.card');
  if (!firstCard) return;
  const cardWidth = firstCard.getBoundingClientRect().width;
  if (!cardWidth) return;
  const cs = getComputedStyle(wrap);
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padRight = parseFloat(cs.paddingRight) || 0;
  const containerWidth = wrap.clientWidth - padLeft - padRight;
  const rawSpacing = (containerWidth - cardWidth) / (cardCount - 1);
  const minSpacing = Math.max(cardWidth * 0.4, 26);
  const maxSpacing = cardWidth + 6;
  const spacing = Math.min(maxSpacing, Math.max(minSpacing, rawSpacing));
  wrap.style.setProperty('--overlap', `${spacing - cardWidth}px`);
}

function renderHand(state) {
  const wrap = $('#my-hand');
  wrap.innerHTML = '';
  const inSevenMode = state.pendingAction && state.pendingAction.type === 'sevenGive' && state.pendingAction.by === myPlayerId;
  const inTenMode = state.pendingAction && state.pendingAction.type === 'tenDiscard' && state.pendingAction.by === myPlayerId;

  for (const card of state.myHand) {
    if (inSevenMode) {
      const picked = sevenSelected.includes(card.id);
      wrap.appendChild(renderCardEl(card, {
        selected: picked,
        onClick: () => toggleSevenCard(card.id, state.pendingAction.count),
      }));
    } else if (inTenMode) {
      const picked = tenSelected.includes(card.id);
      wrap.appendChild(renderCardEl(card, {
        selected: picked,
        onClick: () => toggleTenCard(card.id, state.pendingAction.count),
      }));
    } else {
      const selected = selectedCardIds.has(card.id);
      wrap.appendChild(renderCardEl(card, {
        selected,
        onClick: () => {
          if (selected) selectedCardIds.delete(card.id); else selectedCardIds.add(card.id);
          vibrate(12);
          renderHand(state);
          updateActionButtons(state);
        },
      }));
    }
  }
  updateHandOverlap(wrap, state.myHand.length);
  updateActionButtons(state);
}

let handResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(handResizeTimer);
  handResizeTimer = setTimeout(() => {
    if (latestGame) updateHandOverlap($('#my-hand'), latestGame.myHand.length);
  }, 150);
});

function updateActionButtons(state) {
  const myTurn = state.currentPlayerId === myPlayerId && !state.pendingAction && !state.ended;
  const me = state.players.find((p) => p.id === myPlayerId);
  const canAct = myTurn && me && me.status === 'active';
  const hasSelection = selectedCardIds.size > 0;
  $('#btn-play').disabled = !(canAct && hasSelection);
  $('#btn-play').classList.toggle('hidden', !hasSelection);
  $('#btn-pass').disabled = !(canAct && state.field.kind);
  $('#action-bar').classList.toggle('visible', canAct);
  $('.game-bottom').classList.toggle('my-turn', canAct);

  const inSpecialMode = state.pendingAction && state.pendingAction.by === myPlayerId;
  const infoText = $('#hand-info-text');
  const clearBtn = $('#btn-clear-sel');
  if (!inSpecialMode) {
    infoText.textContent = selectedCardIds.size > 0
      ? `${selectedCardIds.size}枚 選択中`
      : (canAct ? 'カードをタップして選択' : `手札 ${state.myHand.length}枚`);
    clearBtn.classList.toggle('hidden', selectedCardIds.size === 0);
  }
}

$('#btn-clear-sel').addEventListener('click', () => {
  selectedCardIds.clear();
  if (latestGame) renderHand(latestGame);
});

$('#btn-play').addEventListener('click', () => {
  if (selectedCardIds.size === 0) return;
  vibrate(20);
  socket.emit('game:play', { cardIds: Array.from(selectedCardIds) });
  selectedCardIds.clear();
});

$('#btn-pass').addEventListener('click', () => {
  vibrate(20);
  socket.emit('game:pass');
});

$('#btn-forfeit').addEventListener('click', () => {
  if (confirm('ゲームを棄権しますか？（最下位確定となります）')) {
    socket.emit('game:forfeit');
  }
});

// ---------- Qボンバー モーダル ----------

function renderPendingModals(state) {
  const qModal = $('#modal-qbomber');
  const sModal = $('#modal-seven');
  const pending = state.pendingAction;

  if (pending && pending.type === 'qbomber' && pending.by === myPlayerId) {
    qModal.classList.remove('hidden');
    renderQBomberModal(pending);
  } else {
    qModal.classList.add('hidden');
    qbomberPicked.clear();
  }

  if (pending && pending.type === 'sevenGive' && pending.by === myPlayerId) {
    sModal.classList.remove('hidden');
    renderSevenModal(state, pending);
  } else {
    sModal.classList.add('hidden');
    sevenSelected = [];
    sevenAssign = {};
  }

  const tModal = $('#modal-ten');
  if (pending && pending.type === 'tenDiscard' && pending.by === myPlayerId) {
    tModal.classList.remove('hidden');
    renderTenModal(state, pending);
  } else {
    tModal.classList.add('hidden');
    tenSelected = [];
  }
}

function renderQBomberModal(pending) {
  $('#qbomber-desc').textContent = `異なる数字を${pending.count}個選んでください（選んだ数字を全員が捨てます）`;
  const grid = $('#qbomber-options');
  grid.innerHTML = '';
  for (const rank of ALL_NORMAL_RANKS) {
    const picked = qbomberPicked.has(rank);
    const chip = el('div', 'chip' + (picked ? ' picked' : ''), RANK_LABEL[rank]);
    chip.addEventListener('click', () => {
      if (picked) qbomberPicked.delete(rank);
      else {
        if (qbomberPicked.size >= pending.count) return;
        qbomberPicked.add(rank);
      }
      renderQBomberModal(pending);
    });
    grid.appendChild(chip);
  }
  $('#btn-qbomber-confirm').disabled = qbomberPicked.size !== pending.count;
}

$('#btn-qbomber-confirm').addEventListener('click', () => {
  socket.emit('game:qbomber', { numbers: Array.from(qbomberPicked) });
  qbomberPicked.clear();
});

// ---------- 7わたし モーダル ----------

function toggleSevenCard(cardId, count) {
  const idx = sevenSelected.indexOf(cardId);
  if (idx >= 0) {
    sevenSelected.splice(idx, 1);
    delete sevenAssign[cardId];
  } else {
    if (sevenSelected.length >= count) return;
    sevenSelected.push(cardId);
  }
  renderGame(latestGame);
}

function renderSevenModal(state, pending) {
  $('#seven-desc').textContent = `渡すカードを${pending.count}枚、手札から選んでください（下の一覧で相手を指定）`;
  const wrap = $('#seven-cards');
  wrap.innerHTML = '';
  const others = state.players.filter((p) => p.status === 'active' && p.id !== myPlayerId);

  for (const cardId of sevenSelected) {
    const card = state.myHand.find((c) => c.id === cardId);
    if (!card) continue;
    const row = el('div', 'seven-card-row');
    row.appendChild(renderCardEl(card, { small: true }));
    const select = document.createElement('select');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '渡す相手を選択';
    select.appendChild(blank);
    for (const o of others) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name;
      if (sevenAssign[cardId] === o.id) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      sevenAssign[cardId] = select.value;
      updateSevenConfirm(pending);
    });
    row.appendChild(select);
    wrap.appendChild(row);
  }
  updateSevenConfirm(pending);
}

function updateSevenConfirm(pending) {
  const ok = sevenSelected.length === pending.count && sevenSelected.every((id) => sevenAssign[id]);
  $('#btn-seven-confirm').disabled = !ok;
}

$('#btn-seven-confirm').addEventListener('click', () => {
  const allocation = sevenSelected.map((cardId) => ({ cardId, toPlayerId: sevenAssign[cardId] }));
  socket.emit('game:sevenGive', { allocation });
  sevenSelected = [];
  sevenAssign = {};
});

// ---------- 10捨て モーダル ----------

function toggleTenCard(cardId, count) {
  const idx = tenSelected.indexOf(cardId);
  if (idx >= 0) {
    tenSelected.splice(idx, 1);
  } else {
    if (tenSelected.length >= count) return;
    tenSelected.push(cardId);
  }
  renderGame(latestGame);
}

function renderTenModal(state, pending) {
  $('#ten-desc').textContent = `捨てるカードを${pending.count}枚、下の手札から選んでください（${tenSelected.length}/${pending.count}枚 選択中）`;
  const wrap = $('#ten-cards');
  wrap.innerHTML = '';
  for (const cardId of tenSelected) {
    const card = state.myHand.find((c) => c.id === cardId);
    if (!card) continue;
    wrap.appendChild(renderCardEl(card, { small: true }));
  }
  $('#btn-ten-confirm').disabled = tenSelected.length !== pending.count;
}

$('#btn-ten-confirm').addEventListener('click', () => {
  socket.emit('game:tenDiscard', { cardIds: tenSelected.slice() });
  tenSelected = [];
});

// ---------- 結果画面 ----------

function renderResult(state) {
  const modal = $('#modal-result');
  if (!state.ended) {
    modal.classList.add('hidden');
    resultModalOpenedFor = null;
    return;
  }
  modal.classList.remove('hidden');
  const list = $('#result-list');
  list.innerHTML = '';
  for (const r of state.finalRanking) {
    const li = el('li', r.id === myPlayerId ? 'me' : '', `${r.rank}位　${r.name}${r.status !== 'finished' ? '（' + (r.status === 'foul' ? '反則負け' : '離脱') + '）' : ''}`);
    list.appendChild(li);
  }
  const isOwner = latestLobby && latestLobby.ownerId === myPlayerId;
  $('#btn-restart').classList.toggle('hidden', !isOwner);
}

$('#btn-restart').addEventListener('click', () => socket.emit('room:start'));
$('#btn-back-lobby').addEventListener('click', () => {
  $('#modal-result').classList.add('hidden');
  showScreen('lobby');
  if (latestLobby) renderLobby(latestLobby);
});
