# Socket.IO 通信仕様

クライアント⇔サーバー間はすべて Socket.IO のイベントで通信する（REST APIは存在しない）。実装は [`server/index.js`](../server/index.js) と [`public/main.js`](../public/main.js)。

サーバーは各接続の `socket.data.roomCode` / `socket.data.playerId` に現在の所属ルームとプレイヤーIDを紐づけており、`room:create` / `room:join` / `room:rejoin` のいずれかを送るまでは他のイベントは実質何もしない（ルーム・プレイヤーが特定できないため）。

## クライアント → サーバー

### ロビー系

| イベント | ペイロード | 説明 |
|---|---|---|
| `room:create` | `{ name: string, roomCode?: string }` | 新規ルームを作成し、自分がオーナーとして参加する。`roomCode` を指定するとそのIDでルームを作成（大文字に正規化、20文字以内、重複時は`error`）。省略時はランダムな6文字コードを自動生成 |
| `room:join` | `{ roomCode: string, name: string }` | 既存ルームに参加する。対戦中（`ended`でない）のルームには参加不可 |
| `room:rejoin` | `{ roomCode: string, playerId: string }` | 切断・リロード後の復帰。`localStorage` に保存したセッションから自動送信される |
| `room:start` | なし | ゲーム開始（オーナーのみ、2人以上必要）。結果画面からの「もう一度プレイ」もこのイベントを再送する |
| `room:leave` | なし | ルーム退出。対戦中なら `voluntaryLeave` 扱いで即座に最下位確定 |

### ゲーム系

| イベント | ペイロード | 説明 |
|---|---|---|
| `game:play` | `{ cardIds: string[], stairsChoice?: { extendDown: number } }` | カードを出す。`stairsChoice` は階段でジョーカーの延長方向が一意に決まらない場合のみ、`game:needsChoice` を受けて再送する |
| `game:pass` | なし | パス（場が空のときは不可） |
| `game:qbomber` | `{ numbers: number[] }` | Qボンバーで捨てさせる数字を指定（ランク数値、下表参照） |
| `game:sevenGive` | `{ allocation: { cardId: string, toPlayerId: string }[] }` | 7わたしで渡すカードと相手の組み合わせ |
| `game:tenDiscard` | `{ cardIds: string[] }` | 10捨てで自分の手札から捨てるカード |
| `game:forfeit` | なし | ゲーム棄権（対戦中に即座に最下位確定。ルームからは退出しない） |

`game:play` / `game:pass` / `game:qbomber` / `game:sevenGive` / `game:tenDiscard` はいずれも失敗時に `error` イベントで理由を返す（同期的な戻り値はない）。`game:play` のみ、階段のジョーカー割り当てが曖昧な場合は `error` の代わりに `game:needsChoice` を返す。

## サーバー → クライアント

| イベント | ペイロード | 説明 |
|---|---|---|
| `joined` | `{ playerId, roomCode, name }` | `room:create` / `room:join` / `room:rejoin` 成功時に本人だけに送られる |
| `room:state` | `LobbyState`（下記） | ルーム内の全員に送信。参加/退出/ゲーム開始/終了のたびに再送 |
| `game:state` | `PublicGameState`（下記） | ゲーム中の全プレイヤーに**個別**送信（`myHand` が本人のものだけになるため） |
| `game:needsChoice` | `{ choiceType: 'stairsJokerExtend', suit, options, cardIds }` | 階段のジョーカー役割を選ばせるモーダル表示用 |
| `error` | `{ message: string }` | 直前の操作が拒否された理由（トースト表示のみ、システムエラーではない） |

## データ形状

### Card

```ts
{ id: string, suit: 'S'|'H'|'D'|'C'|null, rank: number, joker: boolean }
```

- `rank` は3〜15の数値（3=3, …, 11=J, 12=Q, 13=K, 14=A, 15=2）。ジョーカーは `rank: 16` で `suit: null`。
- `id` はジョーカー以外 `${suit}${rank}`（例: `S15` = ♠2）、ジョーカーは `JOKER1` / `JOKER2`。

### LobbyState（`room:state`）

```ts
{
  roomCode: string,
  ownerId: string | null,
  started: boolean,   // ゲーム中か
  gameOver: boolean,  // ゲームが終了し結果画面を出すべきか
  players: { id, name, connected, isOwner }[],
  minPlayers: 2,
  maxPlayers: 7,
}
```

### PublicGameState（`game:state`、`Game.getPublicState(viewerId)`）

```ts
{
  players: {
    id, name, handCount, status,      // 'active'|'finished'|'foul'|'left'
    rank: number | null, connected, autoMode, isCurrentTurn,
  }[],
  field: { cards: Card[], kind: 'single'|'multi'|'stairs'|null, ownerId },
  revolution: boolean,
  jbackActive: boolean,
  reversed: boolean,              // revolution XOR jbackActive（表示用の実効反転フラグ）
  shibari: string[] | null,       // マーク縛りで必須のスート配列（例: ['S','H']）
  currentPlayerId: string,
  turnDeadline: number | null,    // Date.now() 基準のUnixミリ秒
  pendingAction: PendingAction | null,
  myHand: Card[],                 // 自分の手札のみ。他人の手札は handCount しか見えない
  log: { message: string, at: number }[],  // 直近30件
  ended: boolean,
  finalRanking: { id, name, rank, status }[] | null,  // ended時のみ
}
```

### PendingAction

```ts
// Qボンバー
{ type: 'qbomber', by: string, count: number, deadline: number, options: number[] }
// 7わたし
{ type: 'sevenGive', by: string, count: number, deadline: number }
// 10捨て
{ type: 'tenDiscard', by: string, count: number, deadline: number }
```

`pendingAction` がセットされている間、`playCards` / `pass` は常に拒否される（特殊効果の解決が最優先）。

## 典型的なやり取りの例

**カードを出す（通常）**
```
client → game:play { cardIds: ["S15", "H15"] }
server → game:state（全員へ、個別に myHand を差し替えて）
```

**階段でジョーカーの延長方向が曖昧な場合**
```
client → game:play { cardIds: ["S10","S11","JOKER1"] }
server → game:needsChoice { choiceType: 'stairsJokerExtend', suit: 'S', options: [...], cardIds: [...] }
client → game:play { cardIds: ["S10","S11","JOKER1"], stairsChoice: { extendDown: 1 } }
server → game:state
```

**Qボンバー発動**
```
client → game:play { cardIds: ["S12"] }          // Qを1枚出す
server → game:state（pendingAction: { type:'qbomber', count:1, by: 自分 }）
client → game:qbomber { numbers: [15] }           // 2を指定
server → game:state（pendingAction が null に戻り、全員の該当ランクが手札から消える）
```
