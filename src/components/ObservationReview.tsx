import { useEffect, useState } from 'react';
import type { MedicationMatch, MedicationObservation } from '../../shared/medication';

type Props = {
  matches: MedicationMatch[];
  disabled: boolean;
  formListId: string;
  onSelect: (match: MedicationMatch) => void;
  onSearch: (observation: MedicationObservation, index: number) => void;
  onEdit: () => void;
};

function ObservationCard({ match, index, disabled, formListId, onSelect, onSearch, onEdit }: Omit<Props, 'matches'> & { match: MedicationMatch; index: number }) {
  const [draft, setDraft] = useState(match.observation);
  useEffect(() => setDraft(match.observation), [match]);
  const changed = (['name', 'strength', 'dosageForm'] as const).some(field => draft[field] !== match.observation[field]);
  const appearance = [draft.appearance?.color, draft.appearance?.shape, ...(draft.appearance?.imprints || [])].filter(Boolean).join('／');
  return <details className="rounded-xl border border-slate-200 bg-white p-3">
    <summary className="cursor-pointer text-sm font-medium break-words">
      {match.observation.name || appearance || '特徵不足'}
      <span className="block mt-1 text-xs font-normal text-slate-600">{changed ? '已修改，請重新查詢候選' : `${match.observation.strength} ${match.observation.dosageForm} · 本機候選 ${match.total} 筆`} · 展開核對</span>
    </summary>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      {([['name', '核對藥名'], ['strength', '核對規格'], ['dosageForm', '核對劑型']] as const).map(([field, label]) => <label key={field} className="text-xs text-slate-600">
        {label}
        <input aria-label={`${label} ${index + 1}`} value={draft[field]} disabled={disabled} maxLength={120}
          list={field === 'dosageForm' ? formListId : undefined}
          onChange={e => { setDraft({ ...draft, [field]: e.target.value }); onEdit(); }}
          className="mt-1 w-full min-w-0 rounded-lg border border-slate-300 p-2 text-sm text-slate-800" />
      </label>)}
    </div>
    {appearance && <p className="mt-2 text-xs text-slate-600">保留外觀條件：{appearance}</p>}
    <p className="mt-2 text-xs text-slate-600">劑型依資料庫細分類比對，例如錠劑、膜衣錠分開查詢。不確定時可清空劑型，擴大查詢後再核對。</p>
    <button type="button" disabled={disabled} onClick={() => changed ? onSearch(draft, index) : onSelect(match)}
      className="mt-3 rounded-lg border border-emerald-700 px-3 py-2 text-sm font-medium text-emerald-800 disabled:opacity-50">
      {changed ? '用校正資料查詢' : '查看本機候選'}
    </button>
  </details>;
}

export default function ObservationReview({ matches, ...props }: Props) {
  if (!matches.length) return null;
  return <div className="mt-4 space-y-2">
    <p className="text-sm font-medium">已比對本機資料；請核對辨識文字，可修改後再查詢</p>
    {matches.map((match, index) => <ObservationCard key={index} match={match} index={index} {...props} />)}
  </div>;
}
