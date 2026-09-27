# TFDA 仿單與外盒索引快照

`labels-2026-09-27.zip` 是食藥署原始 JSON ZIP，未修改檔案內容，包含 29,875 個許可證品項的品名與公開文件連結，不含患者資料、圖片或 PDF 全文。

- 提供機關：衛生福利部食品藥物管理署。
- 資料集：[藥品仿單或外盒資料集（9117）](https://data.gov.tw/dataset/9117)。
- 原始下載：[TFDA JSON ZIP](https://data.fda.gov.tw/data/opendata/export/39/json)。
- 取得時間：2026-09-27T14:49:31.588Z；並非來源修訂日期。
- 原始大小：2,524,780 bytes；解壓 JSON 為 11,731,501 bytes。
- SHA-256：`9203264e2a06ef872532aa33d44ce83ebcac1eed1ca49542d5826d903771ebe7`。
- 授權：[政府資料開放授權條款第 1 版](https://data.gov.tw/license)。保留來源標示，不代表提供機關對本專案背書。

程式固定校驗此 ZIP，首次 `data:install` 會在基本資料校驗後、正式目錄發布前匯入。既有資料可執行 `npm run data:import-labels`，先備份並僅補缺少的索引，不覆寫已有版本。詳細範圍、更新與連結限制見 [本機仿單索引](../../docs/本機仿單索引.md)。
