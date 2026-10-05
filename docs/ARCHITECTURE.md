# アーキテクチャ

このドキュメントは `server/` 配下の実装がどう動いているかを、コードを読まなくても追えるようにまとめたものです。ルール仕様そのものは [`大富豪_要件仕様書_v1.1.md`](../大富豪_要件仕様書_v1.1.md) を正とし、ここでは「それをどう実装したか」を扱います。

## 全体構成

```
ブラウザ（複数）
   │  Socket.IO（WebSocket）
   ▼
server/index.js       … Express静的配信 + Socket.IOイベントの配線
   │
   ▼
server/roomManager.js … ルーム（ロビー）の作成・参加・退出・オーナー管理
   │
   ▼
server/game/Game.js    … 1ゲームの状態機械（手札・場・革命・順位…すべて）
   │
   ├─ server/game/cards.js         … カード定義、強さ計算、山札生成
   ├─ server/game/handEvaluator.js … 役判定（単体/複数/階段）と役の強弱比較
   └─ server/game/classRules.js    … 階級制（連続対戦オプション）の階級判定・カード交換プラン算出
```

**責務分担の原則（仕様書12章準拠）**: ゲームロジックの判定・状態管理はすべてサーバー（`Game.js`）が行う。クライアント（`public/main.js`）はサーバーから受け取った状態を描画し、操作をイベントとしてサーバーに送るだけで、勝敗判定やルール判定は一切行わない。

## モジュール別の役割

### `server/index.js`
- Expressで `public/` を静的配信。
- Socket.IO接続ごとに `socket.data.roomCode` / `socket.data.playerId` を保持し、以後のイベントで「どのルームの誰か」を復元する。
- ルーム全体への通知（`broadcastLobby`）とプレイヤー個別への通知（`broadcastGame`、手札は本人にしか見せないため個別送信）を分けているのがポイント。
- `Game` の `update` / `gameEnd` イベントを購読し、変化があるたびに全クライアントへ再送する（`wireGame`）。ゲームロジック側は「誰に送るか」を意識しない設計。
- 切断時は即座にステータスを更新しつつ、`DISCONNECT_GRACE_MS`（60秒）後もまだ切断中ならBot化（`setAutoMode`）する猶予処理をここで管理する。

### `server/roomManager.js`
- `RoomManager`: ルームコードの発行と`Room`インスタンスの管理。デフォルトはランダムな6桁だが、`createRoom(customCode)` で作成者が任意の文字列（20文字以内、大文字に正規化、重複不可）を指定することもできる。
- `Room`: 参加者リスト、オーナー、ゲームインスタンスを保持。オーナー退出時の自動移譲（`transferOwnerIfNeeded`）、最大7人/最小2人などロビー側のルールはここに閉じている。
- ゲームが始まると `Room.game`（`Game`インスタンス）を1つ保持する。ゲーム終了後も`Room`は保持され続け、「もう一度プレイ」で同じルームに新しい`Game`を生成し直す（仕様書2章の「ゲーム状態は毎回初期化」に対応）。
- プレイヤーのアイコン（`avatar`: プリセット写真ID＋パン/ズーム）も `Room.players` の各エントリが保持する。表示専用のデータで判定に一切使わないため、あえて `Game.js` には持ち込まず `Room`（ロビー層）止まりにしている。`player:avatar` イベントで対戦中でも更新でき、`lobbyState()` 経由で全員にブロードキャストされる（[docs/SOCKET_API.md](SOCKET_API.md) 参照）。
- `Room.classRule` / `Room.miyakoOchi`: 連続対戦オプション（階級制・都落ち）のオン/オフ。`setOptions()` でオーナーのみ・非対戦中のみ変更可。`Room.lastRanking`（直前ゲームの順位）と `Room.tributeBoostPlayerId`（都落ちにより次回献上3枚になるプレイヤー）を保持し、`startGame()` で前回結果から階級・カード交換プランを組み立てて `Game` に渡す。`gameEnd` イベント購読側（`server/index.js#wireGame`）が `Room.recordGameResult(ranking, game.enteredClasses)` を呼び、次回分の `lastRanking` / `tributeBoostPlayerId` を更新する。階級判定・交換プラン算出の純粋関数は `server/game/classRules.js` に分離。詳細は後述の「階級制・都落ち（連続対戦オプション）」を参照。

