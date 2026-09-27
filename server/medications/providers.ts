import type { DrugCandidate, DrugSelection, LabelEvidence, MedicationEvidence, MedicationReport, ReportMode, ResolvedIngredient } from '../../shared/medication';
import { compareIngredients, datasetStatus, findDdinter, type DrugDatabase } from './store';
import { verifiedIngredientName, verifiedProductLabel } from './verified-names';
import { readTfdaLabelIndex } from './tfda-label-index';
import { evaluateMedicationSafety, type MedicationPatient } from '../../shared/medication-safety';
import { exactLookupName, findDdinterByRxnorm, ingredientRegistryKey, readIngredientRecord, validConcept, writeIngredientRecord, type IngredientRecord } from './ingredient-registry';
import { labelContext, labelResult, LABEL_MAX_PAGES, LABEL_PAGE_SIZE, parseLabelPage, readLabelSnapshot, writeLabelSnapshot, type LabelSnapshot } from './label-registry';

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const TTL = 24 * 60 * 60 * 1000;
type Fetcher = typeof fetch;
interface JsonSnapshot { data: any; retrievedAt?: string; reused: boolean }

// TFDA explicitly declares equivalent names with this syntax. Do not strip arbitrary
// parentheses (which may contain a salt, concentration or other clinically relevant qualifier).
export function ingredientAliases(original: string): string[] {
  const value = original.normalize('NFKC').trim();
  const equivalence = /^(.+?)((?:\s*\(\s*EQ\s+TO\s+[^()]+\))+\s*)$/i.exec(value);
  if (!equivalence) return [value];
  const names = [...equivalence[2].matchAll(/\(\s*EQ\s+TO\s+([^()]+)\)/gi)].map(match => match[1].trim());
  if (!names.every(Boolean)) return [value];
  return [...new Set([value, equivalence[1].trim(), ...names])];
}

export function ingredientLookup(original: string, drug?: DrugSelection) {
  const verified = verifiedIngredientName(original, drug);
  const aliases = [...new Set([...ingredientAliases(original), ...(verified ? [verified.name] : [])])];
  const value = original.normalize('NFKC').trim();
  const old = /^(.+?)\s*\(EQ\s+TO\s+([^()]+)\)$/i.exec(value);
  const oldAliases = [...new Set([...(old ? [value, old[1].trim(), old[2].trim()] : [value]), ...(verified ? [verified.name] : [])])];
  return { verified, aliases, key: ingredientRegistryKey(aliases, verified?.sourceUrl), previousKey: ingredientRegistryKey(oldAliases, verified?.sourceUrl) };
}

export class DrugProviders {
  private pending = new Map<string, Promise<JsonSnapshot>>();
  constructor(private db: DrugDatabase, private fetcher: Fetcher = fetch) {}

  private async json(url: string, allowMissing = false): Promise<any> {
    return (await this.jsonSnapshot(url, allowMissing)).data;
  }

