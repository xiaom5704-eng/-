# GitHub 下載與首次啟動

目前 `data:install` 也會補入隨原始碼提供的 TFDA 仿單／外盒連結索引（29,875 個品項）。手動解壓縮或既有資料庫使用者可執行 `npm run data:import-labels`；先備份、離線補缺，不覆寫既有索引。已保存的六份仿單可離線查看，其餘文件入口需網路。詳見[本機仿單索引](本機仿單索引.md)。

公開專案：[xiaom5704-eng/-](https://github.com/xiaom5704-eng/-)。GitHub 存放原始碼；要操作網頁，需在自己的電腦啟動專案。下載不需要 Gemini 金鑰。

## 1. 取得原始碼

安裝 Node.js 24 後，在終端機執行：

```bash
git clone https://github.com/xiaom5704-eng/-.git medicine-app
cd medicine-app
npm ci
```

沒有 Git 也可以選 **Code → Download ZIP**，解壓縮後在含有 `package.json` 的資料夾開啟終端機，執行 `npm ci`。`node_modules` 依鎖檔安裝，不包含在下載包內。

根目錄只安裝網頁套件，不下載 Electron。選用桌面工具有獨立的 `electron/package-lock.json`，需要時才執行 `npm run electron:setup`；一般 VS Code 操作不需要這一步。更新原始碼後請停止正在執行的服務，再重新執行 `npm ci`，避免 Windows 原生套件被使用中的程序占用。

## 2. 安裝公開參考資料包

新下載的 main 分支原始碼可直接執行：

```bash
npm run data:install
```

指令會下載下述固定快照，核對 ZIP 的 SHA-256 及清單內的每一個檔案，再於暫存資料庫補入原始碼隨附的 44 份已核對 DDInter 快照，全部通過後才放入 `data/`。中斷、損毀或補入衝突不會留下半套正式資料；既有 `data/`（包含空資料夾）會明確拒絕覆蓋。自訂 `DRUG_DB_PATH`／`VISION_DATA_DIR` 時也不安裝到錯誤位置。這是首次安裝，不是更新既有資料。

下載採每段 4 MiB、最多三段同時進行，每段最多等待三分鐘並嘗試三次。慢速但持續前進的下載不再受整包十分鐘限制；終端機約每五秒更新進度。斷線、逾時或按 Ctrl+C 後，完整分段會保留在專案的 `.data-download-` 開頭資料夾，重新執行相同指令即可核對並續傳，不必重抓已完成部分。分段快取不是正式資料，仍須通過整包固定 SHA-256 及逐檔核對才會安裝。

下載快取也會在安裝成功後保留，約占 310 MB；可在確認 `data/` 安裝成功後自行刪除該 `.data-download-` 資料夾來釋放空間，不影響已安裝資料。快取及安裝暫存均不納入 Git。不要在下載進行中刪除快取。

如果手邊已有 ZIP，也可執行 `npm run data:install -- --file="資料包 ZIP 路徑"`，沿用相同完整性檢查且不連外。網路無法取得資料包時，可先用瀏覽器下載，再指定本機 ZIP 安裝。舊版原始碼沒有此指令時，可使用下述手動步驟。

從 [2026-09-28 資料版](https://github.com/xiaom5704-eng/-/releases/tag/local-web-2026-09-28) 下載 `medsafe-public-data-2026-09-28.zip`（309,353,366 bytes，約 310 MB）。這是首次安裝用的固定快照，並非最新資料保證。已下載 2026-09-27 舊 ZIP 仍可用 `--file` 安裝，會提示其不含後續補圖及新增仿單；線上下載則只接受目前指定版本。

**僅在新下載、尚未建立 `data` 資料夾的專案使用以下步驟。既有使用者請保留原資料，勿直接覆蓋。** Windows PowerShell 在專案根目錄執行（修改 ZIP 路徑）：

```powershell
if (Test-Path -LiteralPath './data') { throw 'data 已存在，請改用新的專案資料夾。' }
Expand-Archive -LiteralPath 'C:/Downloads/medsafe-public-data-2026-09-28.zip' -DestinationPath '.'
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

Release 的 `SHA256SUMS.txt` 提供 ZIP 雜湊；PowerShell 可執行 `Get-FileHash -Algorithm SHA256 -LiteralPath 'ZIP檔路徑'` 比對。`data/manifest.json` 另保留基本快照原始檔案的 SHA-256。自動安裝會在補入前核對；補入及啟動後資料庫會正常改變，不應再以原始資料庫雜湊判斷損毀。

手動解壓縮或已有資料的使用者，更新 main 原始碼後可執行 `npm run data:apply-reviewed`，先備份藥品資料庫，再離線補入這 44 份快照。既有同成分快照保留，重複執行不覆蓋版本或日期。此指令不用金鑰，也不會建立缺少基本資料的空資料庫；來源授權見 [補充資料說明](../resources/ddinter/README.md)。

資料包包含：

- TFDA 藥品主檔與外觀資料、DDInter 配對及已核對的成分對照。
- 已建立的藥錠圖片索引（6,146 張可用／5,791 品項）、公開參考圖、378 筆官方清晰圖紀錄、DINOv2 模型與來源授權文件。
- 五款比賽案例及普拿疼伏冒加強錠的六份本機仿單副本，另含 29,875 品項的官方仿單／外盒連結索引；保留各自版本與取得日期。連結索引不等於已保存所有文件。

不包含金鑰、聊天紀錄、私人照片、藥盒照片圖庫或研究用訓練資料。資料來源及使用條件見 [drug-data.md](drug-data.md)、[vision.md](vision.md)；DDInter 部分遵守 **CC BY-NC-SA 4.0**，不得把整份資料包視為可任意商用。來源資料與模型各自保留原授權。

若不下載資料包，可執行 `npm run data:sync` 取得基本主檔與交互作用 CSV；外觀、圖片模型／索引、補充成分與仿單需依 [README](../README.md) 的各步驟另行準備。`data:sync` 本身不會重建完整展示快照。

## 3. 啟動與操作

```bash
npm run dev
```

在 VS Code 開啟含 `package.json` 的資料夾，在「終端機 → 新增終端機」執行啟動指令。開啟終端機顯示的網址，預設為 `http://localhost:3000`。第一次會下載並校驗 OCR 模型，需保留網路連線；後續使用本機模型。若埠被占用，可在 `.env` 設定 `PORT=3100`，或使用其他空閒埠。

1. 進入「藥物辨識」，搜尋 `KBT` 或藥品名稱，核對候選與參考圖。
2. 按「一鍵載入 1 個月案例」，查看五款藥品、來源、年齡提醒與仿單；可切換其他年齡比較。
3. 上傳藥袋／藥盒照片用 OCR 讀字，或使用藥錠照片比對。結果是待人工核對的候選，不保證每張照片都能找到正確品項。

本機查藥、OCR、照片候選與展示案例不用 Gemini／Ollama。要使用自由問答，才需設定 Gemini 或安裝並啟動 Ollama。藥盒圖庫初始為空；切到「藥盒照片比對」後，可按「下載示範外盒」準備普拿疼與斯斯兩款官方參考，下載後在本機比對。其他品項仍需取得可用來源並核對收錄；詳見[示範外盒](本機仿單索引.md#下載示範外盒)。

聊天與症狀頁只使用上方選定引擎，手機寬度也可切換。展開「連線狀態與使用方式」可重新檢查 Ollama；「模型未安裝」與「服務連不上」會分開說明。若已安裝其他模型，在 VS Code 終端機執行 `ollama list`，把完整名稱填入 `.env` 的 `OLLAMA_MODEL`，再重啟專案即可。

選擇 Gemini 時，可在「配置金鑰」輸入後按「測試並啟用 Gemini」。介面金鑰僅保留本次頁面，重新整理後清除；關閉未完成的測試會停止等待，不會在稍後切換引擎。AI 失敗不自動改用另一服務；原問題可直接重試，不用再輸入一次。

## 4. 修改與檢查

### 先開網頁，才發現沒有資料

新版在藥品資料庫不存在時使用暫存空資料，不會建立空的 `data/drugs.db` 阻擋首次安裝。網頁的「藥物辨識 → 準備本機資料」會提供下一步；對話仍保存於原本的對話資料庫。此時搜尋會明示資料尚未安裝，不以零筆候選表示查無藥品。

- **尚無 data 資料夾**：停止服務，執行 `npm run data:install`（或上述 `--file` 離線安裝），再執行 `npm run dev`。不用重新下載整個專案。
- **安裝完仍顯示沒有資料**：按「重新讀取資料狀態」可看到是否需要重啟；在服務終端機按 Ctrl+C 後重新執行 `npm run dev`，再重新整理網頁。只有重新整理網頁不會讓舊服務改開新資料庫。
- **data 已存在但部分來源缺少**：保留既有資料。基本主檔與交互作用用 `npm run data:sync`；外觀 ZIP 用 `npm run data:import-appearance -- "ZIP 路徑"`；仿單／外盒索引用 `npm run data:import-labels`。基本同步不包含圖片模型與完整圖庫，詳細準備步驟見 [README](../README.md)。
- **使用自訂資料路徑**：核對 `.env` 的 `DRUG_DB_PATH` 與 `VISION_DATA_DIR`，沿用原匯入流程；首次安裝器仍不覆蓋既有資料。

### 程式檢查

```bash
npm run lint
npm test
npm run build
npm run runtime:check
```

最後一項需先安裝上述完整資料與完成建置，驗證正式服務、本機搜尋及圖片路徑。修改 React 介面主要看 `src/`，Express API 看 `server/`，共用型別與規則看 `shared/`。

前端程式仍支援 Vite 即時更新；修改說明文件、資料工具或本機資料不會觸發整頁重載，避免清掉正在辨識的照片。修改後端程式後，請停止並重新執行 `npm run dev`。

專案以本機網頁為使用目標，不需要桌面安裝程式；既有 Electron 實驗保留供參考。照片辨識仍有漏查，資料庫也不是完整處方審核系統。
