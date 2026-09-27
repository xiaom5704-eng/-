import type { DrugCandidate } from '../../shared/medication';
import type { VisionResult } from '../../shared/medication-vision';
import DrugAppearanceDetails from './DrugAppearanceDetails';
import PackageReferenceImages from './PackageReferenceImages';

const imprintText = { match: '刻字完全相符，仍需核對規格', different: '刻字未完全相符，請再核對', missing: '來源缺少刻字，無法核對', not_given: '' };
const basisText = { image: '照片相似', imprint: '刻字相符・照片未確認', image_and_imprint: '照片相似＋刻字相符' };
export default function VisionResults({ result, disabled, onReview, onOcr, onLabelOcr, onPackage, onImprintSearch }: {
  result: VisionResult; disabled: boolean; onReview: (drug: DrugCandidate) => void; onOcr: () => void; onLabelOcr: () => void; onPackage: () => void; onImprintSearch: (input: string) => void;
}) {
  const packaging = result.status.kind === 'package';
  return <section className="mt-5 space-y-4" aria-label="影像比對候選">
    <div className="rounded-xl bg-emerald-50 p-4">
      <h4 className="font-bold text-slate-900">{result.outcome === 'review' ? `找到 ${result.candidates.length} 個待核對候選` : '目前無法從照片找到足夠相似的候選'}</h4>
      <p className="mt-2 text-sm text-slate-700">{packaging ? '請對照參考藥盒上的完整品名、規格與許可證。尚未收錄、改版或外觀相近的藥盒，可用 OCR 讀文字協助核對。' : result.outcome === 'review' ? '請一起核對正反面、刻字與規格，再查看品項資料。' : '這次比對的是藥錠圖庫。若拍的是藥盒，可改用藥盒圖庫；藥袋則可讀取文字，不需要重新上傳。'}</p>
      {!packaging && <button type="button" disabled={disabled} onClick={onPackage} className="mt-3 mr-2 rounded-lg bg-emerald-700 px-3 py-2 text-sm text-white disabled:opacity-50">這是藥盒，改用藥盒比對</button>}
      <button type="button" disabled={disabled} onClick={onLabelOcr} className="mt-3 mr-2 rounded-lg border border-emerald-700 bg-white px-3 py-2 text-sm text-emerald-800 disabled:opacity-50">{packaging ? '用 OCR 讀藥盒文字輔助核對' : '這是藥盒／藥袋，讀取藥名'}</button>
      {!packaging && <button type="button" disabled={disabled} onClick={onOcr} className="mt-3 rounded-lg border border-emerald-700 bg-white px-3 py-2 text-sm text-emerald-800 disabled:opacity-50">用 OCR 輔助讀取這些照片的刻字</button>}
      {result.imprintSearch && <div className="mt-3 rounded-lg border border-emerald-200 bg-white p-3 text-sm text-slate-700">
        <p>已另外查詢完整刻字「{result.imprintSearch.input}」：符合 {result.imprintSearch.total} 個藥錠品項，本頁列出 {result.imprintSearch.shown} 個。刻字依本次填入的文字查詢，請對照照片核對。</p>
        {result.imprintSearch.total > result.imprintSearch.shown && <button type="button" disabled={disabled} onClick={() => onImprintSearch(result.imprintSearch!.input)} className="mt-2 text-emerald-800 underline disabled:opacity-50">以此刻字展開完整本機搜尋</button>}
      </div>}
    </div>
    <div className="grid gap-4 lg:grid-cols-2">{result.candidates.map((item, index) => <article key={item.drug.id} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500">候選 {index + 1} · 尚未確認</p>
      <p className={`mt-2 text-xs font-semibold ${item.matchedBy === 'imprint' ? 'text-amber-800' : 'text-emerald-800'}`}>{basisText[item.matchedBy]}</p>
      <h5 className="mt-1 font-semibold break-words">{item.drug.name}</h5>
      <p className="mt-1 text-xs text-slate-500 break-words">{item.drug.id} · {item.drug.dosageForm}</p>
      {item.drug.licenseStatus && <p className="mt-1 text-xs text-slate-600">許可證狀態：{item.drug.licenseStatus}</p>}
      {item.imprint !== 'not_given' && <p className={`mt-2 text-sm ${item.imprint === 'match' ? 'text-emerald-800' : 'text-amber-800'}`}>{imprintText[item.imprint]}</p>}
      {packaging ? <PackageReferenceImages images={item.images} name={item.drug.name} /> : item.drug.appearance && <DrugAppearanceDetails appearance={item.drug.appearance} drugName={item.drug.name} licenseId={item.drug.id} />}
      {!packaging && item.images.some(image => image.provenance === 'personal') && <PackageReferenceImages images={item.images.filter(image => image.provenance === 'personal')} name={item.drug.name} kind="pill" />}
      <button type="button" disabled={disabled} onClick={() => onReview(item.drug)} className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50">查看此候選的品項資料</button>
      <details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer">比對依據</summary>
        <p className="mt-2">{item.similarity === null ? '此品項沒有可用的圖片特徵，未進行照片比對。' : `影像相似度 ${item.similarity.toFixed(3)}（不是正確率）。${item.matchedBy === 'imprint' ? '本次照片未全數達到圖片比對門檻。' : '本次照片均通過圖片檢索門檻，仍需人工核對。'}`}</p>
        {item.matchedBy !== 'image' && <p className="mt-2">您填寫的完整刻字與本機外觀資料其中一面相符；可能有其他同刻字品項，不能據此確定藥名。</p>}
      </details>
    </article>)}</div>
    <div className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">{result.warnings.map(warning => <p key={warning}>{warning}</p>)}</div>
    <details className="text-xs leading-relaxed text-slate-500"><summary className="cursor-pointer">圖片庫與模型來源</summary>
      <p className="mt-2">本次可用：{result.status.drugCount.toLocaleString()} 種藥品、{result.status.imageCount.toLocaleString()} 張圖。來源版本：{result.status.sourceVersion}。{result.status.model}。</p>
      {!!result.status.personalImageCount && <p>其中 {result.status.personalImageCount} 張是使用者核對後收錄的本機照片，來源列於圖片下方，並非 TFDA 官方照片。</p>}
      {packaging ? <p>藥盒來源包含自行收錄照片及已保存的 TFDA 外盒／標籤圖，逐張列於圖片下方。官方來源可用圖片 {result.status.officialPackageImageCount || 0} 張；不代表官方完整圖片庫或實拍辨識率。圖片可能是平面標籤、不同視角或舊包裝，授權依個別來源。</p> : <><p>衛生福利部食品藥物管理署藥品外觀資料集，依政府資料開放授權條款第 1 版利用；原圖轉為 WebP，透過 Pill Detective TW 鏡像取得並核對。</p>
      <p className="mt-1 flex flex-wrap gap-3"><a href="https://data.gov.tw/dataset/9120" target="_blank" rel="noreferrer" className="underline">TFDA 資料</a><a href="https://data.gov.tw/license" target="_blank" rel="noreferrer" className="underline">資料授權</a><a href="https://github.com/liangRXdev/pill-detective-tw" target="_blank" rel="noreferrer" className="underline">圖片鏡像</a><a href="https://github.com/facebookresearch/dinov2" target="_blank" rel="noreferrer" className="underline">DINOv2 模型</a></p></>}
    </details>
  </section>;
}