  private async jsonSnapshot(url: string, allowMissing = false): Promise<JsonSnapshot> {
    const cached = this.db.prepare('SELECT value,retrieved_at FROM drug_api_cache WHERE key = ? AND expires > ?').get(url, Date.now()) as { value: string; retrieved_at: number | null } | undefined;
    // Older FDA cache rows have no acquisition timestamp: fetch again rather than invent a date.
    if (cached && (cached.retrieved_at || new URL(url).hostname !== 'api.fda.gov')) {
      return { data: JSON.parse(cached.value), retrievedAt: cached.retrieved_at ? new Date(cached.retrieved_at).toISOString() : undefined, reused: true };
    }
    if (this.pending.has(url)) return this.pending.get(url);
    const request = (async () => {
      const requestUrl = new URL(url);
      if (requestUrl.hostname === 'api.fda.gov' && process.env.OPENFDA_API_KEY) requestUrl.searchParams.set('api_key', process.env.OPENFDA_API_KEY);
      const response = await this.fetcher(requestUrl, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } });
      const data = await response.json();
      // Only FDA's documented no-results response counts as a completed search with no match.
      if (!response.ok && !(allowMissing && response.status === 404 && data.error?.code === 'NOT_FOUND')) {
        throw new Error(`資料來源暫時無法使用（HTTP ${response.status}）`);
      }
      const result = response.ok ? data : { results: [], meta: { results: { total: 0 } } };
      if ((requestUrl.hostname === 'api.fda.gov' && !Array.isArray(result.results)) ||
          (requestUrl.pathname.endsWith('/drugs.json') && !result.drugGroup) ||
          (requestUrl.pathname.endsWith('/related.json') && !result.relatedGroup) ||
          (requestUrl.pathname.endsWith('/version.json') && (typeof result.version !== 'string' || !/^\d{2}-[A-Za-z]{3}-\d{4}$/.test(result.version))) ||
          (requestUrl.pathname.endsWith('/rxcui.json') && !result.idGroup)) {
        throw new Error('資料來源回應格式異常');
      }
      this.db.prepare('DELETE FROM drug_api_cache WHERE expires <= ?').run(Date.now());
      const retrievedAt = Date.now();
      this.db.prepare('INSERT OR REPLACE INTO drug_api_cache(key,value,expires,retrieved_at) VALUES(?,?,?,?)').run(url, JSON.stringify(result), retrievedAt + TTL, retrievedAt);
      return { data: result, retrievedAt: new Date(retrievedAt).toISOString(), reused: false };
    })();
    this.pending.set(url, request);
    try { return await request; } finally { this.pending.delete(url); }
  }

  async searchRxnorm(query: string): Promise<DrugCandidate[]> {
    const [data, exact] = await Promise.all([
      this.json(`${RXNAV}/drugs.json?name=${encodeURIComponent(query)}`),
      this.json(`${RXNAV}/rxcui.json?name=${encodeURIComponent(query)}&search=0`),
    ]);
    if (!data.drugGroup) throw new Error('RxNorm 回應格式異常');
    const exactCandidates: DrugCandidate[] = [];
    for (const id of (exact.idGroup?.rxnormId || []).slice(0, 3)) {
      const detail = await this.json(`${RXNAV}/rxcui/${encodeURIComponent(id)}/properties.json`);
      if (detail.properties?.name && ['IN', 'PIN', 'MIN', 'SCD', 'SBD'].includes(detail.properties.tty)) exactCandidates.push(this.rxCandidate(detail.properties));
    }
    const groups = data.drugGroup?.conceptGroup || [];
    const related = groups.filter((g: any) => ['IN', 'PIN', 'MIN', 'SCD', 'SBD'].includes(g.tty))
      .flatMap((g: any) => (g.conceptProperties || []).map((p: any) => this.rxCandidate(p)));
    return [...new Map([...exactCandidates, ...related].map(candidate => [candidate.id, candidate])).values()].slice(0, 20);
  }

  private rxCandidate(p: any): DrugCandidate {
    return { source: 'rxnorm', id: p.rxcui, name: p.name, englishName: p.name,
      ingredients: ['IN', 'PIN'].includes(p.tty) ? [p.name] : [],
      dosageForm: ['IN', 'PIN', 'MIN'].includes(p.tty) ? '成分名稱，非特定產品' : '美國標準藥品名稱（請核對名稱內的規格與劑型）',
      manufacturer: '', licenseStatus: '', validUntil: '', indications: '', dosageText: '',
      sourceUrl: `${RXNAV}/rxcui/${encodeURIComponent(p.rxcui)}/properties.json` };
  }

  async getRxnorm(id: string): Promise<DrugCandidate | null> {
    const data = await this.json(`${RXNAV}/rxcui/${encodeURIComponent(id)}/properties.json`);
    if (!data.properties?.name || data.properties.suppress === 'Y') return null;
    const candidate = this.rxCandidate(data.properties);
    const ingredients = await this.rxIngredients(id);
    candidate.ingredients = ingredients.map(i => i.name);
    return candidate;
  }

  private async rxIngredients(id: string): Promise<{ name: string; rxcui: string }[]> {
    const data = await this.json(`${RXNAV}/rxcui/${encodeURIComponent(id)}/related.json?tty=IN`);
    if (!data.relatedGroup) throw new Error('RxNorm 回應格式異常');
    const concepts = (data.relatedGroup?.conceptGroup || []).filter((group: any) => group.tty === 'IN')
      .flatMap((group: any) => group.conceptProperties || []);
    if (concepts.some((p: any) => !validConcept(p) || p.tty !== 'IN' || p.suppress === 'Y')) throw new Error('RxNorm 成分格式異常');
    return [...new Map(concepts.map((p: any) => [p.rxcui, { name: p.name, rxcui: p.rxcui }] as const)).values()] as { name: string; rxcui: string }[];
  }

  async resolveIngredient(original: string, drug?: DrugSelection, mode: ReportMode = 'online'): Promise<ResolvedIngredient[]> {
    const { verified, aliases, key, previousKey } = ingredientLookup(original, drug);
    const matches = [...new Set(aliases.map(name => findDdinter(this.db, name)).filter(Boolean))];
    const directId = matches.length === 1 ? matches[0] : undefined;
    if (matches.length > 1) return [{ original, name: original, mapping: 'unmapped' }];
    const fallback: ResolvedIngredient = { original, name: verified?.name || original, ddinterId: directId,
      mapping: verified ? 'verified_alias' : directId ? 'exact' : 'unmapped', aliasSourceUrl: verified?.sourceUrl };
    let stored = readIngredientRecord(this.db, key);
    if (!stored && previousKey !== key) {
      const previous = readIngredientRecord(this.db, previousKey);
      // Preserve a prior successful exact lookup only if its searched name is
      // still one of the explicitly declared aliases. Never reuse an old miss
      // as evidence that the newly parsed names were checked.
      if (previous?.status === 'matched' && aliases.some(name => name.toLowerCase() === exactLookupName(previous)?.toLowerCase())) stored = previous;
    }
    // Shipped exact PIN evidence is a fallback for an absent record, never an
    // override for a later local finding or review requirement.
    stored ||= verified?.record;
    const fromRecord = (record: IngredientRecord | undefined, reused: boolean): ResolvedIngredient => {
      if (record?.status !== 'matched' || !record.ingredient || !record.matched) return fallback;
      const item = record.ingredient;
      // Re-resolve against the CURRENT DDInter import; never persist stale DDInter IDs.
      const preferredId = findDdinter(this.db, item.name);
      // A reviewed base spelling may differ from RxNorm's preferred name
      // (e.g. salbutamol/albuterol). Use its independently verified IN lookup
      // only while BOTH the PIN and IN still match the shipped relationship.
      const qualifiedId = verified?.baseName && verified.record?.matched?.rxcui === record.matched.rxcui &&
        verified.record?.ingredient?.rxcui === item.rxcui ? findDdinter(this.db, verified.baseName) : undefined;
      if (preferredId && qualifiedId && preferredId !== qualifiedId) return fallback;
      const relatedId = preferredId || qualifiedId;
      if (directId && relatedId && directId !== relatedId) return fallback;
      const ddinterNormalization = !directId && !preferredId && qualifiedId ? {
        ddinterId: qualifiedId, name: verified!.baseName!, rxCui: item.rxcui,
        checkedAt: verified!.record!.checkedAt, version: verified!.record!.version, lookupUrl: verified!.baseLookupUrl!,
        sourceUrl: `${RXNAV}/rxcui/${item.rxcui}/properties.json`,
      } : !directId && !relatedId ? findDdinterByRxnorm(this.db, item.rxcui) : undefined;
      return { ...fallback, name: item.name, rxCui: item.rxcui, ddinterId: directId || relatedId || ddinterNormalization?.ddinterId,
        ...(ddinterNormalization ? { ddinterNormalization } : {}),
        mapping: verified ? 'verified_alias' : directId ? 'exact' : 'rxnorm',
        normalization: { checkedAt: record.checkedAt, version: record.version, reused,
          matchedName: record.matched.name, matchedRxCui: record.matched.rxcui,
          lookupUrl: record.lookupUrl, sourceUrl: `${RXNAV}/rxcui/${record.matched.rxcui}/related.json?tty=IN` } };
    };
    if (mode === 'local' || (stored && Date.now() - Date.parse(stored.checkedAt) < TTL)) return [fromRecord(stored, true)];
    try {
      const versionData = await this.json(`${RXNAV}/version.json`);
      if (typeof versionData.version !== 'string' || !/^\d{2}-[A-Za-z]{3}-\d{4}$/.test(versionData.version)) throw new Error('RxNorm 版本格式異常');
      let lookupUrl = '';
      const save = (status: IngredientRecord['status'], extra: Partial<IngredientRecord> = {}) => {
        const record: IngredientRecord = { ...extra, schema: 1, status, checkedAt: new Date().toISOString(), version: versionData.version, lookupUrl };
        writeIngredientRecord(this.db, key, record);
        return [fromRecord(record, false)];
      };
      // Exact-only lookup deliberately avoids silently picking a similarly named medicine or dropping a salt.
      let ids: string[] = [];
      const ambiguousResults: string[][] = [];
      for (const name of aliases) {
        lookupUrl = `${RXNAV}/rxcui.json?name=${encodeURIComponent(name)}&search=0`;
        const data = await this.json(lookupUrl);
        ids = data.idGroup?.rxnormId || [];
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw new Error('RxNorm ID 格式異常');
        if (ids.length > 1) { ambiguousResults.push(ids); continue; }
        if (ids.length === 1) {
          // A later explicit alias may disambiguate the earlier name, but its
          // unique concept must be present in EVERY preceding candidate set.
          if (ambiguousResults.some(candidates => !candidates.includes(ids[0]))) return save('needs_review', { reason: '明示別名的精確概念互相衝突' });
          break;
        }
      }
      if (ids.length !== 1) return ambiguousResults.length ? save('needs_review', { reason: '精確名稱對應多個概念' }) : save('not_found');
      const detail = await this.json(`${RXNAV}/rxcui/${ids[0]}/properties.json`);
      const matched = detail.properties;
      // A brand or a single-ingredient product is not an ingredient-name match.
      if (!validConcept(matched) || matched.rxcui !== ids[0] || matched.suppress === 'Y') return save('needs_review', { reason: '不是有效的單一成分概念' });
      const ingredients = await this.rxIngredients(ids[0]);
      // TFDA's field is already one ingredient. A one-to-many match requires review, not automatic expansion.
      if (ingredients.length !== 1) return save('needs_review', { reason: '無唯一活性成分關係' });
      const item = ingredients[0];
      const relatedId = findDdinter(this.db, item.name);
      if ((matched.tty === 'IN' && matched.rxcui !== item.rxcui) || (directId && relatedId && directId !== relatedId)) return save('needs_review', { reason: '成分來源互相衝突' });
      return save('matched', { matched: { rxcui: matched.rxcui, name: matched.name, tty: matched.tty }, ingredient: { ...item, tty: 'IN' } });
    } catch { return [fromRecord(stored, true)]; }
  }

  async labels(ingredients: ResolvedIngredient[], mode: ReportMode = 'online'): Promise<{ labels: LabelEvidence[]; status: MedicationEvidence['labelStatus']; lookup?: MedicationEvidence['labelLookup'] }> {
    const context = labelContext(ingredients);
    if (!context) return { labels: [], status: mode === 'local' ? 'not_requested' : 'unmapped' };
    const stored = readLabelSnapshot(this.db, context);
    if (mode === 'local') return stored ? labelResult(stored, true, 'not_requested') : { labels: [], status: 'not_requested' };
    let currentUrl = context.url;
    try {
      const matches = new Map<string, LabelEvidence>();
      const rawLabels = new Map<string, unknown>();
      let scanned = 0, total: number | null = null, complete = false, reused = true;
      let retrievedAt: string | undefined, sourceUpdatedAt: string | undefined;
      for (let page = 0; page < LABEL_MAX_PAGES; page++) {
        const url = new URL(context.url); if (page) url.searchParams.set('skip', String(scanned));
        currentUrl = url.toString();
        const response = await this.jsonSnapshot(currentUrl, true), data = response.data;
        const labels = parseLabelPage(data, context.groups);
        if (!response.retrievedAt) throw new Error('仿單缺少取得日期');
        const count = data.meta?.results?.total;
        if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new Error('仿單筆數格式異常');
        if (total !== null && count !== undefined && total !== count) throw new Error('查詢途中來源已更新，請重試');
        if (count !== undefined) total = count;
        const updated = typeof data.meta?.last_updated === 'string' ? data.meta.last_updated : undefined;
        if (sourceUpdatedAt && updated && sourceUpdatedAt !== updated) throw new Error('查詢途中來源已更新，請重試');
        sourceUpdatedAt ||= updated;
        retrievedAt = !retrievedAt || response.retrievedAt < retrievedAt ? response.retrievedAt : retrievedAt;
        reused &&= response.reused;
        scanned += data.results.length;
        if (total !== null && scanned > total) throw new Error('仿單回傳筆數不一致');
        for (const label of labels) if (!matches.has(label.setId || label.id)) {
          matches.set(label.setId || label.id, label);
          rawLabels.set(label.id, data.results.find(record => record.id === label.id));
        }
        complete = total !== null ? scanned >= total : data.results.length < LABEL_PAGE_SIZE;
        if (matches.size >= 2 || complete || !data.results.length) break;
      }
      const chosen = [...matches.values()].slice(0, 2);
      const snapshot: LabelSnapshot = { schema: 1, textVersion: 2, tableVersion: 1, rawLabels: chosen.map(label => rawLabels.get(label.id)),
        retrievedAt: retrievedAt!, sourceUrl: context.url, sourceUpdatedAt, scanned, total, complete, labels: chosen };
      writeLabelSnapshot(this.db, context.key, snapshot);
      return labelResult(snapshot, reused, reused ? 'cached' : 'succeeded');
    } catch {
      // Malformed pages must not be served repeatedly from the short-lived HTTP cache.
      this.db.prepare('DELETE FROM drug_api_cache WHERE key=?').run(currentUrl);
      return stored ? labelResult(stored, true, 'failed') : { labels: [], status: 'unavailable' };
    }
  }

  async report(drugs: DrugCandidate[], mode: ReportMode = 'online', patient?: MedicationPatient): Promise<MedicationReport> {
    const medications: MedicationEvidence[] = [];
    // Bound outgoing calls and preserve the user's selected order.
    for (const drug of drugs) {
      const ingredients: ResolvedIngredient[] = [];
      for (const ingredient of drug.ingredients) ingredients.push(...await this.resolveIngredient(ingredient, drug, mode));
      const { labels, status, lookup } = await this.labels(ingredients, mode);
      const warnings: string[] = [];
      if (!ingredients.length) warnings.push('來源未提供成分，無法完成交互作用查詢。');
      if (mode === 'online' && ingredients.some(i => !i.rxCui)) warnings.push('部分成分未完成 RxNorm 精確對照，或標準名稱服務暫時無法連線；不以相似名稱替代。');
      if (ingredients.some(i => !i.ddinterId)) warnings.push('部分成分未能對應 DDInter，相關配對無法判定。');
      if (ingredients.some(i => i.normalization && Date.now() - Date.parse(i.normalization.checkedAt) > 30 * TTL)) warnings.push('部分本機成分對照已超過 30 天，請連線更新核對；30 天是專案更新提醒門檻，並非醫療有效期限。');
      if (ingredients.some(i => i.ddinterNormalization && Date.now() - Date.parse(i.ddinterNormalization.checkedAt) > 30 * TTL)) warnings.push('部分 DDInter 名稱對照已超過 30 天，請由管理者更新本機名稱資料；此日期不是醫療有效期限。');
      if (lookup?.refresh === 'failed') warnings.push('美國仿單更新失敗，以下保留先前本機紀錄與原取得日期，並非本次線上查核成功。');
      if (lookup?.stale) warnings.push('本機美國仿單紀錄已超過 7 天，請連線更新；7 天是專案更新提醒門檻，並非醫療有效期限。');
      if (drug.licenseStatus && drug.licenseStatus !== '未標示註銷') warnings.push(`許可證狀態：${drug.licenseStatus}。`);
      const expiry = /^\d{4}\/\d{2}\/\d{2}$/.test(drug.validUntil) ? new Date(`${drug.validUntil.replaceAll('/', '-')}T23:59:59+08:00`) : null;
      if (expiry && expiry.getTime() < Date.now()) warnings.push('資料中的許可證有效日期已過，請查核 TFDA 最新狀態。');
      medications.push({ drug, ingredients, labels, labelStatus: status, labelLookup: lookup, warnings,
        localLabel: verifiedProductLabel(drug), taiwanLabelIndex: readTfdaLabelIndex(this.db, drug) });
    }
    return { mode, checkedAt: new Date().toISOString(), datasets: datasetStatus(this.db), medications,
      ...(patient ? { safety: evaluateMedicationSafety(drugs, patient) } : {}),
      interactions: compareIngredients(this.db, medications), limitations: [
        '查無紀錄、未完成成分對照或來源無法連線，都不代表沒有交互作用。',
        '交互作用結果是成分層級篩查，未依年齡、劑型、途徑、劑量或病人狀況個別判定；含複方內的成分配對。',
        '美國仿單僅按成分篩選供參考，未核對與所選產品的規格、劑型及適應症；不能直接套用到臺灣產品或任何年齡的個人用量。',
        '不進行個人化劑量計算或處方建議；請由醫師或藥師核對。',
        '標準成分對照使用美國 NLM（隸屬 NIH／HHS）公開資料；NLM 不負責本產品，也不為本產品背書或推薦。',
        mode === 'local' ? '本次僅查本機資料庫，可重用附版本與日期的成分對照及先前保存的美國仿單，未連線更新；請核對取得日期。未知成分仍保留，外觀候選不代表唯一識別。' : '本次包含線上補查；原始 API 回應快取 24 小時，已核對成分與仿單另保存本機紀錄。連線失敗時可沿用紀錄，請核對各筆日期與更新狀態。',
      ] };
  }
}
