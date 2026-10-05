'use strict';

const SUIT_MARK = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_LABEL = { 3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'2' };
const ALL_NORMAL_RANKS = [14,15,3,4,5,6,7,8,9,10,11,12,13]; // A,2,3..K の順で表示

// 階級制（連続対戦オプション）の表示ラベル。平民はバッジを表示しない。
const CLASS_LABEL = { daifugo: '大富豪', fugo: '富豪', hinmin: '貧民', daihinmin: '大貧民' };
const CLASS_ICON = { daifugo: '👑', fugo: '🥂', hinmin: '💦', daihinmin: '💀' };

// プリセットアイコン写真。実URLはここだけが持ち、サーバーには avatarId しか送らない
// （なりすまし防止・軽量化のため。詳細は docs/SOCKET_API.md の Avatar 参照）。
const PRESET_AVATARS = [
  { id: 'p1', url: 'https://res.cloudinary.com/mudnpbqy/image/upload/v1787212438/LINE_ALBUM_%E3%81%AF%E3%82%8B%E3%81%8D_%E6%9F%B4__260820_1.jpg' },
  { id: 'p2', url: 'https://res.cloudinary.com/mudnpbqy/image/upload/v1787212496/LINE_ALBUM_%E3%82%8A%E3%82%87%E3%81%86%E3%81%9F_260820_1.jpg' },
  { id: 'p3', url: 'https://res.cloudinary.com/mudnpbqy/image/upload/v1787220849/LINE_ALBUM_%E3%81%BE%E3%81%95%E3%81%B2%E3%81%A8_260820_1.jpg' },
  { id: 'p4', url: 'https://res.cloudinary.com/mudnpbqy/image/upload/v1787220825/LINE_ALBUM_%E3%81%9F%E3%81%84%E3%82%80_260820_1.jpg' },
  { id: 'p5', url: 'https://res.cloudinary.com/mudnpbqy/image/upload/v1787220819/LINE_ALBUM_%E3%81%93%E3%81%86%E3%81%8D_260820_1.jpg' },
  { id: 'p6', url: 'https://res.cloudinary.com/mudnpbqy/image/upload/v1787220809/LINE_ALBUM_%E3%82%88%E3%81%86%E3%81%99%E3%81%91_260820_1.jpg' },
  { id: 'p7', url: 'https://res.cloudinary.com/mudnpbqy/image/upload/v1787220802/LINE_ALBUM_%E3%81%AF%E3%82%8B%E3%81%8D_%E8%97%A4__260820_1.jpg' },
  { id: 'p8', url: 'https://res.cloudinary.com/mudnpbqy/image/upload/v1791190178/94773.jpg' },
];
const PRESET_AVATAR_MAP = Object.fromEntries(PRESET_AVATARS.map((a) => [a.id, a.url]));

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
let exchangeSelected = []; // cardId の配列（選択順、カード交換で返す側）

let resultModalOpenedFor = null; // 二重表示防止

let myAvatar = loadAvatar(); // { avatarId, scale, offsetX, offsetY } | null
let avatarEditorDraft = null; // モーダル編集中の作業用コピー
let avatarEditorDragging = false;
let lastFieldSignature = null;
let justPlayed = null; // { playerId, ts } 直前に誰がカードを出したか（アニメーション用）

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

// ---------- アイコン（アバター） ----------

function clampNum(n, min, max) { return Math.min(max, Math.max(min, n)); }

// zoom倍率のとき、円形バッジ内に隙間を作らずパンできるオフセットの最大値（%）
function maxAvatarOffset(scale) {
  return 50 * (1 - 1 / Math.max(1, scale));
}

function clampAvatarOffsets(avatar) {
  if (!avatar) return avatar;
  const max = maxAvatarOffset(avatar.scale);
  return { ...avatar, offsetX: clampNum(avatar.offsetX, -max, max), offsetY: clampNum(avatar.offsetY, -max, max) };
}

function normalizeAvatar(raw) {
  if (!raw || typeof raw !== 'object' || !PRESET_AVATAR_MAP[raw.avatarId]) return null;
  const scale = clampNum(Number(raw.scale) || 1, 1, 3);
  const offsetX = Number.isFinite(Number(raw.offsetX)) ? Number(raw.offsetX) : 0;
  const offsetY = Number.isFinite(Number(raw.offsetY)) ? Number(raw.offsetY) : 0;
  return clampAvatarOffsets({ avatarId: raw.avatarId, scale, offsetX, offsetY });
}

