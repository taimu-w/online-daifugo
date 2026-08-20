'use strict';

// ランクは 3..15 の数値で表現する。
// 3,4,5,6,7,8,9,10,J(11),Q(12),K(13),A(14),2(15)
// この並びだと「通常時の強さ」が数値の昇順とそのまま一致する。
const SUITS = ['S', 'H', 'D', 'C']; // ♠ ♡ ♢ ♣
const SUIT_LABEL = { S: '♠', H: '♡', D: '♢', C: '♣' };

const RANK_LABEL = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2',
};

const JOKER_RANK = 16; // 常に最強を表す番兵値

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 3; rank <= 15; rank++) {
      deck.push({ id: `${suit}${rank}`, suit, rank, joker: false });
    }
  }
  deck.push({ id: 'JOKER1', suit: null, rank: JOKER_RANK, joker: true });
  deck.push({ id: 'JOKER2', suit: null, rank: JOKER_RANK, joker: true });
  return deck;
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// カード1枚の強さの数値化。reversed = 革命とJバックの実効反転状態。
function cardEffectiveValue(card, reversed) {
  if (card.joker) return 1000; // ジョーカーは常に最強
  return reversed ? (18 - card.rank) : card.rank;
}

function isStrongestNormalRank(rank, revolution) {
  // 通常時最強=2(15) / 革命時最強=3
  return revolution ? rank === 3 : rank === 15;
}

function rankLabel(rank) {
  if (rank === JOKER_RANK) return 'JOKER';
  return RANK_LABEL[rank] || String(rank);
}

function cardLabel(card) {
  if (card.joker) return 'JOKER';
  return `${SUIT_LABEL[card.suit]}${rankLabel(card.rank)}`;
}

function sortHand(cards) {
  return cards.slice().sort((a, b) => {
    if (a.joker && b.joker) return 0;
    if (a.joker) return 1;
    if (b.joker) return -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  });
}

module.exports = {
  SUITS,
  SUIT_LABEL,
  RANK_LABEL,
  JOKER_RANK,
  createDeck,
  shuffle,
  cardEffectiveValue,
  isStrongestNormalRank,
  rankLabel,
  cardLabel,
  sortHand,
};
