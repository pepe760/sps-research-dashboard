# XSP SPS · 自動開倉核對台

[公開網頁](https://pepe760.github.io/sps-research-dashboard/#quote-candidates)只讀資料。開啟網站即自動查詢，毋須貼期權鏈、輸入報價或上傳檔案。

XSP 組合按設定嘅規則核對：下一個實際正常美國交易日 PM 到期、短 put delta 最接近 −0.10、保護腿低 15 點。程式於 09:45 ET 記錄選腿，10:45 ET 起自動更新同一組腿嘅 bid／ask、參考淨收金及最大到期虧損。計算使用標準 $100 每點乘數；$2.80 係模型費用預留。報價有時間標示，暫時攞唔到合資格數據就顯示原因。

## 一次設定

- [行程同資料接口](LIVE_DASHBOARD.md)
- [Massive 自動收集器部署](deploy/README.md)
- [供應商及公開授權要求](RELEASE_PUB_LIVE.md)
- [資料格式與檢查](FEED_SCHEMA.md)

網頁自動查詢已完成設定嘅 HTTPS 服務。供應商密鑰只喺服務機使用，GitHub Pages 只讀公開結果。GitHub 定時發布狀態檔並更新經濟日曆，唔負責擷取 09:45 ET 即時盤口。若收集器錯過指定時段，唔會以其後 delta 補成當時記錄。

## Local checks

```sh
python -m unittest discover -s scripts/tests
python scripts/refresh.py
python -m http.server 8000 --directory site
```
