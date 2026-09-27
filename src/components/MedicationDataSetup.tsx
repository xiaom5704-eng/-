import type { LocalDataSetup } from '../../shared/local-data';
import { datasetNames, type DatasetStatus } from '../../shared/medication';

const guide = 'https://github.com/xiaom5704-eng/-/blob/main/docs/GitHub%E4%B8%8B%E8%BC%89%E8%88%87%E5%95%9F%E5%8B%95.md';

export default function MedicationDataSetup({ datasets, setup }: { datasets: DatasetStatus[]; setup?: LocalDataSetup }) {
  const missing = datasets.filter(item => !item.count);
  if (!missing.length && setup?.storage !== 'temporary') return null;
  const installable = setup?.installation === 'available';
  const restart = setup?.installation === 'restart_required';
  const custom = setup?.installation === 'custom_paths';
  return <section aria-label="準備本機資料" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 space-y-3">
    <h3 className="font-semibold">{restart ? '已偵測到資料檔，請重新啟動專案' : '準備本機資料'}</h3>
    <p>{restart ? '目前服務仍使用啟動時的暫存空資料，重新整理網頁還不會載入新檔案。' :
      `尚未載入：${missing.map(item => datasetNames[item.source]).join('、')}。缺少資料時查不到候選，不能當作資料庫沒有這種藥。`}</p>
    {installable ? <>
      <p>在 VS Code 的專案終端機按 Ctrl+C 停止服務，再依序執行：</p>
      <pre className="overflow-x-auto rounded-lg bg-white p-3 text-xs leading-6"><code>{'npm run data:install\nnpm run dev'}</code></pre>
      <p>首次安裝約 160 MB 的公開資料包，包含藥品、交互作用、參考圖片與圖片模型；不需要 Gemini 金鑰。安裝完成並重啟後，重新整理此頁。</p>
    </> : restart ? <>
      <p>在啟動服務的 VS Code 終端機按 Ctrl+C，再執行 <code>npm run dev</code>，然後重新整理此頁。</p>
      <p>重啟後會檢查實際載入的資料；偵測到檔案不等於資料完整。</p>
    </> : <>
      <p>{custom ? '目前使用自訂資料路徑。請核對專案 .env 的 DRUG_DB_PATH 與 VISION_DATA_DIR，將既有資料放至設定位置後重啟。' :
        'data 資料夾已存在，首次資料包安裝不會覆蓋它。請保留原資料，停止服務後補入缺少的來源，再重新啟動。'}</p>
      {!custom && <ul className="list-disc space-y-2 pl-5 break-words">
        {missing.some(item => item.source === 'tfda' || item.source === 'ddinter') && <li>基本藥名與交互作用：<code>npm run data:sync</code>（連線下載）</li>}
        {missing.some(item => item.source === 'tfda_appearance') && <li>外觀 CSV：<code>npm run data:import-appearance -- "CSV 或 ZIP 路徑"</code></li>}
        {missing.some(item => item.source === 'tfda_labels') && <li>仿單／外盒索引：<code>npm run data:import-labels</code>（使用隨附資料）</li>}
      </ul>}
    </>}
    <a href={guide} target="_blank" rel="noreferrer" className="inline-block underline underline-offset-2">完整安裝步驟與 ZIP 離線安裝說明</a>
  </section>;
}
