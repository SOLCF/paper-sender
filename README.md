# Paper送信

スマホのスクショを M5PaperS3 に Bluetooth で送る Web アプリ（Android の Chrome 用）。
受け側のファームウェアは別リポジトリではなくローカルの m5paper-calendar。

- 画像は 540x960・16階調グレー（または白黒）にして PackBits 圧縮で送る
- ホーム画面に追加すると、スクショの「共有」からこのアプリを選べる
- 画像はスマホの中だけで処理し、どこにもアップロードしない

更新するときは app.js の VERSION と sw.js の CACHE を一緒に上げる。