function loadAvatar() {
  try {
    return normalizeAvatar(JSON.parse(localStorage.getItem('daifugo_avatar')));
  } catch {
    return null;
  }
}

function saveAvatarLocal(avatar) {
  if (avatar) localStorage.setItem('daifugo_avatar', JSON.stringify(avatar));
  else localStorage.removeItem('daifugo_avatar');
}

function avatarForPlayer(playerId) {
  if (playerId === myPlayerId) return myAvatar;
  const p = latestLobby && latestLobby.players.find((x) => x.id === playerId);
  return p ? p.avatar : null;
}

// 円形の .avatar 要素に、写真アイコン or イニシャルのフォールバックを描画する
function applyAvatarVisual(container, avatar, name, colorKey) {
  container.innerHTML = '';
  if (avatar && PRESET_AVATAR_MAP[avatar.avatarId]) {
    container.style.background = 'none';
    const img = document.createElement('img');
    img.className = 'avatar-photo-inner';
    img.alt = '';
    img.draggable = false;
    img.style.setProperty('--zoom', avatar.scale || 1);
    img.style.setProperty('--tx', `${avatar.offsetX || 0}%`);
    img.style.setProperty('--ty', `${avatar.offsetY || 0}%`);
    // 画像が読み込めない場合（リンク切れ等）はイニシャル表示にフォールバックする
    img.addEventListener('error', () => applyAvatarVisual(container, null, name, colorKey), { once: true });
    img.src = PRESET_AVATAR_MAP[avatar.avatarId];
    container.appendChild(img);
  } else {
    container.textContent = avatarInitial(name);
    container.style.background = `hsl(${stringToHue(colorKey || name || '?')}, 55%, 42%)`;
  }
}

function sendAvatarToServer() {
  if (myPlayerId) socket.emit('player:avatar', { avatar: myAvatar });
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
    if (latestGame) renderTop(latestGame); // アイコン変更をゲーム画面にも即反映
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
  const roomCode = $('#input-create-roomcode').value.trim();
  if (!name) return showToast('名前を入力してください');
  socket.emit('room:create', { name, roomCode, avatar: myAvatar });
});

$('#btn-join-room').addEventListener('click', () => {
  const name = $('#input-name').value.trim();
  const roomCode = $('#input-roomcode').value.trim().toUpperCase();
  if (!name) return showToast('名前を入力してください');
  if (!roomCode) return showToast('ルームIDを入力してください');
  socket.emit('room:join', { roomCode, name, avatar: myAvatar });
});

function renderHomeAvatarPreview() {
  applyAvatarVisual($('#home-avatar-preview'), myAvatar, $('#input-name').value || myName, 'home-preview');
}
renderHomeAvatarPreview();
$('#input-name').addEventListener('input', renderHomeAvatarPreview);
$('#btn-open-avatar').addEventListener('click', () => openAvatarEditor());
$('#btn-open-avatar-lobby').addEventListener('click', () => openAvatarEditor());

// ---------- アイコン設定モーダル ----------

function buildAvatarPresetGrid() {
  const grid = $('#avatar-presets');
  grid.innerHTML = '';
  for (const preset of PRESET_AVATARS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-preset-btn';
    btn.dataset.avatarId = preset.id;
    btn.title = '';
    const img = document.createElement('img');
    img.src = preset.url;
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => {
      btn.classList.add('broken');
      btn.title = 'この写真は現在読み込めません';
    }, { once: true });
    btn.appendChild(img);
    btn.addEventListener('click', () => selectAvatarPreset(preset.id));
    grid.appendChild(btn);
  }
}
buildAvatarPresetGrid();

function selectAvatarPreset(avatarId) {
  avatarEditorDraft = { avatarId, scale: 1, offsetX: 0, offsetY: 0 };
  updateAvatarEditorUI();
}