### `server/game/cards.js`
- ランクを **3〜15の数値** で表現する（3=3, …, 11=J, 12=Q, 13=K, 14=A, 15=2）。この並びにしておくと「通常時の強さ＝数値の昇順」に一致し、革命時は `18 - rank` で反転できる。
- ジョーカーは `JOKER_RANK = 16` という番兵値。実際の強さ比較では常に別枠（`cardEffectiveValue` で1000扱い）として最強にしている。
- `createDeck` / `shuffle` / `sortHand` などデッキ・表示まわりのユーティリティ一式。

### `server/game/handEvaluator.js`
- `classifyHand(cards, choice)`: 選択されたカード配列が「単体・複数・階段」のどれとして成立するかを判定する純粋関数。ゲーム状態は一切参照しない。
  - 階段でジョーカーの延長方向（上に伸ばすか下に伸ばすか）が複数通り考えられる場合は `ok:false, needsChoice:true` を返し、クライアントに選択させる（`stairsJokerExtend`）。これがサーバー⇄クライアント間の唯一の「役の解釈をクライアントに聞く」ケース。
  - `suits`: マーク縛り判定に使うスート集合（ジョーカーはワイルドなので含めない）。
  - `jokerSlotRanks`: 階段でジョーカーが実際にどのランクの代役をしているかの集合。8切りやJバックなどの特殊効果が階段に含まれる場合の発動判定に使う。
- `canBeat(fieldHand, newHand, reversed)`: 場の役に対して出せるかどうか（種類・枚数一致 かつ 実効的な強さが上回っているか）。

### `server/game/Game.js`
ゲーム進行の中核。`EventEmitter` を継承し、状態が変わるたびに `update`（毎回）と `gameEnd`（終了時）を発火する。詳細は次節「ゲーム状態機械」を参照。

### `public/main.js`
- サーバーから届く `room:state` / `game:state` をそのまま描画するだけの薄いビュー層。ローカルに持つ状態は「選択中のカードID」「モーダルの入力途中の値」など、UI操作の一時状態のみ。
- `localStorage` にセッション（`playerId` / `roomCode`）を保存し、リロードや再接続時に `room:rejoin` で復帰する。
- 7わたし・10捨て・カード交換の選択UIは、手札エリアに重ならないよう `#game-center` 内のパネル（`#panel-seven` 等）として描画する（スマホ横向きでもカードを選び直せるようにするため）。Qボンバー・結果画面などはモーダル。
- 手札は縦画面で1行に収まらない場合、`layoutHand` が重ならない2段の `.hand-row` に分割する。重なり幅（`--overlap`）は `updateHandOverlap` が枚数とコンテナ幅だけから計算し、選択状態には依存させない（選択は `--lift` で持ち上げるだけなので、カードを選んでも他のカードの位置は動かない）。カード幅は `chooseHandLayout` が画面の向き・大きさ・枚数から決めて `--hand-card-w` に設定し、カードの高さと数字・マークの大きさは CSS 側で幅に比例させている（`.card` の `--cw` と `cqw` 単位）。
- PWA: `public/manifest.webmanifest` と `public/sw.js`（ネットワーク優先のシェルキャッシュ、`/socket.io/` と他オリジンには介入しない）。登録とインストール導線（Androidの `beforeinstallprompt`、iOSの案内表示）は `main.js` 末尾。

### ログの公開範囲
- `Game#_pushLog(message, { visibleTo, publicMessage })` で、ログごとに「誰に中身を見せるか」を指定できる。`visibleTo` に含まれないプレイヤーには `getPublicState` で `publicMessage` に差し替えて返す（ログの件数は全員同じなので、クライアント側の差分表示は崩れない）。
- 7わたし（`_applySevenGive`）と階級制の献上・下賜（`_applyForcedTributes` / `_applyClassExchangeReturn`）は、カードの中身を当事者2人にだけ見せ、それ以外には枚数のみを見せる。

## ゲーム状態機械

### フェーズ遷移（ルーム単位）

```
ロビー（待機） --room:start(オーナー)--> 対戦中 --全員パス/上がりで終了--> 結果画面
     ▲                                                                    │
     └────────────────────── room:start（再戦） ─────────────────────────┘
```

`Room.game` は対戦中〜結果画面表示中の間ずっと同じインスタンスを指す。再戦時は `Room.startGame` が新しい `Game` を作り直すため、前ゲームの状態が引き継がれることはない。

