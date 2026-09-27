# GitHub 下載與首次啟動

公開專案：[xiaom5704-eng/-](https://github.com/xiaom5704-eng/-)。GitHub 存放原始碼；要操作網頁，需在自己的電腦啟動專案。下載不需要 Gemini 金鑰。

## 1. 取得原始碼

安裝 Node.js 24 後，在終端機執行：

```bash
git clone https://github.com/xiaom5704-eng/-.git medicine-app
cd medicine-app
npm ci
```

沒有 Git 也可以選 **Code → Download ZIP**，解壓縮後在含有 `package.json` 的資料夾開啟終端機，執行 `npm ci`。`node_modules` 依鎖檔安裝，不包含在下載包內。

## 2. 安裝公開參考資料包

從 [Releases](https://github.com/xiaom5704-eng/-/releases) 下載 `medsafe-public-data-2026-09-27.zip`。這是首次安裝用的固定快照，並非最新資料保證。

**僅在新下載、尚未建立 `data` 資料夾的專案使用以下步驟。既有使用者請保留原資料，勿直接覆蓋。** Windows PowerShell 在專案根目錄執行（修改 ZIP 路徑）：

```powershell
if (Test-Path -LiteralPath './data') { throw 'data 已存在，請改用新的專案資料夾。' }
Expand-Archive -LiteralPath 'C:/Downloads/medsafe-public-data-2026-09-27.zip' -DestinationPath '.'
```

亦可用解壓縮工具，把 ZIP 內的 `data` 資料夾放在 `package.json` 旁邊：

```text
medicine-app/
  package.json
  data/
    drugs.db
    manifest.json
    sources/
    vision/
      index.db
      images/
      models/
```

Release 的 `SHA256SUMS.txt` 提供 ZIP 雜湊；PowerShell 可執行 `Get-FileHash -Algorithm SHA256 -LiteralPath 'ZIP檔路徑'` 比對。`data/manifest.json` 另保留包內原始檔案的 SHA-256；首次啟動後資料庫可能正常更新，因此應在啟動前核對。

資料包包含：

- TFDA 藥品主檔與外觀資料、DDInter 配對及已核對的成分對照。
- 已建立的藥錠圖片索引、公開參考圖、DINOv2 模型與來源授權文件。
- 五款比賽案例藥物的本機仿單副本及已整理的來源紀錄；保留各自版本與取得日期。

不包含金鑰、聊天紀錄、私人照片、藥盒照片圖庫或研究用訓練資料。資料來源及使用條件見 [drug-data.md](drug-data.md)、[vision.md](vision.md)；DDInter 部分遵守 **CC BY-NC-SA 4.0**，不得把整份資料包視為可任意商用。來源資料與模型各自保留原授權。

若不下載資料包，可執行 `npm run data:sync` 取得基本主檔與交互作用 CSV；外觀、圖片模型／索引、補充成分與仿單需依 [README](../README.md) 的各步驟另行準備。`data:sync` 本身不會重建完整展示快照。

## 3. 啟動與操作

```bash
npm run dev
```

開啟终端機顯示的網址，預設為 `http://localhost:3000`。第一次會下載並校驗 OCR 模型，需保留網路連線；後續使用本機模型。若埠被占用，可在 `.env` 設定 `PORT=3100`，或使用其他空閒埠。

1. 進入「藥物辨識」，搜尋 `KBT` 或藥品名稱，核對候選與參考圖。
2. 按「一鍵載入 1 個月案例」，查看五款藥品、來源、年齡提醒與仿單；可切換其他年齡比較。
3. 上傳藥袋／藥盒照片用 OCR 讀字，或使用藥錠照片比對。結果是待人工核對的候選，不保證每張照片都能找到正確品項。

本機查藥、OCR、照片候選與展示案例不用 Gemini／Ollama。要使用自由問答，才需設定 Gemini 或安裝並啟動 Ollama。藥盒圖片比對需先自行收錄有權使用的圖片；初始圖庫為空。

## 4. 修改與檢查

```bash
npm run lint
npm test
npm run build
npm run runtime:check
```

最後一項需先安装上述完整資料與完成建置，驗證正式服務、本機搜尋及圖片路徑。修改 React 介面主要看 `src/`，Express API 看 `server/`，共用型別與規則看 `shared/`。

目前先提供可開發的網頁版原始碼與參考資料。Windows 安裝包的內容完整性已檢查，但原生啟動尚未通過，故此次不將安裝包作為可用版本發布。照片辨識仍有漏查，資料庫也不是完整處方審核系統。