function updateAvatarEditorUI() {
  const hasPhoto = !!(avatarEditorDraft && avatarEditorDraft.avatarId);
  for (const btn of $('#avatar-presets').children) {
    btn.classList.toggle('selected', hasPhoto && btn.dataset.avatarId === avatarEditorDraft.avatarId);
  }
  $('#avatar-crop-empty').classList.toggle('hidden', hasPhoto);
  $('#avatar-zoom-field').classList.toggle('disabled', !hasPhoto);
  $('#btn-avatar-save').disabled = !hasPhoto;

  const photo = $('#avatar-crop-photo');
  const emptyText = $('#avatar-crop-empty');
  if (hasPhoto) {
    emptyText.textContent = '上の写真から選んでください';
    photo.onerror = () => {
      photo.removeAttribute('src');
      emptyText.textContent = 'この写真を読み込めませんでした';
      emptyText.classList.remove('hidden');
    };
    photo.src = PRESET_AVATAR_MAP[avatarEditorDraft.avatarId];
    photo.style.setProperty('--zoom', avatarEditorDraft.scale);
    photo.style.setProperty('--tx', `${avatarEditorDraft.offsetX}%`);
    photo.style.setProperty('--ty', `${avatarEditorDraft.offsetY}%`);
    $('#avatar-zoom').value = Math.round(avatarEditorDraft.scale * 100);
  } else {
    photo.onerror = null;
    photo.removeAttribute('src');
    emptyText.textContent = '上の写真から選んでください';
  }
}

function openAvatarEditor() {
  avatarEditorDraft = myAvatar ? { ...myAvatar } : null;
  updateAvatarEditorUI();
  $('#modal-avatar').classList.remove('hidden');
}

function closeAvatarEditor() {
  $('#modal-avatar').classList.add('hidden');
  avatarEditorDraft = null;
}

function refreshAllAvatarVisuals() {
  renderHomeAvatarPreview();
  if (latestLobby) renderLobby(latestLobby);
  if (latestGame) renderTop(latestGame);
}

$('#avatar-zoom').addEventListener('input', () => {
  if (!avatarEditorDraft || !avatarEditorDraft.avatarId) return;
  avatarEditorDraft.scale = clampNum(Number($('#avatar-zoom').value) / 100, 1, 3);
  avatarEditorDraft = clampAvatarOffsets(avatarEditorDraft);
  updateAvatarEditorUI();
});

const avatarStage = $('#avatar-crop-stage');
let avatarDragStart = null; // { x, y, offsetX, offsetY }

avatarStage.addEventListener('pointerdown', (e) => {
  if (!avatarEditorDraft || !avatarEditorDraft.avatarId) return;
  avatarEditorDragging = true;
  avatarStage.classList.add('dragging');
  avatarStage.setPointerCapture(e.pointerId);
  avatarDragStart = { x: e.clientX, y: e.clientY, offsetX: avatarEditorDraft.offsetX, offsetY: avatarEditorDraft.offsetY };
});
avatarStage.addEventListener('pointermove', (e) => {
  if (!avatarEditorDragging || !avatarDragStart) return;
  const rect = avatarStage.getBoundingClientRect();
  const dxPct = ((e.clientX - avatarDragStart.x) / rect.width) * 100 / avatarEditorDraft.scale;
  const dyPct = ((e.clientY - avatarDragStart.y) / rect.height) * 100 / avatarEditorDraft.scale;
  avatarEditorDraft.offsetX = avatarDragStart.offsetX + dxPct;
  avatarEditorDraft.offsetY = avatarDragStart.offsetY + dyPct;
  avatarEditorDraft = clampAvatarOffsets(avatarEditorDraft);
  updateAvatarEditorUI();
});
function stopAvatarDrag(e) {
  avatarEditorDragging = false;
  avatarStage.classList.remove('dragging');
  avatarDragStart = null;
  try { avatarStage.releasePointerCapture(e.pointerId); } catch { /* noop */ }
}
avatarStage.addEventListener('pointerup', stopAvatarDrag);
avatarStage.addEventListener('pointercancel', stopAvatarDrag);

