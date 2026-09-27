# DDInter 官方成分頁補充快照

`missing-ingredients-2026-09-27.json` 保存 2026-09-27 取得的 44 份官方圖資料回應，用於補足本機下載集合缺少的成分與配對。它是選取的固定快照，不是 DDInter 全資料庫，也不保證最新或完整。

資料作者：**Computational Biology & Drug Design Group — DDInter 2.0**。來源為 [官方成分目錄](https://ddinter2.scbdd.com/server/drug/)；每份快照另存成分頁、圖資料網址、取得時間、原始回應與 SHA-256。

資料與本檔案的整理採 **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**，依 [DDInter 資料條款](https://ddinter2.scbdd.com/terms/)。本專案僅選取、封裝來源回應及新增來源欄位，未改寫原始回應、配對等級或機轉分類。此授權僅描述這份資料，不能套用為其他程式碼、圖片或模型的授權，也不表示 DDInter 認可本專案。

- 新下載專案：`npm run data:install` 核對基本資料包後，在暫存資料庫補入，再一次發布至 `data/`。
- 既有專案或手動解壓縮者：`npm run data:apply-reviewed`，先備份藥品庫，再完全離線補入。沿用 `.env` 的 `DRUG_DB_PATH`。
- 整包固定 SHA-256：`e9ea056b6330b4e286e3fab012156a8d57d780145fc615f7beb8584a5f66bd45`。
- 同一成分已有網站快照時一律保留，包括不同版本；重複執行不刷新取得日期。需更新既有快照時，沿用另外的 `data:enrich-ddinter-web` 工具。

補充資料不是醫療判定。零筆、查無紀錄與尚未對照都不表示沒有交互作用；本資料不能單獨判斷個人的年齡、劑型、途徑或劑量風險。詳細範圍與驗證見 [本機成分對照](../../docs/本機成分對照.md)。
