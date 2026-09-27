import { CircleHelp, Copy, Info } from 'lucide-react';
import type { MedicationReport } from '../../shared/medication';
import { interactionLevelText, interactionStatusText } from '../../shared/medication';
import { ingredientName, interactionGroups, type InteractionGroup } from '../../shared/medication-view';
import { interactionDetailScope, type InteractionDetail } from '../../shared/interaction-detail';
import { mechanismDefinitions, mechanismDefinitionUrl, mechanismScope, type InteractionMechanism } from '../../shared/interaction-mechanism';

function MechanismSource({ mechanism: m }: { mechanism: InteractionMechanism }) {
  return <div className="mt-3 rounded-xl bg-white/60 p-3 text-xs leading-relaxed space-y-2">
    <p className="font-semibold">官方機轉分類：{m.types.map(type => `${mechanismDefinitions[type].label}（${type}）`).join('、')}</p>
    <p><a href={m.sourceUrl} target="_blank" rel="noreferrer" className="underline">機轉分類來源</a> · <a href={m.dataUrl} target="_blank" rel="noreferrer" className="underline">原始圖資料</a><br />取得時間：{m.retrievedAt}</p>
    <p>中文為專案依 <a href={mechanismDefinitionUrl} target="_blank" rel="noreferrer" className="underline">DDInter 分類定義</a> 整理的一般詞義說明。{mechanismScope}</p>
    <details><summary className="cursor-pointer">機轉來源版本</summary><p className="break-all mt-2">原始快照 SHA256：{m.sha256}</p></details>
  </div>;
}

function DetailSource({ detail }: { detail: InteractionDetail }) {
  return <div className="mt-3 space-y-3 text-sm leading-relaxed">
    <p><a href={detail.sourceUrl} target="_blank" rel="noreferrer" className="underline">DDInter 配對說明</a> · 已保存於本機<br />取得時間：{detail.retrievedAt}</p>
    {detail.summary && <p>中文簡述為專案依來源整理，整理日期：{detail.summary.reviewedAt}。</p>}
    <details>
      <summary className="cursor-pointer underline underline-offset-4">閱讀已保存的來源原文</summary>
      <div className="mt-3 space-y-3">
        <p className="font-semibold">Interaction（交互作用原文）</p><p lang="en">{detail.interaction}</p>
        <p className="font-semibold">Management（處置原文，供專業核對）</p><p lang="en">{detail.management}</p>
        {!!detail.references.length && <details><summary className="cursor-pointer">來源頁列出的 {detail.references.length} 篇參考文獻（未逐篇查核）</summary><ul className="mt-2 space-y-2" lang="en">{detail.references.map((reference, i) => <li key={i}>{reference}</li>)}</ul></details>}
        <details className="text-xs"><summary className="cursor-pointer">版本校驗資料</summary><p className="break-all mt-2">來源內容 SHA256：{detail.contentSha256}<br />原始頁面 SHA256：{detail.sha256}</p></details>
      </div>
    </details>
  </div>;
}

function Finding({ group }: { group: InteractionGroup }) {
  const details = [...new Map(group.pairs.flatMap(pair => pair.detail ? [[pair.detail.id, pair.detail] as const] : [])).values()];
  const mechanisms = [...new Map(group.pairs.flatMap(pair => pair.mechanism ? [[`${pair.mechanism.sourceUrl}:${pair.mechanism.sha256}`, pair.mechanism] as const] : [])).values()];
  const types = [...new Set(mechanisms.flatMap(mechanism => mechanism.types))];
  const level = group.level === 'Unknown' || !group.level ? '風險程度未明' : `${interactionLevelText[group.level] || group.level}交互作用`;
  const tone = group.level === 'Moderate' ? 'bg-amber-50 text-amber-900 border-amber-200'
    : group.level === 'Major' ? 'bg-red-50 text-red-900 border-red-200' : 'bg-slate-50 text-slate-800 border-slate-200';
  return <article className={`rounded-2xl border p-4 sm:p-5 ${tone}`}>
    <div className="flex items-start gap-3">
      <Info size={20} className="shrink-0 mt-1" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">{level}</p>
        <h5 className="font-bold text-lg mt-1 break-words">{group.names.join(' ＋ ')}</h5>
        <p className="text-sm leading-relaxed mt-2">{group.drugs.join('、')}{group.internal ? '的配方中含有這組成分。' : '含有這組成分。'}</p>
        {details.length ? <div className="mt-3 space-y-2 text-sm leading-relaxed">
          {details.map(detail => <p key={detail.id}>{detail.summary?.text || '已保存這組配對的來源原文，可展開下方依據查看；中文簡述尚未整理。'}</p>)}
          <p className="text-xs leading-relaxed">{interactionDetailScope}</p>
        </div> : <div className="mt-3 space-y-2 text-sm leading-relaxed">
          {!!types.length && <><p className="font-semibold">來源標示的影響方式</p><ul className="space-y-2">{types.map(type => <li key={type}><strong>{mechanismDefinitions[type].label}</strong>：{mechanismDefinitions[type].description}</li>)}</ul><p className="text-xs">{mechanismScope}</p></>}
          <p>資料庫有配對紀錄，但尚未保存詳細原因與處置說明，需由藥師核對來源。</p>
        </div>}
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer underline underline-offset-4">查看這項提醒的依據</summary>
          <ul className="mt-3 space-y-2">{group.pairs.map((pair, i) => <li key={i} className="break-words leading-relaxed">{pair.drugA}／{pair.drugB}<br />{pair.ingredientA} + {pair.ingredientB} · <a href={pair.sourceUrl} target="_blank" rel="noreferrer" className="underline">DDInter 來源</a>{pair.websiteSnapshot && <p className="mt-1">官方網站配對快照，已保存於本機；取得時間：{pair.websiteSnapshot.retrievedAt}。非本次即時查詢，也不是此年齡的個人風險機率。</p>}</li>)}</ul>
          {details.map(detail => <DetailSource key={detail.id} detail={detail} />)}
          {mechanisms.map(mechanism => <MechanismSource key={`${mechanism.sourceUrl}:${mechanism.sha256}`} mechanism={mechanism} />)}
        </details>
      </div>
    </div>
  </article>;
}