$('#btn-avatar-save').addEventListener('click', () => {
  if (!avatarEditorDraft || !avatarEditorDraft.avatarId) return;
  myAvatar = normalizeAvatar(avatarEditorDraft);
  saveAvatarLocal(myAvatar);
  sendAvatarToServer();
  refreshAllAvatarVisuals();
  closeAvatarEditor();
});
$('#btn-avatar-cancel').addEventListener('click', () => closeAvatarEditor());
$('#btn-avatar-clear').addEventListener('click', () => {
  myAvatar = null;
  saveAvatarLocal(null);
  sendAvatarToServer();
  refreshAllAvatarVisuals();
  closeAvatarEditor();
});

// ---------- ロビー画面 ----------

function renderLobby(state) {
  $('#lobby-room-code').textContent = state.roomCode;
  applyAvatarVisual($('#lobby-avatar-preview'), myAvatar, myName, myPlayerId);
  const list = $('#lobby-players');
  list.innerHTML = '';
  for (const p of state.players) {
    const li = el('li');
    if (!p.connected) li.classList.add('disconnected');
    const avatar = el('div', 'avatar');
    applyAvatarVisual(avatar, p.avatar, p.name, p.id);
    const dot = el('span', 'dot');
    const crown = el('span', 'crown', p.isOwner ? '👑' : '');
    const name = el('span', 'name', p.name + (p.id === myPlayerId ? '（あなた）' : ''));
    li.append(avatar, dot, crown, name);
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

  const classToggle = $('#toggle-class-rule');
  const miyakoToggle = $('#toggle-miyako-ochi');
  classToggle.checked = !!state.classRule;
  classToggle.disabled = !isOwner;
  miyakoToggle.checked = !!state.miyakoOchi;
  miyakoToggle.disabled = !isOwner || !state.classRule;
  $('#row-miyako-ochi').classList.toggle('disabled', !state.classRule);
}

$('#toggle-class-rule').addEventListener('change', (e) => {
  socket.emit('room:options', { classRule: e.target.checked });
});
$('#toggle-miyako-ochi').addEventListener('change', (e) => {
  socket.emit('room:options', { miyakoOchi: e.target.checked });
});

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

const CENTER_AVATAR_POP_MS = 1000;

// カードを出した瞬間、写真アイコンを設定している人だけ画面中央に一瞬アイコンをポップアップさせる
function showCenterAvatarPop(playerId, state) {
  const avatar = avatarForPlayer(playerId);
  if (!avatar || !PRESET_AVATAR_MAP[avatar.avatarId]) return;
  const p = state.players.find((x) => x.id === playerId);
  const layer = $('#center-avatar-pop');
  const item = el('div', 'center-avatar-pop-item');
  const face = el('div', 'avatar center-avatar-pop-avatar');
  applyAvatarVisual(face, avatar, p ? p.name : '', playerId);
  item.appendChild(face);
  layer.appendChild(item);
  setTimeout(() => item.remove(), CENTER_AVATAR_POP_MS);
}

function renderGame(state) {
  const fieldSig = state.field.ownerId
    ? `${state.field.ownerId}:${state.field.cards.map((c) => c.id).join(',')}`
    : null;
  if (fieldSig && fieldSig !== lastFieldSignature) {
    justPlayed = { playerId: state.field.ownerId, ts: Date.now() };
    showCenterAvatarPop(state.field.ownerId, state);
  }
  lastFieldSignature = fieldSig;

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
    if (p.id === myPlayerId && p.status === 'active') {
      chip.classList.add('me-tappable');
      chip.addEventListener('click', () => {
        $('#modal-forfeit').classList.remove('hidden');
      });
    }
    if (p.rank) {
      const medal = RANK_MEDAL[p.rank];
      const b = el('div', 'pbadge' + (medal ? ' medal' : ''), medal || `${p.rank}位`);
      chip.appendChild(b);
    }
    if (p.class && CLASS_LABEL[p.class]) {
      const clsBadge = el('div', `class-badge class-${p.class}`, `${CLASS_ICON[p.class]}${CLASS_LABEL[p.class]}`);
      chip.appendChild(clsBadge);
    }
    const avatarWrap = el('div', 'avatar-wrap');
    const ring = el('div', 'avatar-ring');
    const avatar = el('div', 'avatar');
    applyAvatarVisual(avatar, avatarForPlayer(p.id), p.name, p.id);
    if (justPlayed && justPlayed.playerId === p.id && Date.now() - justPlayed.ts < 900) {
      avatar.classList.add('just-played');
    }
    avatarWrap.append(ring, avatar);
    if (p.id === myPlayerId) {
      const editBtn = el('div', 'avatar-edit-mini', '✎');
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAvatarEditor();
      });
      avatarWrap.appendChild(editBtn);
    }
    const name = el('div', 'pname', p.name + (p.id === myPlayerId ? '（あなた）' : '') + (p.autoMode ? ' 🤖' : '') + (!p.connected ? ' 📶' : ''));
    const count = el('div', 'pcount', p.status === 'active' ? `${p.handCount}枚` : (p.status === 'finished' ? '上がり' : p.status === 'foul' ? '反則負け' : '離脱'));
    chip.append(avatarWrap, name, count);
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