### `Game` インスタンスが持つ主要な状態

| フィールド | 内容 |
|---|---|
| `players[]` | 各プレイヤーの手札・ステータス（`active`/`finished`/`foul`/`left`）・順位・接続状況 |
| `field` | 場に出ているカードと役（`hand`）、出したプレイヤー |
| `chain` | マーク縛り用。直前に出た役のスート集合（`previousSuits`）と、確定した必須スート集合（`mandatorySuits`） |
| `revolution` / `jbackActive` | 革命・Jバックの発動状態。実効的な強弱反転は `reversed` getter（`revolution XOR jbackActive`）で算出 |
| `currentPlayerId` | 現在の手番 |
| `pendingQueue` / `pendingAction` | Qボンバー・7わたし・10捨てのうち、1回のプレイで複数同時発動した場合の待ち行列と現在処理中のもの |
| `finalContext` | 特殊効果の解決を挟んでからターンを進めるための「保留中のプレイ結果」 |
| `nextTopRank` / `nextBottomRank` | 上がった順に上から、反則・離脱した順に下から埋めていく順位カウンタ |

### 1手のプレイ処理の流れ（`playCards`）

仕様書13章の優先順位に沿って実装されている。

1. **カード判定** — `classifyHand` で役として成立するか（不成立・ジョーカー延長要選択ならここで打ち切り）
2. 場の役より強いか（`canBeat`）。ただし **スペ3返し**（単体ジョーカー場への♠3）は例外的に無条件で通す
3. **縛り判定** — 出せるカードか（`mandatorySuits` を満たせるか）をここでチェックしてから手札を減算
4. 手札からカードを除去 → `_updateShibari` でマーク縛りの状態を更新
5. **革命判定**（同ランク4枚以上 or 4枚以上の階段）
6. **8切り判定** → 該当すれば即座に場を流し、次の手番を「出した本人」に設定
7. **Jバック判定** → `jbackActive` を反転
8. **Qボンバー／7わたし／10捨て** の発動対象カードを数え、`pendingQueue` に積む
9. `pendingQueue` が空でなければ、ここで一旦 `return`。以降はクライアントからの `game:qbomber` / `game:sevenGive` / `game:tenDiscard` 応答を待つ（`resolveXxx` → `_advancePendingQueue` → 空になったら `_concludeTurn`）
10. 全ての特殊効果解決後、`_finalizePlay` で**上がり判定・反則判定・ターン進行**を行う

ジョーカーを含む役でも「実際に何のランクとして扱われているか」（`hasRank` / `countRankEffect`）を見て8切り・Jバック・Qボンバー・7わたし・10捨てà発動させている。階段の場合はジョーカーが埋めている実ランク（`jokerSlotRanks`）を見る。

### マーク縛り（`_updateShibari`）

仕様書のマーク縛りは「直前の役とスートの共通部分を単調に確定・拡大させる」ロジックで実装している（README「実装上の補足」参照）。

1. 直前の役のスート集合と今回の役のスート集合の**共通部分（積集合）**を取る
2. まだ `mandatorySuits` が確定していなければ、共通部分があればそれを確定値にする
3. 既に確定していれば、新しい共通部分が空でない限りその積集合でさらに絞り込む（空になったら従来の確定値を維持）
4. 場が流れたら（`_flowField`）`chain` は全リセット

### 上がり・反則・離脱・ゲーム終了

- **禁止カードでの上がり**（8・J・ジョーカー・その時点の最強札）と**スペ3返しでの上がり**は `_finalizePlay` 内で判定し、該当すれば `_faultFinish(id, 'foul')` を呼ぶ。♠3そのものは禁止カードではなく、スペ3返しのときだけ `finalContext.spade3Return` が立ち、それで手札0枚になった場合のみ反則になる（通常の♠3単体出しや、♠3を含むペア等での上がりは正当）。手札はすべて破棄、`nextBottomRank` から順位を割り当て、以後そのプレイヤーはターンに参加しない。
- **Qボンバー／10捨て／7わたしで手札が0枚になった場合は反則判定の対象外**（仕様どおり）。それぞれ `_checkZeroHandAgariForAll` / `_finishPlayer` で直接「上がり」処理をする。
- **途中離脱**（`voluntaryLeave`）と**反則負け**は同じ `_faultFinish` を通る（`reason` が `'left'` か `'foul'` かの違いのみ）。
- 場の所有者が離脱・反則負けした場合、場は自動的に流れる。
- `getActivePlayers().length <= 1` になった時点で `_checkGameEnd` がゲーム終了を確定し、`gameEnd` イベントを発火する。