export default function MedicationInteractions({ report }: { report: MedicationReport }) {
  const groups = interactionGroups(report);
  const duplicates = groups.filter(g => g.status === 'duplicate');
  const found = groups.filter(g => g.status === 'found' && !g.internal);
  const internal = groups.filter(g => g.status === 'found' && g.internal);
  const missing = [...new Set(report.medications.flatMap(m => m.ingredients.filter(i => !i.ddinterId).map(ingredientName)))];
  const unavailable = report.interactions.some(p => p.status === 'not_imported');
  const partial = missing.length > 0 || unavailable || report.medications.some(m => !m.ingredients.length);
  const noPairs = report.interactions.length === 0;
  return <div className="space-y-5">
    <div>
      <h4 className="font-bold text-xl text-slate-900">{duplicates.length ? '這些藥有重複成分' : found.length || internal.length ? '有需要核對的交互作用' : '目前無法確認能否一起使用'}</h4>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{duplicates.length ? '先看相同成分，再請藥師確認用法與用量。' : noPairs ? '目前沒有可比較的成分配對。' : found.length || internal.length ? '以下整理資料庫查到的提醒，方便與藥師討論。' : '這次沒有查到可判讀的交互作用紀錄，不代表可以放心併用。'}</p>
    </div>
    {!!duplicates.length && <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 sm:px-5 text-amber-950">
      {duplicates.map(group => <article key={group.key} className="flex items-start gap-3 py-4 border-b border-amber-200 last:border-b-0">
        <Copy size={18} className="shrink-0 mt-1 text-amber-700" aria-hidden="true" />
        <div className="min-w-0"><h5 className="font-bold text-lg break-words">{group.names.join(' ＋ ')}</h5><p className="text-sm leading-relaxed mt-1 break-words">{group.drugs.join('、')}都有這個成分。</p></div>
      </article>)}
    </div>}
    {!!found.length && <section className="space-y-3" aria-label="不同藥品之間的交互作用"><h5 className="font-semibold text-slate-800">一起使用時的其他提醒</h5>{found.map(group => <Finding key={group.key} group={group} />)}</section>}
    <div className="rounded-2xl bg-slate-50 border border-slate-200 p-4 flex items-start gap-3">
      <CircleHelp size={20} className="text-slate-500 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 text-sm leading-relaxed text-slate-600"><p className="font-semibold text-slate-800">{partial ? '還有資料不足的部分' : '查詢結果不能保證用藥安全'}</p>
        <p className="mt-1">{unavailable ? '交互作用資料尚未載入，無法完成比對。' : missing.length ? `目前無法核對：${missing.join('、')}。` : '資料未涵蓋每個人的年齡、劑量、疾病與其他用藥。'}</p>
        <p className="mt-1">{partial ? '未完成核對或未查到紀錄，都不代表沒有風險。' : '是否適合一起使用，仍請醫師或藥師確認。'}</p>
      </div>
    </div>
    {!!internal.length && <details className="rounded-2xl border border-slate-200 bg-white p-4" open={internal.some(g => g.level === 'Major')}>
      <summary className="cursor-pointer font-medium text-sm text-slate-700">藥品本身的複方成分，也有 {internal.length} 項配對紀錄</summary>
      <p className="text-sm text-slate-500 mt-3 leading-relaxed">這些成分原本就在同一款藥裡，並非另外加吃一款藥；紀錄仍需結合產品仿單判讀。</p>
      <div className="space-y-3 mt-3">{internal.map(group => <Finding key={group.key} group={group} />)}</div>
    </details>}
    <details className="rounded-2xl border border-slate-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">查看完整核對明細（{report.interactions.length} 組）</summary>
      <div className="mt-3 divide-y divide-slate-100">{report.interactions.map((pair, i) => <div key={i} className="py-3 text-sm break-words leading-relaxed">
        <p className="text-slate-500">{pair.scope === 'within_product' ? `同一品項內：${pair.drugA}` : `${pair.drugA}／${pair.drugB}`}</p>
        <p className="mt-1 font-medium">{pair.ingredientA} + {pair.ingredientB}</p>
        <p className="mt-1">{interactionStatusText[pair.status]}{pair.level && ` · ${interactionLevelText[pair.level] || pair.level}`}</p>
        <a href={pair.sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-800 underline text-xs">資料來源</a>
        {pair.websiteSnapshot && <p className="mt-1 text-xs text-slate-500">官方網站配對快照 · 本機保存 · 取得 {pair.websiteSnapshot.retrievedAt}</p>}
      </div>)}{noPairs && <p className="text-sm text-slate-500">沒有可比較的成分配對。</p>}</div>
    </details>
  </div>;
}