// 手札から選ぶ特殊操作（中央エリアのパネルで操作するもの）
const PANEL_ACTION_TYPES = ['sevenGive', 'tenDiscard', 'classExchange'];

function isMyPanelAction(state) {
  const pending = state.pendingAction;
  return !!(pending && pending.by === myPlayerId && PANEL_ACTION_TYPES.includes(pending.type));
}

function renderSpecialBanner(state) {
  const banner = $('#special-banner');
  // 自分が操作する側のときは、中央のパネル自体に説明が出るのでバナーは出さない
  if (!state.pendingAction || isMyPanelAction(state)) {
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
  } else if (state.pendingAction.type === 'classExchange') {
    const target = state.players.find((p) => p.id === state.pendingAction.targetId);
    const targetName = target ? target.name : '';
    text = state.pendingAction.by === myPlayerId
      ? `カード交換！ ${targetName} さんへ返すカードを${state.pendingAction.count}枚選んでください`
      : `${byName} さんがカード交換で返すカードを選択中...`;
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
  { test: /カード交換|献上|返却/, cat: 'special', icon: '🔁' },
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

// 手札の重なり具合（--overlap）を、コンテナ幅に収まるように計算する。
// 選択状態には一切依存させない（カードを選ぶたびに他のカードの位置が動かないようにするため）。
function handMetrics(container) {
  const cards = Array.from(container.children).filter((c) => c.classList.contains('card'));
  const cs = getComputedStyle(container);
  return {
    cards,
    cardWidth: cards.length ? cards[0].offsetWidth : 0, // 選択中の持ち上げ（transform）の影響を受けない幅
    width: container.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0),
  };
}

// 左端の数字とマークが読める最小の見え幅
function handMinSpacing(cardWidth) {
  return Math.max(cardWidth * 0.32, 19);
}

function updateHandOverlap(container) {
  const m = handMetrics(container);
  const n = m.cards.length;
  if (n <= 1 || !m.cardWidth) { container.style.removeProperty('--overlap'); return; }
  const rawSpacing = (m.width - m.cardWidth) / (n - 1);
  const spacing = Math.min(m.cardWidth + 6, Math.max(handMinSpacing(m.cardWidth), rawSpacing));
  container.style.setProperty('--overlap', `${spacing - m.cardWidth}px`);
}

const CARD_ASPECT = 1.46; // カードの高さ÷幅（style.css の .card と同じ値）
const HAND_ROW_GAP = 10; // 2段表示の段の間隔（style.css の .my-hand.multi-rows と同じ値）
const LANDSCAPE_PHONE_MQ = window.matchMedia('(orientation: landscape) and (max-height: 500px)');
const WIDE_SCREEN_MQ = window.matchMedia('(min-width: 700px) and (min-height: 560px)');

// 画面の向き・大きさごとの、手札のカードの大きさの決め方
function handSizingRules() {
  const vh = window.innerHeight;
  if (LANDSCAPE_PHONE_MQ.matches) {
    // 横向きスマホ: 高さが貴重なので常に1行。カードの高さは画面の高さの約27%まで
    return { maxRows: 1, maxW: 80, minW: 44, heightBudget: vh * 0.27 };
  }
  if (WIDE_SCREEN_MQ.matches) {
    // タブレット・PC: 幅に余裕があるので1行で大きく
    return { maxRows: 1, maxW: 104, minW: 56, heightBudget: vh * 0.3 };
  }
  // 縦向きスマホ: 1行で十分大きく（comfortableW以上）並べられなければ、重ならない2段にして大きく見せる。
  // 手札エリアが画面の高さの約40%を超えない範囲で、できるだけ大きくする
  return { maxRows: 2, maxW: 96, minW: 46, heightBudget: vh * 0.4, comfortableW: 68 };
}

// 手札の枚数とコンテナ幅から、段数とカード幅を決める（選択状態には依存しない）
function chooseHandLayout(width, count) {
  const rules = handSizingRules();
  const fits = (w, rows) => {
    const perRow = Math.ceil(count / rows);
    const fitsWidth = perRow <= 1 || (width - w) / (perRow - 1) >= handMinSpacing(w);
    const fitsHeight = rows * w * CARD_ASPECT + (rows - 1) * HAND_ROW_GAP <= rules.heightBudget;
    return fitsWidth && fitsHeight;
  };
  const largest = (rows) => {
    for (let w = rules.maxW; w >= rules.minW; w--) if (fits(w, rows)) return w;
    return null;
  };
  const oneRow = largest(1);
  if (rules.maxRows === 1 || (oneRow && oneRow >= (rules.comfortableW || 0))) {
    return { rows: 1, cardWidth: oneRow || rules.minW };
  }
  const twoRows = largest(2);
  if (twoRows && (!oneRow || twoRows > oneRow)) return { rows: 2, cardWidth: twoRows };
  return { rows: 1, cardWidth: oneRow || rules.minW };
}

function layoutHand(wrap, cardEls) {
  const scrollLeft = wrap.scrollLeft;
  wrap.innerHTML = '';
  wrap.classList.remove('multi-rows');
  wrap.style.removeProperty('--overlap');

  const cs = getComputedStyle(wrap);
  const width = wrap.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const { rows, cardWidth } = chooseHandLayout(width, cardEls.length);
  wrap.style.setProperty('--hand-card-w', `${cardWidth}px`);

  if (rows === 1) {
    for (const c of cardEls) wrap.appendChild(c);
    updateHandOverlap(wrap);
  } else {
    wrap.classList.add('multi-rows');
    const perRow = Math.ceil(cardEls.length / rows);
    for (let i = 0; i < cardEls.length; i += perRow) {
      const row = el('div', 'hand-row');
      for (const c of cardEls.slice(i, i + perRow)) row.appendChild(c);
      wrap.appendChild(row);
      updateHandOverlap(row);
    }
  }
  // 再描画で横スクロール位置が先頭に戻ってしまわないようにする
  wrap.scrollLeft = scrollLeft;
}

// 直前にタップしたカード。持ち上げアニメーションはこのカードにだけ付ける
let handJustToggled = null;

function renderHand(state) {
  const wrap = $('#my-hand');
  const inSevenMode = state.pendingAction && state.pendingAction.type === 'sevenGive' && state.pendingAction.by === myPlayerId;
  const inTenMode = state.pendingAction && state.pendingAction.type === 'tenDiscard' && state.pendingAction.by === myPlayerId;
  const inExchangeMode = state.pendingAction && state.pendingAction.type === 'classExchange' && state.pendingAction.by === myPlayerId;

  const cardEls = state.myHand.map((card) => {
    if (inSevenMode) {
      return renderCardEl(card, {
        selected: sevenSelected.includes(card.id),
        onClick: () => toggleSevenCard(card.id, state.pendingAction.count),
      });
    }
    if (inTenMode) {
      return renderCardEl(card, {
        selected: tenSelected.includes(card.id),
        onClick: () => toggleTenCard(card.id, state.pendingAction.count),
      });
    }
    if (inExchangeMode) {
      return renderCardEl(card, {
        selected: exchangeSelected.includes(card.id),
        onClick: () => toggleExchangeCard(card.id, state.pendingAction.count),
      });
    }
    const selected = selectedCardIds.has(card.id);
    return renderCardEl(card, {
      selected,
      onClick: () => {
        if (selected) selectedCardIds.delete(card.id); else selectedCardIds.add(card.id);
        handJustToggled = card.id;
        vibrate(12);
        renderHand(state);
      },
    });
  });
  state.myHand.forEach((card, i) => {
    if (card.id === handJustToggled) cardEls[i].classList.add('pop');
  });
  handJustToggled = null;
  layoutHand(wrap, cardEls);
  updateActionButtons(state);
}

let handResizeTimer = null;
function scheduleHandRelayout() {
  clearTimeout(handResizeTimer);
  handResizeTimer = setTimeout(() => {
    if (latestGame) renderHand(latestGame);
  }, 150);
}
window.addEventListener('resize', scheduleHandRelayout);
window.addEventListener('orientationchange', scheduleHandRelayout);

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
  } else {
    const pa = state.pendingAction;
    const picking = {
      sevenGive: ['渡すカード', sevenSelected],
      tenDiscard: ['捨てるカード', tenSelected],
      classExchange: ['返すカード', exchangeSelected],
    }[pa.type];
    infoText.textContent = picking ? `${picking[0]}をタップ（${picking[1].length}/${pa.count}枚）` : '';
    clearBtn.classList.add('hidden');
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

// PC向けキーボードショートカット: Enter=出す / P=パス / Esc=選択解除
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
  if ($('#screen-game').classList.contains('hidden')) return;
  if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
  if (document.querySelector('.modal:not(.hidden)')) return;
  const key = e.key.toLowerCase();
  if (key === 'enter') {
    const btn = $('#btn-play');
    if (!btn.disabled && !btn.classList.contains('hidden')) { e.preventDefault(); btn.click(); }
  } else if (key === 'p') {
    const btn = $('#btn-pass');
    if (!btn.disabled && $('#action-bar').classList.contains('visible')) { e.preventDefault(); btn.click(); }
  } else if (key === 'escape') {
    if (selectedCardIds.size > 0) $('#btn-clear-sel').click();
  }
});

