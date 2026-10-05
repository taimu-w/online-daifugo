'use strict';

// 階級制（連続対戦オプション）まわりの純粋関数群。
// ゲーム状態は一切参照せず、「前回の順位配列」から「今回の階級」「カード交換プラン」を計算するだけ。

const CLASS_LABEL = {
  daifugo: '大富豪',
  fugo: '富豪',
  heimin: '平民',
  hinmin: '貧民',
  daihinmin: '大貧民',
};

// orderedIds: 前回の順位が良い順（1位, 2位, ...）に並んだプレイヤーID配列
// 人数に応じて富豪/貧民は4人以上のときのみ出現する（3人以下は 大富豪/平民/大貧民 のみ）。
function assignClasses(orderedIds) {
  const n = orderedIds.length;
  const map = new Map();
  orderedIds.forEach((id, idx) => {
    const rank = idx + 1;
    let cls;
    if (rank === 1) cls = 'daifugo';
    else if (rank === n) cls = 'daihinmin';
    else if (n >= 4 && rank === 2) cls = 'fugo';
    else if (n >= 4 && rank === n - 1) cls = 'hinmin';
    else cls = 'heimin';
    map.set(id, cls);
  });
  return map;
}

// classAssignments: assignClasses() の戻り値。tributeBoostPlayerId: 都落ちにより
// 献上枚数が増えるプレイヤーID（該当なしなら null）。
// 戻り値: [{ giverId, receiverId, tributeCount, returnCount }]
//   giverId が receiverId へ tributeCount 枚を強制献上し、receiver は returnCount 枚を選んで返す。
function buildExchangePlan(classAssignments, tributeBoostPlayerId) {
  const byClass = {};
  for (const [id, cls] of classAssignments) byClass[cls] = id;

  const plan = [];
  if (byClass.daifugo && byClass.daihinmin) {
    const tributeCount = tributeBoostPlayerId && tributeBoostPlayerId === byClass.daihinmin ? 3 : 2;
    plan.push({ giverId: byClass.daihinmin, receiverId: byClass.daifugo, tributeCount, returnCount: 2 });
  }
  if (byClass.fugo && byClass.hinmin) {
    plan.push({ giverId: byClass.hinmin, receiverId: byClass.fugo, tributeCount: 1, returnCount: 1 });
  }
  return plan;
}

module.exports = { CLASS_LABEL, assignClasses, buildExchangePlan };
