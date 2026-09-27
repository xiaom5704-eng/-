import { caseProducts, infantDemo } from '../../shared/medication-safety';

export default function MedicationDemo({ disabled, selectedCount, onLoad }: { disabled: boolean; selectedCount: number; onLoad: () => void }) {
  return <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-5 sm:p-6" aria-label="比賽展示案例">
    <p className="text-xs font-semibold text-sky-800">比賽展示 · 全程本機分析</p>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-4"><div><h3 className="text-lg font-bold text-slate-900">同一張藥單，年齡不同，核對重點也不同</h3>
      <p className="mt-2 text-sm text-slate-600">Noscapine、Somin、Cypromin、K.B.T、Fencaine</p></div>
      <button type="button" disabled={disabled} onClick={onLoad} className="rounded-xl bg-sky-800 px-4 py-3 text-sm font-semibold text-white hover:bg-sky-900 disabled:opacity-50">一鍵載入 1 個月案例</button>
    </div>
    <p className="mt-3 text-xs leading-relaxed text-slate-600">{selectedCount ? '載入會替換目前查詢清單與分析結果；上傳照片保留。' : '不需要 Gemini 或 Ollama。載入示範品項後，可改年齡重新核對。'}</p>
    <details className="mt-3 text-sm text-slate-600"><summary className="cursor-pointer">展示品項如何選定？</summary>
      <p className="mt-3 leading-relaxed">{infantDemo.description}</p>
      <ul className="mt-3 space-y-2">{caseProducts.map(spec => <li key={spec.id}><strong>{spec.articleName}</strong> · {spec.choice}<span className="block text-xs mt-1">{spec.id}</span></li>)}</ul>
      <p className="mt-3 text-xs">{infantDemo.notes[0]}</p>
      <a href={infantDemo.sourceUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs underline text-sky-800">查看提供的參考圖片資料夾</a>
    </details>
  </section>;
}