// ---------- Qボンバー モーダル ----------

function renderPendingModals(state) {
  const qModal = $('#modal-qbomber');
  const sModal = $('#panel-seven');
  const pending = state.pendingAction;
  $('#game-center').classList.toggle('has-panel', isMyPanelAction(state));

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

  const tModal = $('#panel-ten');
  if (pending && pending.type === 'tenDiscard' && pending.by === myPlayerId) {
    tModal.classList.remove('hidden');
    renderTenModal(state, pending);
  } else {
    tModal.classList.add('hidden');
    tenSelected = [];
  }

  const eModal = $('#panel-exchange');
  if (pending && pending.type === 'classExchange' && pending.by === myPlayerId) {
    eModal.classList.remove('hidden');
    renderExchangeModal(state, pending);
  } else {
    eModal.classList.add('hidden');
    exchangeSelected = [];
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
  handJustToggled = cardId;
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

// 選んだカードの横に、まだ選んでいない残り枠を点線で表示する（10捨て・カード交換・7わたし共通）
function renderEmptySlots(wrap, count) {
  for (let i = 0; i < count; i++) wrap.appendChild(el('div', 'card-slot', '?'));
}

// パネル内の選択済みカード。タップすると選択を取り消せる
function renderPickedCard(card, onRemove) {
  return renderCardEl(card, { small: true, onClick: onRemove });
}

function renderSevenModal(state, pending) {
  $('#seven-desc').textContent = `下の手札から渡すカードを${pending.count}枚選び、渡す相手をタップ（${sevenSelected.length}/${pending.count}枚）`;
  const wrap = $('#seven-cards');
  wrap.innerHTML = '';
  const others = state.players.filter((p) => p.status === 'active' && p.id !== myPlayerId);

  for (const cardId of sevenSelected) {
    const card = state.myHand.find((c) => c.id === cardId);
    if (!card) continue;
    // 渡せる相手が1人しかいない場合は自動で指定しておく
    if (others.length === 1 && !sevenAssign[cardId]) sevenAssign[cardId] = others[0].id;
    const row = el('div', 'seven-card-row');
    row.appendChild(renderPickedCard(card, () => toggleSevenCard(cardId, pending.count)));
    const targets = el('div', 'seven-targets');
    for (const o of others) {
      const chip = el('button', 'target-chip' + (sevenAssign[cardId] === o.id ? ' picked' : ''));
      chip.type = 'button';
      const face = el('div', 'avatar');
      applyAvatarVisual(face, avatarForPlayer(o.id), o.name, o.id);
      chip.append(face, el('span', 'target-name', o.name));
      chip.addEventListener('click', () => {
        sevenAssign[cardId] = o.id;
        vibrate(12);
        renderSevenModal(state, pending);
      });
      targets.appendChild(chip);
    }
    row.appendChild(targets);
    wrap.appendChild(row);
  }
  if (sevenSelected.length < pending.count) {
    const row = el('div', 'seven-card-row empty');
    renderEmptySlots(row, 1);
    row.appendChild(el('span', 'seven-empty-text', '下の手札からカードをタップ'));
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
  handJustToggled = cardId;
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
    wrap.appendChild(renderPickedCard(card, () => toggleTenCard(cardId, pending.count)));
  }
  renderEmptySlots(wrap, pending.count - tenSelected.length);
  $('#btn-ten-confirm').disabled = tenSelected.length !== pending.count;
}

$('#btn-ten-confirm').addEventListener('click', () => {
  socket.emit('game:tenDiscard', { cardIds: tenSelected.slice() });
  tenSelected = [];
});

// ---------- カード交換（階級制） モーダル ----------

function toggleExchangeCard(cardId, count) {
  handJustToggled = cardId;
  const idx = exchangeSelected.indexOf(cardId);
  if (idx >= 0) {
    exchangeSelected.splice(idx, 1);
  } else {
    if (exchangeSelected.length >= count) return;
    exchangeSelected.push(cardId);
  }
  renderGame(latestGame);
}

function renderExchangeModal(state, pending) {
  const target = state.players.find((p) => p.id === pending.targetId);
  $('#exchange-desc').textContent = `${target ? target.name : ''} さんへ返すカードを${pending.count}枚、下の手札から選んでください（${exchangeSelected.length}/${pending.count}枚 選択中）`;
  const wrap = $('#exchange-cards');
  wrap.innerHTML = '';
  for (const cardId of exchangeSelected) {
    const card = state.myHand.find((c) => c.id === cardId);
    if (!card) continue;
    wrap.appendChild(renderPickedCard(card, () => toggleExchangeCard(cardId, pending.count)));
  }
  renderEmptySlots(wrap, pending.count - exchangeSelected.length);
  $('#btn-exchange-confirm').disabled = exchangeSelected.length !== pending.count;
}

$('#btn-exchange-confirm').addEventListener('click', () => {
  socket.emit('game:classExchange', { cardIds: exchangeSelected.slice() });
  exchangeSelected = [];
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

  const revealWrap = $('#loser-reveal');
  if (state.loserReveal && state.loserReveal.cards.length > 0) {
    revealWrap.classList.remove('hidden');
    $('#loser-reveal-label').textContent = `${state.loserReveal.name} の残り手札`;
    const cardsWrap = $('#loser-reveal-cards');
    cardsWrap.innerHTML = '';
    for (const card of state.loserReveal.cards) {
      cardsWrap.appendChild(renderCardEl(card, { small: true }));
    }
  } else {
    revealWrap.classList.add('hidden');
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

$('#btn-forfeit-confirm').addEventListener('click', () => {
  socket.emit('game:forfeit');
  $('#modal-forfeit').classList.add('hidden');
});
$('#btn-forfeit-cancel').addEventListener('click', () => {
  $('#modal-forfeit').classList.add('hidden');
});

// ---------- PWA（ホーム画面に追加） ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* HTTP環境など登録できない場合は通常のWebアプリとして動く */ });
  });
}

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOSDevice() {
  const ua = navigator.userAgent;
  // iPadOS 13以降のSafariはMacとして名乗るため、タッチ対応かどうかでも判定する
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

let deferredInstallPrompt = null;

// Android（Chrome等）: ブラウザのインストールプロンプトを横取りして、ホーム画面のボタンから出す
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $('#btn-install').classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  $('#btn-install').classList.add('hidden');
});

$('#btn-install').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } catch { /* noop */ }
  deferredInstallPrompt = null;
  $('#btn-install').classList.add('hidden');
});

// iOS: インストールAPIが無いので、Safariで開いているときだけ手順を案内する
if (isIOSDevice() && !isStandaloneApp()) {
  $('#ios-install-hint').classList.remove('hidden');
}
