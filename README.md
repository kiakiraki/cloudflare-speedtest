# Speedtest | Cloudflare Edge

Cloudflare Workers 上で動くブラウザ向けスピードテストです。Vite + vanilla TypeScript 製で、フレームワークは使っていません。計測バックエンドには [speed.cloudflare.com](https://speed.cloudflare.com) を利用しています。

## 機能

- **測定フェーズ**: 待機 → レイテンシ → パケットロス → ダウンロード → アップロード → 完了 の順に自動実行
- **リアルタイムグラフ**: 測定中の瞬間速度を canvas 描画(`prefers-reduced-motion` 対応)
- **詳細メトリクス**:
  - 下り/上りそれぞれのピーク・持続・p90 速度
  - 待機時レイテンシ・ジッター・負荷時(ダウンロード中/アップロード中)レイテンシ
  - パケットロス率(WebRTC TURN リレー方式)
- **スコア表示**: 総合スコア(0–100)とグレード(S–E)、6 項目の内訳バー
- **接続情報**: 接続データセンター(Colo)、ISP、IP アドレス、通信プロトコル(HTTP/1.1 / HTTP/2 / HTTP/3)
- **測定オプション**: 測定時間(6 秒簡易 / 12 秒標準 / 30 秒精密)、プロトコル強制(自動 / HTTP/3 QUIC)

## 開発

```bash
npm install

# UI 開発用(Vite dev server。/api/* が存在しないためパケットロス測定は動きません)
npm run dev

# フル機能のローカル検証(build + wrangler dev)
npm run preview

# 本番デプロイ(build + wrangler deploy)
npm run deploy
```

### その他のコマンド

| コマンド | 内容 |
| --- | --- |
| `npm test` | Vitest によるユニットテスト |
| `npm run lint` | Biome による lint |
| `npm run format` | Biome によるフォーマット(シングルクォート・スペース) |
| `npm run build` | 両 tsconfig で typecheck → `vite build` |

## パケットロス測定について

パケットロスは、Cloudflare Realtime(TURN)が発行したクレデンシャルを使い、**TURN リレー経由の WebRTC データチャネル**で送出したパケットの到達率を測る方式です。RTCPeerConnection は Web Worker 内で利用できないため、この計測だけはメインスレッド側モジュール(`src/engine/packet-loss.ts`)で実行し、ワーカーとは `measure-loss` / `loss-result` メッセージでやり取りします。このため Worker に以下のシークレットが必要です。

```bash
# 本番
wrangler secret put TURN_KEY_ID
wrangler secret put TURN_TOKEN

# ローカル(wrangler dev 用)
echo 'TURN_KEY_ID=...' >> .dev.vars
echo 'TURN_TOKEN=...' >> .dev.vars
```

未設定の場合 `/api/turn-credentials` が 503 を返し、パケットロス欄は `--` 表示になります(他の測定は継続します)。

## アーキテクチャ

```
index.html            … UI 本体(日本語コピー)
src/main.ts           … クライアントエントリ(DOM UI・グラフ・スコア表示)
src/engine/
  engine.worker.ts    … 測定エンジン本体の Web Worker
                         (latency → loss → download/upload、speed.cloudflare.com と通信)
  protocol.ts         … main ↔ worker 間のメッセージ型定義
src/score.ts          … スコア計算の純粋関数(+ score.test.ts)
src/worker.ts         … Worker エントリ(dist/ の静的配信 + /api/turn-credentials)
```

- `src/main.ts` 側は DOM 型、`src/worker.ts` 側は Workers 型と、**tsconfig が二分されています**(ルート: `src/` 全体から `src/worker.ts` を除く / `tsconfig.worker.json`: `src/worker.ts` のみ)。両方を通らないファイルは型チェックされない点に注意してください。
- `dist/` はビルド生成物(gitignore 済み)です。
- API は `POST /api/turn-credentials` の 1 種類で、オリジンチェック + IP 単位のインメモリレートリミット付きです。

## スコア計算

各指標を 0–100 に正規化し、重み付け合算してグレードを決定します。

| 項目 | 重み | 目安 |
| --- | --- | --- |
| ダウンロード | 35% | 対数スケール(1 Mbps – 10 Gbps) |
| アップロード | 20% | 同上 |
| レイテンシ | 20% | 5 ms – 150 ms |
| ジッター | 8% | 1 ms – 40 ms |
| 安定性(速度変動 CV)| 5% | 測定できた場合のみ加算 |
| パケットロス | 12% | 0% – 3%(測定できた場合のみ加算) |

グレード閾値: **S** ≥ 90 / **A** ≥ 80 / **B** ≥ 68 / **C** ≥ 55 / **D** ≥ 40 / **E** < 40

## CI

GitHub Actions により `main` への push / PR で並列実行されます。

- **Lint & Format**: `biome lint` + `biome format`(Node 24)
- **Typecheck & Test & Build**: `vitest` + 両 tsconfig の typecheck + `vite build`
