<h1 align="center">Openship</h1>

<p align="center">
  CI/CD を内蔵した、オープンソースでセルフホスト可能なデプロイプラットフォーム。<br>
  コードをプッシュし、コンテナをデプロイし、インフラを管理 — デスクトップアプリ、Web ダッシュボード、または CLI から。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openship"><img src="https://img.shields.io/npm/v/openship?color=0b7285&label=npm" alt="npm version" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  <a href="https://openship.io"><img src="https://img.shields.io/badge/website-openship.io-0b7285" alt="Website" /></a>
</p>

<p align="center">
  <a href="../../README.md"><img src="https://img.shields.io/badge/lang-English-555" alt="English" /></a>
  <a href="README.ar.md"><img src="https://img.shields.io/badge/lang-العربية-555" alt="العربية" /></a>
  <a href="README.zh.md"><img src="https://img.shields.io/badge/lang-简体中文-555" alt="简体中文" /></a>
  <a href="README.es.md"><img src="https://img.shields.io/badge/lang-Español-555" alt="Español" /></a>
  <a href="README.fr.md"><img src="https://img.shields.io/badge/lang-Français-555" alt="Français" /></a>
  <a href="README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-0b7285" alt="日本語" /></a>
  <a href="README.pt.md"><img src="https://img.shields.io/badge/lang-Português-555" alt="Português" /></a>
  <a href="README.de.md"><img src="https://img.shields.io/badge/lang-Deutsch-555" alt="Deutsch" /></a>
  <a href="README.tr.md"><img src="https://img.shields.io/badge/lang-Türkçe-555" alt="Türkçe" /></a>
</p>

<p align="center">
  <img src="../screenshots/screen.png" alt="Openship dashboard" width="800" />
</p>

---

## クイックスタート

```bash
npm i -g openship
openship init
```

これだけです。または Docker がお好みなら：

```bash
git clone https://github.com/oblien/openship.git && cd openship
cp .env.example .env
docker compose up -d
```

または [openship.io](https://openship.io) からデスクトップアプリをダウンロードしてください。

---

## できること

リポジトリを指定するだけ。Openship がスタックを検出し、ビルドし、すべてを設定してデプロイします — 設定ファイルなし、パイプラインなし、YAML なし。

データベース、ドメイン、SSL、CDN、メール、バックアップ — すべてを一元管理。

**Openship Cloud**（マネージド）でも、あなたが所有する**任意の Linux サーバー**でも動作します。個人開発者のサイドプロジェクトも、本番環境を運用するチームも、同じツールを使います。

---

## 特徴

| | |
|---|---|
| **CI/CD 内蔵** | プッシュでデプロイ、プレビュー環境、staging/本番 フロー、ロールバック |
| **あらゆるスタック** | Node、Python、Go、Rust、PHP、Ruby、Java、.NET、Docker、モノレポ |
| **フルバックエンド** | Postgres、MySQL、MongoDB、Redis、ワーカー、WebSocket、ストレージ |
| **ドメインと SSL** | 自動 Let's Encrypt、ワイルドカード、無制限のドメイン、自動更新 |
| **CDN** | エッジキャッシュ、HTTP/3、Brotli 圧縮、即時パージ |
| **メールサーバー** | DKIM/SPF/DMARC 対応の SMTP を内蔵 — Mailgun や SES は不要 |
| **バックアップ** | スケジュール、データベース + ボリューム、ワンクリック復元、いつでもエクスポート |
| **リアルタイム監視** | ライブビルドログ、コンテナメトリクス、リソース使用状況を画面にストリーミング |
| **スケーリング** | クラウドでの自動スケール、セルフホストでマルチノード対応 |
| **ポータビリティ** | 標準的な Docker コンテナ — プロバイダー間を自由に移動 |
| **Docker Compose** | 既存の compose ファイルをそのままデプロイ |

---

## どこにでもデプロイ

- **Openship Cloud** — マネージド、自動スケール、設定不要
- **任意の VPS** — Hetzner、DigitalOcean、Linode、OVH など
- **専用サーバー** — ベアメタル、コロケーション、ホームラボ
- **マルチサーバー** — 複数のマシンに負荷を分散

どこにデプロイしても同じインターフェース。

---

## 3 つのインターフェース

- **デスクトップアプリ** — 完全な GUI、リアルタイムログ、すべてワンクリック。
- **Web ダッシュボード** — ブラウザ上の同じ UI、チーム向け。
- **CLI** — スクリプト可能で CI にやさしい。

**REST API** と **MCP**（AI エージェントプロトコル）が、自動化とツール連携を締めくくります。コマンドと API の完全なリファレンスは [openship.io/docs](https://openship.io/docs) にあります。

> [!NOTE]
> ドキュメントはまだ作成中です — 現在積極的に拡充しています。不足や不明点があれば、[コントリビューション](../../CONTRIBUTING.md)を大歓迎します。完成が早まります。

---

## ステータス

本番運用可能なコア、活発に開発中。

**今後の予定：** マルチノードクラスター、ロードバランシング UI、プライベートネットワーク、高度な監視、ビジュアル CI/CD パイプライン。

---

## コントリビューション

[CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

---

## ライセンス

Openship は **オープンソース** ソフトウェアで、[Apache License 2.0](../../LICENSE) の下でライセンスされています。

Apache 2.0 ライセンスの条件の下で、商用・クローズドソース製品を含め、使用・実行・改変・セルフホスト・配布ができます。全文は [LICENSE](../../LICENSE) を参照してください。
