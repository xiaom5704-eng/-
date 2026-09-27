import { useState } from 'react';
import { BookOpen, ClipboardList } from 'lucide-react';
import type { MedicationReport } from '../../shared/medication';
import MedicationInteractions from './MedicationInteractions';
import MedicationLeaflets from './MedicationLeaflets';
import MedicationSafety from './MedicationSafety';

export default function MedicationResults({ report, onPackageChange }: { report: MedicationReport; onPackageChange?: () => void }) {
  const [view, setView] = useState<'interactions' | 'labels'>('interactions');
  return <div className="space-y-5">
    {report.demo && <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950"><p className="font-bold">教學示範 · {report.demo.title}</p><p className="mt-2 leading-relaxed">{report.demo.description}</p><details className="mt-2 text-xs"><summary className="cursor-pointer">案例假設與展示範圍</summary><ul className="mt-2 list-disc pl-4 space-y-2">{report.demo.notes.map(note => <li key={note}>{note}</li>)}</ul></details></div>}
    {report.safety && <MedicationSafety safety={report.safety} />}
    <nav aria-label="查看查詢結果" className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-100 p-1.5">
      <button type="button" aria-pressed={view === 'interactions'} onClick={() => setView('interactions')} className={`flex items-center justify-center gap-2 rounded-xl px-2 py-3.5 text-sm font-semibold transition ${view === 'interactions' ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><ClipboardList size={18} aria-hidden="true" />用藥提醒</button>
      <button type="button" aria-pressed={view === 'labels'} onClick={() => setView('labels')} className={`flex items-center justify-center gap-2 rounded-xl px-2 py-3.5 text-sm font-semibold transition ${view === 'labels' ? 'bg-white text-emerald-800 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}><BookOpen size={18} aria-hidden="true" />藥品說明書</button>
    </nav>
    {view === 'interactions' ? <MedicationInteractions report={report} /> : <MedicationLeaflets report={report} onPackageChange={onPackageChange} />}
    <p className="text-sm text-slate-600 leading-relaxed">查詢結果供核對參考，不能直接判定能否一起吃，也不提供個人化劑量。</p>
    <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
      <summary className="cursor-pointer font-medium">查詢範圍與資料限制</summary>
      <ul className="list-disc pl-4 space-y-2 mt-3 leading-relaxed">{report.limitations.map(line => <li key={line}>{line}</li>)}</ul>
    </details>
  </div>;
}
