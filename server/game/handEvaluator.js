'use strict';

const { JOKER_RANK, cardEffectiveValue } = require('./cards');

// 選択されたカード配列を役として解析する。
// choice: 階段でジョーカーの延長方向に複数の可能性がある場合に指定する { extendDown }
// 戻り値: { ok, error, kind, length, rank, minRank, maxRank, suit, suits: Set }
//   kind: 'single' | 'multi' | 'stairs'
//   rank: single/multi の代表ランク（JOKER_RANK含む）
//   suits: 縛り判定に使うスートの集合（ジョーカーはワイルドなので含めない）
//   jokerSlotRanks: 階段でジョーカーが埋めている実際のランクの集合（特殊効果判定に使用）
//   曖昧な場合は ok:false, needsChoice:true, options:[{extendDown,finalMin,finalMax}] を返す
function classifyHand(cards, choice) {
  if (!cards || cards.length === 0) {
    return { ok: false, error: 'カードが選択されていません' };
  }

  const jokers = cards.filter((c) => c.joker);
  const nonJokers = cards.filter((c) => !c.joker);

  // 純ジョーカーのみのケース
  if (nonJokers.length === 0) {
    if (jokers.length === 1) {
      return { ok: true, kind: 'single', length: 1, rank: JOKER_RANK, suits: new Set() };
    }
    if (jokers.length === 2) {
      // JOKER+JOKER はペア扱いで最強
      return { ok: true, kind: 'multi', length: 2, rank: JOKER_RANK, suits: new Set(), jokerPair: true };
    }
    return { ok: false, error: '無効なカードの組み合わせです' };
  }

  const sameRank = nonJokers.every((c) => c.rank === nonJokers[0].rank);
  if (sameRank) {
    const rank = nonJokers[0].rank;
    const suits = new Set(nonJokers.map((c) => c.suit));
    if (suits.size !== nonJokers.length) {
      return { ok: false, error: '同じカードが重複しています' };
    }
    const kind = cards.length === 1 ? 'single' : 'multi';
    return { ok: true, kind, length: cards.length, rank, suits };
  }

  // 階段判定: 非ジョーカーが全て同一スートで、ジョーカーで隙間/両端を埋めて連続にできるか
  const suit = nonJokers[0].suit;
  if (!nonJokers.every((c) => c.suit === suit)) {
    return { ok: false, error: '役として成立しません（スートまたは数字が揃っていません）' };
  }
  if (cards.length < 3) {
    return { ok: false, error: '階段は3枚以上必要です' };
  }
  const ranks = nonJokers.map((c) => c.rank).sort((a, b) => a - b);
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] === ranks[i - 1]) {
      return { ok: false, error: '同じ数字が重複しています' };
    }
  }
  const minR = ranks[0];
  const maxR = ranks[ranks.length - 1];
  const existingSpan = maxR - minR + 1;
  const internalGapCards = existingSpan - ranks.length; // 内部の穴を埋めるのに必要なジョーカー数
  if (internalGapCards < 0 || jokers.length < internalGapCards) {
    return { ok: false, error: '階段として成立しません（2の次に3へは接続できません）' };
  }
  const leftover = jokers.length - internalGapCards;

  // 余ったジョーカーを上端・下端どちらに延長するか、有効な組み合わせを列挙する
  const validOptions = [];
  for (let extendDown = 0; extendDown <= leftover; extendDown++) {
    const extendUp = leftover - extendDown;
    const finalMin = minR - extendDown;
    const finalMax = maxR + extendUp;
    if (finalMin < 3 || finalMax > 15) continue;
    validOptions.push({ extendDown, extendUp, finalMin, finalMax });
  }
  if (validOptions.length === 0) {
    return { ok: false, error: '階段として成立しません（範囲を超えています）' };
  }

  let chosen;
  if (validOptions.length === 1) {
    chosen = validOptions[0];
  } else {
    const requestedExtendDown = choice && Number.isInteger(choice.extendDown) ? choice.extendDown : null;
    chosen = requestedExtendDown !== null ? validOptions.find((o) => o.extendDown === requestedExtendDown) : null;
    if (!chosen) {
      return {
        ok: false,
        needsChoice: true,
        choiceType: 'stairsJokerExtend',
        suit,
        options: validOptions.map((o) => ({ extendDown: o.extendDown, finalMin: o.finalMin, finalMax: o.finalMax })),
        error: 'ジョーカーの役割を選択してください',
      };
    }
  }

  const { finalMin, finalMax } = chosen;
  const jokerSlotRanks = [];
  for (let r = finalMin; r <= finalMax; r++) {
    if (!ranks.includes(r)) jokerSlotRanks.push(r);
  }

  return {
    ok: true,
    kind: 'stairs',
    length: cards.length,
    minRank: finalMin,
    maxRank: finalMax,
    suit,
    suits: new Set([suit]),
    jokerSlotRanks: new Set(jokerSlotRanks),
  };
}

// 役の実効的な強さ（比較用の数値）を返す。reversed = 革命 XOR Jバック。
function handStrengthValue(hand, reversed) {
  if (hand.kind === 'stairs') {
    return reversed ? (18 - hand.maxRank) : hand.maxRank;
  }
  if (hand.rank === JOKER_RANK) return 1000;
  return reversed ? (18 - hand.rank) : hand.rank;
}

// 新しい役が場の役に対して合法かどうか（枚数・種類一致 かつ 現在の場より強い）
function canBeat(fieldHand, newHand, reversed) {
  if (!fieldHand) return true; // 場に何もない場合は何でも出せる（枚数の縛りのみ別途チェック）
  if (fieldHand.length !== newHand.length) return false;
  if (fieldHand.kind !== newHand.kind) return false;
  return handStrengthValue(newHand, reversed) > handStrengthValue(fieldHand, reversed);
}

module.exports = { classifyHand, handStrengthValue, canBeat };