### タイムアウト

| 種類 | 時間 | タイムアウト時の挙動 |
|---|---|---|
| 通常ターン | 60秒 | 場があれば自動パス。場が空なら手札の最弱の単騎を自動プレイ |
| Qボンバー選択 | 60秒 | ランダムな数字を必要数選択 |
| 7わたし選択 | 60秒 | 手札の先頭からランダムな相手へ配布 |
| 10捨て選択 | 60秒 | 手札からランダムに必要数を選択して捨てる |
| カード交換（階級制）の下賜選択 | 60秒 | 手札から最弱のカードを必要数自動選択 |

切断から60秒（`DISCONNECT_GRACE_MS`、`server/roomManager.js`で定義）経過すると自動的に `autoMode` が有効になり、以後は毎ターンのタイムアウト処理（自動パス等）に従って進行する。再接続すると `autoMode` は解除される。

### 階級制・都落ち（連続対戦オプション）

`Room.classRule` / `Room.miyakoOchi` がオンのとき、`Room.startGame` は前回の `lastRanking`（順位）から `server/game/classRules.js#assignClasses` で階級（`daifugo`/`fugo`/`heimin`/`hinmin`/`daihinmin`）を算出し、`buildExchangePlan` でカード交換プラン（誰が誰へ何枚献上し、何枚下賜するか）を組み立てて `new Game(roster, { exchangePlan, enteredClasses, firstPlayerId })` に渡す。直前ゲームと参加メンバーの集合が完全一致しない場合は交換なしで通常開始する（`Room.startGame` 内でチェック）。

`Game` 側の処理（`_deal()` の直後、通常のターン開始より前に割り込む）:

1. `_applyForcedTributes`: 貧民/大貧民の最強カードを`tributeCount`枚、強制的に富豪/大富豪の手札へ移動（選択の余地なし）。
2. 富豪・大富豪が下賜する`returnCount`枚を選ぶための `pendingAction`（`type: 'classExchange'`）を`exchangeQueue`から1件ずつ取り出してセット。既存の `pendingQueue`（Qボンバー等）と同じ「1件ずつ解決してから次へ」というパターンを踏襲している（`_advanceExchangeQueue`）。この間、`playCards` / `pass` は既存の `pendingAction` ガードでブロックされる。
3. `resolveClassExchange(playerId, cardIds)` で下賜カードを確定 → キューが空になったら `_beginPlay(firstPlayerId)` で通常のターン進行を開始する（`firstPlayerId` は前回の大貧民。階級制でなければ通常どおり♠3所持者が先手）。

**都落ち**: 前回`daifugo`だったプレイヤーが今回`daihinmin`（最下位）になった場合、`Room.recordGameResult`（`gameEnd` 時に `server/index.js#wireGame` から呼ばれる）が `tributeBoostPlayerId` にそのプレイヤーIDをセットする。次回の交換プラン算出時、そのプレイヤーが献上する側（`daihinmin`）に該当すれば献上枚数が2枚→3枚に増える（下賜は常に2枚のまま、富豪⇔貧民間には影響しない）。

`Game.enteredClasses`（`Map<playerId, class>`）はこのゲーム開始時点の階級で、`getPublicState` では各プレイヤーの `class` として公開する（都落ち判定・UIバッジ表示用）。

## 補足: 仕様書からの拡張・解釈

- **10捨て**: `大富豪_要件仕様書_v1.1.md` には明記されていないが、現在の実装には「10を出すと出した枚数分だけ手札から任意のカードを捨てられる」ローカルルールが実装済み（`server/game/Game.js` の `resolveTenDiscard` 系）。ルール追加・変更時は README と本書の両方を更新すること。
- **階級制・都落ち**: 同じく仕様書には明記されていない連続対戦オプション。詳細はREADMEの該当セクションと上記「階級制・都落ち（連続対戦オプション）」を参照。
- そのほかの仕様上あいまいな箇所への解釈は [README.md](../README.md) の「実装上の補足」セクションを参照。
