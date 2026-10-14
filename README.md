# Snore Tracker MVP

スマホのマイクを使い、端末内だけで「いびき候補」を簡易推定する静的Webアプリです。
外部API・サーバー・アカウント登録は不要です。

## できること

- マイク入力をリアルタイム解析
- 70〜500Hz付近の低周波成分 + 音量から「いびき候補」を推定
- イベント回数 / 推定時間 / 強いいびき回数を集計
- 夜間タイムライン表示
- 感度調整
- 直近30回を端末の localStorage に保存
- CSV / JSON 出力
- PWA対応（ホーム画面へ追加可能）
- 音声そのものは保存・送信しない

## ローカルで使う

`file://` 直開きではブラウザのマイク制限に引っかかる場合があります。localhost で起動してください。

### Python がある場合

```bash
python -m http.server 8080
```

ブラウザで `http://localhost:8080` を開きます。

### Node.js がある場合

```bash
npx serve .
```

## GitHub Pages で公開

1. GitHub → Settings → Pages
2. Build and deployment → Deploy from a branch
3. Branchを `main` / `(root)` にして保存
4. 発行された `https://<user>.github.io/<repo>/` をAndroid Chromeで開く
5. マイク権限を許可
6. Chromeメニュー → 「ホーム画面に追加」または「アプリをインストール」

GitHub PagesはHTTPSなのでマイクAPIを利用できます。

## 大事な制限

ブラウザ版はAndroidで画面を完全に消したり、OSがブラウザを強くバックグラウンド化すると処理が止まる可能性があります。
一晩中確実に測る用途まで進めるなら、次段階はAndroidネイティブアプリ化（Foreground Service）が適しています。

また、本アプリは医療機器ではありません。睡眠時無呼吸症候群などの診断には使用できません。
