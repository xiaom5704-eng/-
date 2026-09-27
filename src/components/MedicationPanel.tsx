import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Camera, Check, FileText, Loader2, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import MarkdownContent from './MarkdownContent';
import type { DatasetStatus, DrugCandidate, DrugSource, MedicationReport, MedicationMatch, MedicationObservation, ReportMode, SearchPagination } from '../../shared/medication';
import { datasetNames, reportToMarkdown } from '../../shared/medication';
import MedicationResults from './MedicationResults';
import MedicationDataSetup from './MedicationDataSetup';
import type { LocalDataSetup } from '../../shared/local-data';
import AppearanceSearch from './AppearanceSearch';
import DrugAppearanceDetails from './DrugAppearanceDetails';
import OcrReview from './OcrReview';
import ObservationReview from './ObservationReview';
import VisionResults from './VisionResults';
import PackageReferenceForm from './PackageReferenceForm';
import PillReferenceLibrary from './PillReferenceLibrary';
import { pillReferenceIdentity, type PersonalPillLibrary } from '../../shared/pill-references';
import PhotoCropDialog from './PhotoCropDialog';
import CameraDialog from './CameraDialog';
import type { VisionResult, VisionStatus } from '../../shared/medication-vision';
import type { PillObservation } from '../../shared/pill-observation';
import { requestJson } from '../services/http';
import { observationFromOcr, switchOcrReading, type OcrPage, type OcrTarget, type ScanEngine } from '../../shared/medication-ocr';
import { summarizeMedicationReport } from '../../shared/medication-summary';
import { reportMatchesSelection } from '../../shared/medication-view';
import { getMedicationStatus, queryMedicationReport, searchMedications, matchMedications, loadMedicationDemo, suggestMedicationNames } from '../services/medications';
import { canSuggestName } from '../../shared/name-suggestions';
import { ageError } from '../../shared/consultation';
import type { MedicationPatient } from '../../shared/medication-safety';
import MedicationDemo from './MedicationDemo';
import MedicationPatientField from './MedicationPatientField';
import { ALLOWED_FILE_TYPES, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../services/medication-files';
import { readMedicationPhoto, readMedicationScan } from '../services/medication-scan';
import { medicationSaveAttempt, type MedicationSaveAttempt } from '../../shared/medication-save';

type Attachment = { id: string; name: string; data: string; type: string; size: number };
type Props = { apiKey: string; onSave: (report: MedicationSaveAttempt) => Promise<void>; saveDisabled?: boolean; savedRequestId?: string; active?: boolean };
type CandidatePaging = { page: SearchPagination; request:
  { kind: 'name'; query: string; source: DrugSource; dosageForm: string } | { kind: 'appearance'; observation: MedicationObservation } };
const dateText = (date: string | null) => date ? new Date(date).toLocaleString('zh-TW') : '尚未載入';
const button = 'rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed';
const primary = `${button} bg-emerald-700 text-white hover:bg-emerald-800`;
const secondary = `${button} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`;

export default function MedicationPanel({ apiKey, onSave, saveDisabled = false, savedRequestId, active = true }: Props) {
  const [datasets, setDatasets] = useState<DatasetStatus[]>([]);
  const [dataSetup, setDataSetup] = useState<LocalDataSetup>();
  const [statusError, setStatusError] = useState('');
  const [statusLoading, setStatusLoading] = useState(false);
  const statusVersion = useRef(0);
  const [query, setQuery] = useState('');
  const [dosageForm, setDosageForm] = useState('');
  const [dosageForms, setDosageForms] = useState<string[]>([]);
  const formListId = useId();
  const [source, setSource] = useState<DrugSource>('tfda');
  const [candidates, setCandidateItems] = useState<DrugCandidate[]>([]);
  const [candidatePaging, setCandidatePaging] = useState<CandidatePaging | null>(null);
  const [candidatePageError, setCandidatePageError] = useState('');
  const [nameSuggestions, setNameSuggestions] = useState<string[] | null>(null);
  // Every replacement (OCR, CV, edits or uploads) invalidates the previous pager.
  const replaceCandidates = (items: DrugCandidate[]) => { setCandidateItems(items); setCandidatePaging(null); setCandidatePageError(''); setNameSuggestions(null); };
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<DrugCandidate[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [scanMatches, setScanMatches] = useState<MedicationMatch[]>([]);
  const [scanEngine, setScanEngine] = useState<ScanEngine>('vision');
  const [visionStatus, setVisionStatus] = useState<VisionStatus | null>(null);
  const [packageStatus, setPackageStatus] = useState<VisionStatus | null>(null);
  const [personalLibrary, setPersonalLibrary] = useState<PersonalPillLibrary | null>(null);
  const [visionResult, setVisionResult] = useState<VisionResult | null>(null);
  const [visionImprint, setVisionImprint] = useState('');
  const [readPhotoText, setReadPhotoText] = useState(true);
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);
  const [observedPill, setObservedPill] = useState<PillObservation | null>(null);
  const [cropId, setCropId] = useState<string | null>(null);
  const visionHeading = useRef<HTMLDivElement>(null);
  const ocrHeading = useRef<HTMLDivElement>(null);
  const [ocrTarget, setOcrTarget] = useState<OcrTarget>('label');
  const [ocrPages, setOcrPages] = useState<OcrPage[]>([]);
  const [scanProgress, setScanProgress] = useState('');
  const scanController = useRef<AbortController | null>(null);
  const [report, setReport] = useState<MedicationReport | null>(null);
  const [reportRefreshError, setReportRefreshError] = useState('');
  const [patient, setPatient] = useState<MedicationPatient>({ age: { value: '', unit: 'years' }, premature: 'unknown' });
  const [demoId, setDemoId] = useState<string>();
  const [explanation, setExplanation] = useState('');
  const [language, setLanguage] = useState('繁體中文');
  const [busy, setBusy] = useState<'search' | 'files' | 'extract' | 'reference' | 'match' | 'report' | 'save' | null>(null);
  const [reportMode, setReportMode] = useState<ReportMode>('local');
  const [error, setError] = useState('');
  const [notices, setNotices] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const saveAttempt = useRef<MedicationSaveAttempt | null>(null);
  const saving = useRef(false);
  const reportContent = useMemo(() => report ? reportToMarkdown(report) + (explanation ? `\n\n${explanation}` : '') : '', [report, explanation]);
  const reportSaved = !!report && saveAttempt.current?.content === reportContent && (saved || saveAttempt.current?.requestId === savedRequestId);
  useEffect(() => {
    if (savedRequestId && saveAttempt.current?.requestId === savedRequestId) { setSaved(true); setError(''); }
  }, [savedRequestId]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchVersion = useRef(0);
  const mounted = useRef(true);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const searchSection = useRef<HTMLElement>(null);
  const selectionSection = useRef<HTMLElement>(null);
  const candidateSection = useRef<HTMLDivElement>(null);
  const visualMode = scanEngine === 'vision' || scanEngine === 'package';
  const activeVisionStatus = scanEngine === 'package' ? packageStatus : visionStatus;
  const maxFiles = visualMode ? 2 : 4;
  const suggestionRequest = candidatePaging?.request;
  const suggestionQuery = suggestionRequest?.kind === 'name' && suggestionRequest.source === 'tfda' ? suggestionRequest.query :
    suggestionRequest?.kind === 'appearance' && !suggestionRequest.observation.appearance && !suggestionRequest.observation.strength ? suggestionRequest.observation.name : '';
  useEffect(() => { setObservedPill(null); setScanWarnings([]); }, [files, scanEngine]);

  function acceptDatasets(value: DatasetStatus[]) {
    statusVersion.current++;
    setDatasets(value); setStatusError(''); setStatusLoading(false);
  }
  async function refreshDatasets() {
    const version = ++statusVersion.current;
    setStatusLoading(true);
    try {
      const data = await getMedicationStatus();
      if (mounted.current && version === statusVersion.current) { acceptDatasets(data.datasets); setDosageForms(data.dosageForms || []); setDataSetup(data.dataSetup); }
    } catch {
      if (mounted.current && version === statusVersion.current) setStatusError('目前無法取得資料來源狀態，請確認後端已啟動。');
    } finally { if (mounted.current && version === statusVersion.current) setStatusLoading(false); }
  }

  async function refreshVisionStatus() {
    await Promise.all([refreshPersonalLibrary(), ...([['vision', setVisionStatus], ['packages', setPackageStatus]] as const).map(async ([route, update]) => {
      try { const data = await requestJson<VisionStatus>(`/api/medications/${route}/status`); if (mounted.current) update(data); }
      catch { if (mounted.current) update({ ready: false, imageCount: 0, drugCount: 0, model: '', reason: '無法連線至本機圖片比對服務，請確認後端已啟動。' }); }
    })]);
  }
  async function refreshPersonalLibrary() {
    try { const data = await requestJson<PersonalPillLibrary>('/api/medications/vision/personal-references'); if (mounted.current) setPersonalLibrary(data); }
    catch { if (mounted.current) setPersonalLibrary({ photos: [], warning: '無法讀取自存照片，請確認後端已啟動後重試。' }); }
  }
  useEffect(() => {
    if (!active) return;
    if (ocrPages.length) ocrHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    else if (visionResult) visionHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [visionResult, ocrPages.length]);

  useEffect(() => {
    if (active && searched) candidateSection.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [candidates, searched]);

  useEffect(() => {
    if (active && report) {
      resultHeading.current?.focus({ preventScroll: true });
      resultHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [report]);

  useEffect(() => {
    if (!active) {
      scanController.current?.abort();
      setCameraOpen(false);
      setCropId(null);
    }
  }, [active]);

  useEffect(() => {
    mounted.current = true;
    void refreshVisionStatus();
    void refreshDatasets();
    return () => { mounted.current = false; statusVersion.current++; scanController.current?.abort(); };
  }, []);

  const invalidateReport = () => { setReport(null); setReportRefreshError(''); setExplanation(''); setSaved(false); };
  const clearSearchResults = () => { searchVersion.current++; replaceCandidates([]); setSearched(false); setNotices([]); setError(''); };
  const updateQuery = (value: string) => { searchVersion.current++; setQuery(value); replaceCandidates([]); setSearched(false); setNotices([]); };
  const updateDosageForm = (value: string) => { searchVersion.current++; setDosageForm(value); replaceCandidates([]); setSearched(false); setNotices([]); };
  const updateSource = (value: DrugSource) => { searchVersion.current++; setSource(value); setDosageForm(''); replaceCandidates([]); setSearched(false); setNotices([]); };

  async function search(value = query, origin = source) {
    if (value.trim().length < 2) { setError('請輸入至少 2 個字的藥名。'); return; }
    if (value.trim().length > 120) { setError('藥名與規格合計最多 120 字，請縮短查詢文字。'); return; }
    const form = origin === 'tfda' ? dosageForm.trim() : '';
    const version = ++searchVersion.current;
    setBusy('search'); setError(''); setNotices([]); replaceCandidates([]); setSearched(false);
    try {
      const data = await searchMedications(value.trim(), origin, 0, undefined, form);
      if (version !== searchVersion.current || !mounted.current) return;
      replaceCandidates(data.candidates); setNotices(data.warnings); setSearched(true);
      setCandidatePaging({ page: data.page, request: { kind: 'name', query: value.trim(), source: origin, dosageForm: form } });
    } catch (e) { if (version === searchVersion.current && mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(null); }
  }

  async function changeCandidatePage(offset: number, refresh = false) {
    const current = candidatePaging;
    if (!current || busy) return;
    const version = ++searchVersion.current;
    setBusy('search'); setError(''); setCandidatePageError('');
    try {
      const request = current.request;
      const revision = refresh ? undefined : current.page.revision;
      const data = request.kind === 'name' ? await searchMedications(request.query, request.source, offset, revision, request.dosageForm) :
        (await matchMedications([request.observation], offset, revision)).matches[0];
      if (version !== searchVersion.current || !mounted.current) return;
      replaceCandidates(data.candidates); setNotices(data.warnings);
      setCandidatePaging({ ...current, page: data.page });
    } catch (e) { if (version === searchVersion.current && mounted.current) setCandidatePageError((e as Error).message); }
    finally { if (mounted.current && version === searchVersion.current) setBusy(null); }
  }

  async function suggestNames() {
    if (busy || !canSuggestName(suggestionQuery)) return;
    const version = ++searchVersion.current;
    setBusy('search'); setError('');
    try {
      const result = await suggestMedicationNames(suggestionQuery, dosageForm);
      if (mounted.current && version === searchVersion.current) setNameSuggestions(result.suggestions);
    } catch (e) { if (mounted.current && version === searchVersion.current) setError((e as Error).message); }
    finally { if (mounted.current && version === searchVersion.current) setBusy(null); }
  }

  async function addFiles(input: File[]) {
    setError('');
    if (files.length + input.length > maxFiles) { setError(`此模式最多可加入 ${maxFiles} 個檔案。圖片比對請使用同一品項的不同面，勿混入藥盒與藥錠。`); return; }
    if (visualMode && input.some(file => file.type === 'application/pdf')) { setError('PDF 請切換「本機 OCR 讀文字」；藥盒與藥錠比對請使用照片。'); return; }
    if (input.some(file => !ALLOWED_FILE_TYPES.includes(file.type))) { setError('請上傳 JPEG、PNG、WebP 或 PDF 檔案。'); return; }
    if (input.some(file => file.size > MAX_FILE_BYTES) || [...files, ...input].reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) {
      setError('單檔上限 8 MB，全部檔案合計上限 12 MB。'); return;
    }
    setBusy('files');
    try {
      const additions = await Promise.all(input.map(file => new Promise<Attachment>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name, data: String(reader.result), type: file.type, size: file.size });
        reader.onerror = () => reject(new Error('無法讀取檔案，請重新選擇。'));
        reader.readAsDataURL(file);
      })));
      if (mounted.current) { setFiles(prev => [...prev, ...additions]); setScanMatches([]); setOcrPages([]); setVisionResult(null); replaceCandidates([]); setSearched(false); setNotices([]); }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(null); }
  }

  const openCamera = () => { setError(''); setCameraOpen(true); };

  async function extract(engine: ScanEngine = scanEngine, target: OcrTarget = engine === 'local' && scanEngine === 'vision' ? 'pill' : ocrTarget) {
    const controller = new AbortController(); scanController.current = controller;
    setBusy('extract'); setError(''); setScanWarnings([]); setScanMatches([]); setOcrPages([]); if (engine === 'vision' || engine === 'package') setVisionResult(null); replaceCandidates([]); setNotices([]); setSearched(false); setScanProgress('準備辨識…');
    try {
      if ((engine === 'vision' || engine === 'package') && readPhotoText) {
        const result = await readMedicationPhoto(engine, files, { target, imprint: visionImprint, signal: controller.signal,
          onProgress: message => { if (mounted.current && !controller.signal.aborted) setScanProgress(message); } });
        if (!mounted.current || controller.signal.aborted) return;
        setVisionResult(result.vision); setOcrPages(result.pages); setScanWarnings(result.issues);
        if (result.vision) (engine === 'package' ? setPackageStatus : setVisionStatus)(result.vision.status);
        return;
      }
      const result = await readMedicationScan(engine, files, apiKey, { target, imprint: visionImprint, signal: controller.signal,
        onProgress: message => { if (mounted.current && !controller.signal.aborted) setScanProgress(message); } });
      if (!mounted.current || controller.signal.aborted) return;
      if (result.engine === 'vision' || result.engine === 'package') { setVisionResult(result.result); (result.engine === 'package' ? setPackageStatus : setVisionStatus)(result.result.status); return; }
      if (result.engine === 'local') { setOcrPages(result.pages); return; }
      if (!result.observations.length) throw new Error('沒有辨識到清楚的藥名或外觀，請補拍或手動輸入刻字與藥名。');
      const data = await matchMedications(result.observations);
      if (mounted.current) {
        setScanMatches(data.matches); showMatch(data.matches[0]);
      }
    } catch (e) { if (mounted.current) setError(controller.signal.aborted ? '已取消本機辨識，可重新開始或手動輸入。' : (e as Error).message || '辨識失敗，請手動輸入藥名。'); }
    finally { scanController.current = null; if (mounted.current) { setBusy(null); setScanProgress(''); } }
  }

  async function observePill() {
    const controller = new AbortController(); scanController.current = controller;
    setBusy('extract'); setError(''); setObservedPill(null); setScanProgress('Ollama 正在讀取外觀特徵，可能需要約一分鐘；完成後請核對再搜尋。');
    try {
      const result = await requestJson<PillObservation>('/api/medications/vision/observe', { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: files.map(file => file.data) }) });
      if (mounted.current && !controller.signal.aborted) setObservedPill(result);
    } catch (e) { if (mounted.current) setError(controller.signal.aborted ? '已取消外觀輔助，可使用 CV／OCR 或手動輸入。' : (e as Error).message); }
    finally { scanController.current = null; if (mounted.current) { setBusy(null); setScanProgress(''); } }
  }

  async function registerPackage(productName: string, sourceNote: string) {
    if (files.length < 1 || files.length > 2 || files.some(file => file.type === 'application/pdf')) { setError('收錄藥盒請選擇 1–2 張同一品項照片。'); return; }
    const controller = new AbortController(); scanController.current = controller;
    setBusy('reference'); setError(''); setNotices([]); setScanProgress('正在本機建立藥盒圖片特徵並收錄…');
    try {
      const result = await requestJson<{ status: VisionStatus; productName: string; licenseCount: number }>('/api/medications/packages/references', {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: files.map(file => file.data), productName, sourceNote, confirmed: true }),
      });
      if (!mounted.current || controller.signal.aborted) return;
      setPackageStatus(result.status); setVisionResult(null);
      setNotices([`已收錄「${result.productName}」；依品名連結 ${result.licenseCount} 筆許可證候選。可用上方辨識按鈕測試，不會自動確認藥品。`]);
    } catch (e) { if (mounted.current) setError(controller.signal.aborted ? '已取消等待收錄。請重新檢查圖庫確認狀態；重送相同照片不會重複累加。' : (e as Error).message); }
    finally { scanController.current = null; if (mounted.current) { setBusy(null); setScanProgress(''); } }
  }

  async function updatePersonalLibrary(url: string, body: unknown, notice: string) {
    const controller = new AbortController(); scanController.current = controller;
    setBusy('reference'); setError(''); setNotices([]); setScanProgress('正在更新本機藥錠照片圖庫…');
    try {
      const result = await requestJson<{ status: VisionStatus; library: PersonalPillLibrary }>(url, {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!mounted.current || controller.signal.aborted) return;
      setVisionStatus(result.status); setPersonalLibrary(result.library); setVisionResult(null); setNotices([notice]);
    } catch (e) { if (mounted.current) setError(controller.signal.aborted ? '已取消等待，請重新讀取自存照片確認狀態；相同照片可重送。' : (e as Error).message); }
    finally { scanController.current = null; if (mounted.current) { setBusy(null); setScanProgress(''); } }
  }

  function registerPill(drug: DrugCandidate, sourceNote: string) {
    if (files.length < 1 || files.length > 2 || files.some(file => file.type === 'application/pdf')) { setError('收錄藥錠請選擇 1–2 張同一品項照片。'); return; }
    void updatePersonalLibrary('/api/medications/vision/personal-references', {
      images: files.map(file => file.data), drugId: drug.id, identity: pillReferenceIdentity(drug), sourceNote, confirmed: true,
    }, `已收錄「${drug.name}」的藥錠照片；後續比對仍須人工核對，不會自動確認藥品。`);
  }

  function updateOcrPage(index: number, update: (page: OcrPage) => OcrPage) {
    clearSearchResults();
    setOcrPages(previous => previous.map((page, i) => i === index ? update(page) : page));
  }

  function searchOcrLine(line: string) {
    try {
      const observation = observationFromOcr(line, scanEngine === 'vision' ? 'pill' : scanEngine === 'package' ? 'label' : ocrTarget);
      if (scanEngine === 'vision') { setVisionImprint(line); setVisionResult(null); }
      void searchAppearance(observation);
    }
    catch (e) { setError((e as Error).message); }
  }

  function showMatch(match: MedicationMatch) {
    searchVersion.current++; setQuery([match.observation.name, match.observation.strength].filter(Boolean).join(' ')); setSource('tfda'); setDosageForm(match.observation.dosageForm);
    replaceCandidates(match.candidates); setSearched(true); setNotices(match.warnings); setError('');
    setCandidatePaging({ page: match.page, request: { kind: 'appearance', observation: match.observation } });
  }

  async function searchAppearance(observation: MedicationObservation, scanIndex?: number) {
    setBusy('match'); setError(''); replaceCandidates([]); setSearched(false); setNotices([]);
    try {
      const data = await matchMedications([observation]);
      if (mounted.current) {
        if (scanIndex !== undefined) setScanMatches(previous => previous.map((match, i) => i === scanIndex ? data.matches[0] : match));
        showMatch(data.matches[0]);
      }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(null); }
  }

  async function loadDemo() {
    setBusy('report'); setReportMode('local'); setError('');
    try {
      const result = await loadMedicationDemo();
      if (!mounted.current) return;
      setSelected(result.medications.map(entry => entry.drug)); setPatient(result.safety!.patient);
      setDemoId(result.demo!.id); setReport(result); acceptDatasets(result.datasets); setReportRefreshError(''); setExplanation(''); setSaved(false);
      updateQuery(''); setDosageForm(''); setScanMatches([]); setVisionResult(null); setOcrPages([]);
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(null); }
  }

  async function check(mode: ReportMode = 'local', drugs = selected, person = patient) {
    if (ageError(person.age)) { setError(ageError(person.age)!); return; }
    const keepPrevious = reportMatchesSelection(report, drugs, person, demoId);
    setReportMode(mode);
    setBusy('report'); setError(''); setReportRefreshError('');
    if (!keepPrevious) invalidateReport();
    try {
      const result = await queryMedicationReport(drugs.map(({ source, id }) => ({ source, id })), mode, person, demoId);
      if (mounted.current) { setReport(result); acceptDatasets(result.datasets); setDemoId(result.demo?.id); setExplanation(''); setSaved(false); }
    } catch (e) { if (mounted.current) (keepPrevious ? setReportRefreshError : setError)((e as Error).message || '查詢未完成，請重試。'); }
    finally { if (mounted.current) setBusy(null); }
  }

  function explain() {
    if (!report) return;
    setExplanation(summarizeMedicationReport(report, language)); setSaved(false);
  }

  async function save() {
    if (!report || busy || saving.current || saveDisabled || reportSaved) return;
    saving.current = true;
    saveAttempt.current = medicationSaveAttempt(reportContent, saveAttempt.current);
    setBusy('save'); setError('');
    try {
      await onSave(saveAttempt.current);
      if (mounted.current) setSaved(true);
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { saving.current = false; if (mounted.current) setBusy(null); }
  }

  return <div className="w-full space-y-6 pb-10" aria-busy={!!busy}>
    <div className="rounded-3xl border border-emerald-100 bg-white p-5 sm:p-8 shadow-sm">
      <div className="flex items-center gap-2 text-emerald-700 text-sm font-semibold"><ShieldCheck size={18} /> 有來源的藥物查詢</div>
      <h2 className="text-2xl font-bold text-slate-900 mt-2">拍下藥盒或藥錠，對照本機圖片</h2>
      <p className="text-sm text-slate-500 mt-2 leading-relaxed">藥盒與藥錠各有獨立圖片庫，選擇照片類型即可比對。OCR 可輔助讀取包裝、藥袋與 PDF 文字，不需 Gemini 金鑰；核對候選品項後，再查成分與交互作用。</p>
      <div className="flex flex-wrap gap-2 mt-4">
        {datasets.map(d => <span key={d.source} className={`text-xs rounded-full px-3 py-1.5 ${d.count ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
          {datasetNames[d.source]} · {d.count ? `${d.count.toLocaleString()} 筆` : '尚未載入'}
        </span>)}
      </div>
      {statusError && <p role="alert" className="text-sm text-amber-800 mt-3">{statusError}</p>}
      {!statusError && <MedicationDataSetup datasets={datasets} setup={dataSetup} />}
      <button type="button" className={`${secondary} mt-3`} disabled={statusLoading || !!busy} onClick={() => void refreshDatasets()}>{statusLoading ? '正在重新讀取…' : '重新讀取資料狀態'}</button>
    </div>

    <MedicationDemo disabled={!!busy} selectedCount={selected.length} onLoad={() => void loadDemo()} />

    <section ref={searchSection} className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 scroll-mt-6">
      <h3 className="font-bold text-slate-800">1. 掃描或輸入藥名、外觀</h3>
      <details open className="mt-4 rounded-xl border border-slate-200 p-4">
        <summary className="cursor-pointer text-sm font-medium">照片辨識與文字掃描</summary>
        <div className="mt-3 flex flex-wrap gap-3">
          <label className="text-xs text-slate-600">辨識方式<select aria-label="辨識方式" disabled={!!busy} value={scanEngine} onChange={e => { setScanEngine(e.target.value as ScanEngine); setOcrPages([]); setScanMatches([]); setVisionResult(null); replaceCandidates([]); setSearched(false); setNotices([]); setError(''); }} className="mt-1 block max-w-full rounded-lg border border-slate-300 bg-white p-2 text-sm">
            <option value="vision">藥錠照片比對（本機 CV，預設）</option><option value="package">藥盒照片比對（本機 CV）</option><option value="local">本機 OCR 讀文字（藥袋／外盒／PDF）</option><option value="gemini">Gemini 輔助（需金鑰、上傳雲端）</option>
          </select></label>
          {scanEngine === 'local' && <label className="text-xs text-slate-600">掃描內容<select aria-label="掃描內容" disabled={!!busy} value={ocrTarget} onChange={e => { setOcrTarget(e.target.value as OcrTarget); setOcrPages([]); }} className="mt-1 block rounded-lg border border-slate-300 bg-white p-2 text-sm">
            <option value="label">藥袋／外盒文字</option><option value="pill">單顆藥錠刻字</option>
          </select></label>}
        </div>
        {visualMode && <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3 text-sm">
          <p className="font-medium text-emerald-900">{activeVisionStatus?.ready ? scanEngine === 'package' ? `本機藥盒圖庫 · ${activeVisionStatus.productCount || 0} 種包裝品名／${activeVisionStatus.imageCount} 張圖` : `本機藥錠圖庫 · ${activeVisionStatus.drugCount.toLocaleString()} 種藥品／${activeVisionStatus.imageCount.toLocaleString()} 張圖` : activeVisionStatus?.reason || '正在確認本機圖片庫…'}</p>
          <button type="button" disabled={!!busy} onClick={() => void refreshVisionStatus()} className="mt-2 text-xs text-emerald-800 underline">重新檢查圖片庫</button>
          {!!activeVisionStatus?.personalImageCount && <p className="mt-2 text-xs text-slate-600">含 {activeVisionStatus.personalImageCount} 張使用者核對的自存照片，非官方參考圖。</p>}
          {activeVisionStatus?.personalWarning && <p className="mt-2 text-xs text-amber-800">{activeVisionStatus.personalWarning}</p>}
          <p className="mt-2 text-xs leading-relaxed text-slate-600">{scanEngine === 'package' ? '拍攝同一藥盒的正面或側面，保留完整盒身、品名與規格。此模式搜尋已收錄的包裝參考圖，預設同時讀取文字；核對品名後可直接查本機資料。' : '一次比對一種藥，可上傳正反面各一張。請先裁切多餘背景，讓整顆藥錠與刻字清楚可見。拍攝藥盒時請選「藥盒照片比對」。'}</p>
          <label className="mt-3 flex items-start gap-2 text-xs text-slate-700"><input type="checkbox" checked={readPhotoText} disabled={!!busy} onChange={event => setReadPhotoText(event.target.checked)} className="mt-0.5 accent-emerald-700" />同時用本機 OCR 讀取{scanEngine === 'package' ? '藥盒文字' : '刻字'}，核對後可直接查資料</label>
          {scanEngine === 'vision' && <><label className="mt-3 block text-xs text-slate-700">刻字（選填，完整一面刻字會另查本機資料）<input aria-label="核對藥錠刻字" maxLength={80} disabled={!!busy} value={visionImprint} onChange={event => { setVisionImprint(event.target.value); setVisionResult(null); clearSearchResults(); }} placeholder="例如 FY T061；不確定可先留空" className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2 text-sm" /></label>
          <button type="button" className="mt-2 text-xs text-emerald-800 underline disabled:opacity-50" disabled={!!busy || !visionImprint.trim()} onClick={() => void searchAppearance({ name: '', strength: '', dosageForm: '', appearance: { shape: '', color: '', imprints: [visionImprint.trim()] } })}>直接用完整刻字查本機資料</button></>}
          <p className="mt-2 text-xs leading-relaxed text-amber-900">{scanEngine === 'package' ? '只涵蓋已收錄藥盒，尚未收錄的包裝可用 OCR 查詢。包裝改版與相似配色可能誤配，請核對品名、規格與許可證。' : '背景與相似外觀可能造成錯誤排序；找不到時可直接用刻字查詢。'}圖片比對為試用功能，尚未完成獨立實拍照片的準確率驗證。</p>
        </div>}
        <p className="text-xs text-slate-500 mt-3 leading-relaxed">{visualMode ? '照片僅傳至此專案的服務運算，一般比對不會儲存上傳照片，也不送往外部 AI。不需要 Ollama 或金鑰。這是候選圖片檢索，仍需人工核對。' : scanEngine === 'local' ? '照片與 PDF 只在此瀏覽器讀取，不上傳雲端、不需要 Ollama。首次載入引擎可能較慢；每次最多 10 頁。OCR 讀取文字，不能僅憑外觀認定藥品。' : '按下 Gemini 輔助辨識，會將所選檔案傳送至 Google Gemini，讀取可見文字與外觀後比對本機資料。請先配置可用金鑰。'} 最多 {maxFiles} 檔；單檔 8 MB、合計 12 MB。</p>
        <input ref={fileInput} type="file" accept={ALLOWED_FILE_TYPES.filter(type => !visualMode || type !== 'application/pdf').join(',')} multiple className="hidden" aria-label="選擇藥物照片或 PDF"
          onChange={e => { if (e.target.files) void addFiles(Array.from(e.target.files)); e.target.value = ''; }} />
        <div className="flex flex-wrap gap-2 mt-3">
          <button className={secondary} disabled={!!busy || files.length >= maxFiles} onClick={() => fileInput.current?.click()}><Upload size={16} className="inline mr-2" />上傳檔案</button>
          <button className={secondary} disabled={!!busy || files.length >= maxFiles} onClick={openCamera}><Camera size={16} className="inline mr-2" />拍照</button>
          <button className={primary} disabled={!!busy || !files.length || (visualMode && !readPhotoText && !activeVisionStatus?.ready)} onClick={() => void extract()}>{busy === 'extract' ? '辨識中…' : visualMode && readPhotoText ? '比對照片並讀取文字' : scanEngine === 'vision' ? '開始照片比對' : scanEngine === 'package' ? '開始藥盒比對' : scanEngine === 'local' ? '開始本機 OCR' : '使用 Gemini 輔助辨識'}</button>
          {(busy === 'extract' || busy === 'reference') && scanEngine !== 'gemini' && <button className={secondary} onClick={() => scanController.current?.abort()}>{busy === 'reference' ? '取消收錄' : '取消辨識'}</button>}
        </div>
        {(busy === 'extract' || busy === 'reference') && <p role="status" className="mt-3 text-sm text-emerald-800">{scanEngine !== 'gemini' ? scanProgress : '正在使用 Gemini 辨識並比對本機資料…'}</p>}
        {!!scanWarnings.length && <div role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{scanWarnings.map(warning => <p key={warning}>{warning}</p>)}<p className="mt-1">已保留完成的部分，可核對結果後查詢，或重新辨識。</p></div>}
        {!!files.length && <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">{files.map(file => <div key={file.id} className="relative border rounded-xl p-2">
          {file.type === 'application/pdf' ? <FileText className="h-20 mx-auto text-slate-400" /> : <img src={file.data} alt={file.name} className="w-full h-20 object-contain" />}
          <p className="text-xs truncate mt-2">{file.name}</p>
          {file.type !== 'application/pdf' && <button type="button" disabled={!!busy} aria-label={`裁切 ${file.name}`} onClick={() => setCropId(file.id)} className="mt-1 text-xs text-emerald-800 underline">裁切照片</button>}
          <button className="absolute top-1 right-1 bg-white rounded-full p-1 shadow" aria-label={`移除 ${file.name}`} disabled={!!busy} onClick={() => { setFiles(files.filter(f => f.id !== file.id)); setScanMatches([]); setOcrPages([]); setVisionResult(null); replaceCandidates([]); setSearched(false); setNotices([]); }}><X size={14} /></button>
        </div>)}</div>}
        {scanEngine === 'vision' && <section aria-label="Ollama 外觀輔助" className="mt-4 rounded-xl border border-sky-200 bg-sky-50/50 p-4">
          <p className="text-sm font-semibold text-slate-800">照片難以比對？讓本機 AI 協助讀外觀</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">選用功能，需啟動本機 Ollama 並使用支援圖片的模型。照片送至本專案後端的本機模型，不送 Gemini；先讀顏色、形狀與刻字，再由您核對後查本機資料。一般 CV／OCR 不需要 Ollama。</p>
          <button type="button" className={`${secondary} mt-3`} disabled={!!busy || !files.length} onClick={() => void observePill()}>使用 Ollama 外觀輔助</button>
          {observedPill && <><p className="mt-3 text-xs text-slate-500">{observedPill.model} · {dateText(observedPill.checkedAt)}</p><AppearanceSearch key={observedPill.checkedAt} initial={observedPill.observation.appearance} disabled={!!busy} onEdit={clearSearchResults} onSearch={observation => void searchAppearance(observation)} /></>}
        </section>}
        {!!ocrPages.length && <div ref={ocrHeading} className="scroll-mt-6"><OcrReview pages={ocrPages} target={scanEngine === 'vision' ? 'pill' : scanEngine === 'package' ? 'label' : ocrTarget} disabled={!!busy}
          onChange={(index, text) => updateOcrPage(index, page => ({ ...page, text }))} onSwitchReading={index => updateOcrPage(index, switchOcrReading)}
          onSearch={searchOcrLine} onQueryEdit={clearSearchResults} /></div>}
        {scanEngine === 'package' && <PackageReferenceForm key={files.map(file => file.id).join(',')} disabled={!!busy} photoCount={files.filter(file => file.type !== 'application/pdf').length} onSave={(name, note) => void registerPackage(name, note)} />}
        {scanEngine === 'vision' && <PillReferenceLibrary key={files.map(file => file.id).join(',') + selected.map(pillReferenceIdentity).join(',')} selected={selected} photoCount={files.filter(file => file.type !== 'application/pdf').length} disabled={!!busy} library={personalLibrary}
          onSave={registerPill} onRefresh={() => void refreshVisionStatus()} onDisable={key => void updatePersonalLibrary(`/api/medications/vision/personal-references/${key}/disable`, {}, '已停用這張照片，後續不再用於比對；其他參考圖保持可用。')} />}
        <div ref={visionHeading} className="scroll-mt-6">{visionResult && <VisionResults result={visionResult} disabled={!!busy} onImprintSearch={input => void searchAppearance({ name: '', strength: '', dosageForm: '', appearance: { shape: '', color: '', imprints: [input] } })} onPackage={() => { setScanEngine('package'); setVisionResult(null); void extract('package', 'label'); }} onOcr={() => void extract('local', 'pill')} onLabelOcr={() => { setScanEngine('local'); setOcrTarget('label'); setVisionResult(null); void extract('local', 'label'); }} onReview={drug => { searchVersion.current++; replaceCandidates([drug]); setSearched(true); setNotices(['您正在核對候選，請確認品名、規格與實際包裝後再分析。']); setQuery(drug.name); setSource('tfda'); setDosageForm(drug.dosageForm); }} />}</div>
        <ObservationReview matches={scanMatches} disabled={!!busy} formListId={formListId} onSelect={showMatch}
          onSearch={(observation, index) => void searchAppearance(observation, index)}
          onEdit={clearSearchResults} />
      </details>
      <AppearanceSearch disabled={!!busy} onEdit={clearSearchResults} onSearch={observation => void searchAppearance(observation)} />
      <datalist id={formListId}>{dosageForms.map(form => <option key={form} value={form} />)}</datalist>
      <form className="mt-4 space-y-3" onSubmit={e => { e.preventDefault(); if (!busy) void search(); }}>
        <div className="flex flex-col sm:flex-row gap-2">
        <select aria-label="藥名資料來源" value={source} disabled={!!busy} onChange={e => updateSource(e.target.value as DrugSource)} className="rounded-xl border border-slate-300 p-3 text-sm">
          <option value="tfda">本機臺灣藥品（中英文）</option><option value="rxnorm">線上英文成分／美國品名</option>
        </select>
        <input aria-label="搜尋藥名" value={query} disabled={!!busy} maxLength={120} onChange={e => updateQuery(e.target.value)} placeholder={source === 'tfda' ? '輸入中文品名、英文名或許可證字號' : '例如 acetaminophen'} className="min-w-0 flex-1 rounded-xl border border-slate-300 p-3 text-sm focus:outline-emerald-600" />
        <button type="submit" className={primary} disabled={!!busy || query.trim().length < 2}><Search size={16} className="inline mr-1" />搜尋</button>
        </div>
        {source === 'tfda' && <label className="block text-xs text-slate-600">
          劑型（選填，依資料庫細分類）
          <input aria-label="篩選劑型" value={dosageForm} list={formListId} disabled={!!busy} maxLength={120} onChange={e => updateDosageForm(e.target.value)}
            placeholder="例如：膜衣錠；留空查全部劑型" className="mt-1 block w-full rounded-xl border border-slate-300 p-3 text-sm text-slate-800 focus:outline-emerald-600" />
          <span className="mt-1 block">錠劑、膜衣錠等分開查詢；不確定時可清空，再核對候選。</span>
        </label>}
      </form>
      <div ref={candidateSection} className="scroll-mt-6">
      {notices.map(n => <p key={n} className="mt-3 text-sm text-amber-800">{n}</p>)}
      {searched && !candidates.length && <p className="mt-4 text-sm text-slate-600">未找到品項。請核對拼字、改用成分名稱或切換資料來源；不代表此藥不存在。</p>}
      {searched && !candidates.length && canSuggestName(suggestionQuery) && <section aria-label="相近品名建議" className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
        <p className="font-medium text-slate-800">可能是品名拼字不同</p>
        <p className="mt-1 text-slate-600">最多列出 8 個相差一個字的本機品名寫法，排序不代表正確率。請對照原圖或藥袋，選擇後才重新搜尋，劑型篩選會保留；不會自動確認藥品。</p>
        {nameSuggestions === null ? <button type="button" disabled={!!busy} onClick={() => void suggestNames()} className={`${secondary} mt-3`}>查詢相近品名</button> :
          nameSuggestions.length ? <div className="mt-3 flex flex-wrap gap-2">{nameSuggestions.map(name => <button type="button" key={name} disabled={!!busy} className={secondary}
            onClick={() => { updateQuery(name); setSource('tfda'); void search(name, 'tfda'); }}>改查「{name}」</button>)}</div> :
            <p className="mt-3 text-slate-600">沒有找到可用的相近寫法；請對照原圖校正，或改用完整許可證字號。</p>}
      </section>}
      {candidatePaging && <div aria-label="藥品搜尋分頁" className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-sm text-slate-600">{candidatePaging.page.total === null ? `本次列出 ${candidates.length} 筆候選` :
          candidates.length ? `第 ${candidatePaging.page.offset + 1}–${candidatePaging.page.offset + candidates.length} 筆，共 ${candidatePaging.page.total} 筆` : `本頁 0 筆，共 ${candidatePaging.page.total} 筆`}</p>
        {candidatePaging.page.total !== null && candidatePaging.page.total > candidatePaging.page.limit && <div className="flex gap-2">
          <button type="button" className={secondary} disabled={!!busy || candidatePaging.page.offset === 0} onClick={() => void changeCandidatePage(Math.max(0, candidatePaging.page.offset - candidatePaging.page.limit))}>上一頁候選</button>
          <button type="button" className={secondary} disabled={!!busy || !candidatePaging.page.hasMore} onClick={() => void changeCandidatePage(candidatePaging.page.offset + candidatePaging.page.limit)}>下一頁候選</button>
        </div>}
      </div>}
      {candidatePageError && <div role="alert" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <p>{candidatePageError} 目前保留上一頁已取得的候選。</p>
        <button type="button" disabled={!!busy} className={`${secondary} mt-2`} onClick={() => void changeCandidatePage(0, true)}>重新查詢候選</button>
      </div>}
      {!!candidates.length && <div className="mt-4 max-h-96 overflow-y-auto space-y-3">{candidates.map(drug => {
        const chosen = selected.some(d => d.source === drug.source && d.id === drug.id);
        return <div key={`${drug.source}:${drug.id}`} className="rounded-xl border border-slate-200 p-4 flex flex-col sm:flex-row gap-3 sm:items-start">
          <div className="min-w-0 flex-1 break-words"><p className="font-semibold">{drug.name}</p>
            {drug.englishName !== drug.name && <p className="text-xs text-slate-500 mt-1">{drug.englishName}</p>}
            <p className="text-xs text-slate-600 mt-2">{drug.dosageForm} {drug.manufacturer && ` · ${drug.manufacturer}`}</p>
            {drug.ingredients.length > 0 && <p className="text-xs text-slate-600 mt-1">成分：{drug.ingredients.join('、')}</p>}
            {drug.indications && <p className="text-xs text-slate-600 mt-2 leading-relaxed">用途（來源原文）：{drug.indications}</p>}
            {drug.appearanceOnly && <p className="text-xs text-amber-800 mt-2">此筆只有外觀紀錄，尚未接上藥品主檔，不能據此分析成分。</p>}
            {drug.appearance && <DrugAppearanceDetails appearance={drug.appearance} drugName={drug.name} licenseId={drug.id} />}
            <p className="text-xs text-slate-500 mt-1">{drug.source.toUpperCase()} · {drug.id}</p>
            {drug.licenseStatus && <p className={`text-xs mt-1 ${drug.licenseStatus !== '未標示註銷' ? 'text-amber-800' : 'text-slate-500'}`}>{drug.licenseStatus} · 有效日期 {drug.validUntil || '未提供'}</p>}
          </div>
          <button className={chosen ? secondary : primary} disabled={!!busy || chosen || selected.length >= 6} onClick={() => { const next = [...selected, drug]; setSelected(next); invalidateReport(); if (next.every(item => item.source === 'tfda')) void check('local', next); }}>{chosen ? '已確認' : drug.source === 'tfda' && selected.every(item => item.source === 'tfda') ? '確認並分析' : '確認這個品項'}</button>
        </div>;
      })}</div>}
      </div>
    </section>

    <section ref={selectionSection} className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 scroll-mt-6">
      <h3 className="font-bold text-slate-800">2. 確認查詢清單 <span className="text-sm font-normal text-slate-500">{selected.length} / 6</span></h3>
      <MedicationPatientField patient={patient} disabled={!!busy} demo={!!demoId}
        onChange={value => { setPatient(value); invalidateReport(); }}
        onCompare={value => { setPatient(value); void check('local', selected, value); }} />
      {!selected.length ? <p className="text-sm text-slate-500 mt-3">請先搜尋，並確認要查詢的藥品。可以加入多個品項比較成分。</p> : <ul className="mt-3 divide-y divide-slate-100">{selected.map(drug => <li key={`${drug.source}:${drug.id}`} className="py-3 flex items-start gap-3">
        <Check size={18} className="text-emerald-600 shrink-0 mt-0.5" /><div className="flex-1 min-w-0"><p className="text-sm font-semibold break-words">{drug.name}</p><p className="text-xs text-slate-500">{drug.dosageForm} · {drug.id}</p></div>
        <button className="p-1 text-slate-500 hover:text-red-600" aria-label={`移除 ${drug.name}`} disabled={!!busy} onClick={() => { setSelected(selected.filter(d => d !== drug)); setDemoId(undefined); invalidateReport(); }}><Trash2 size={16} /></button>
      </li>)}</ul>}
      <div className="flex flex-wrap gap-2 mt-4"><button className={primary} disabled={!!busy || !selected.length || selected.some(drug => drug.source !== 'tfda')} onClick={() => void check('local')}>用本機資料分析</button>
        <button className={secondary} disabled={!!busy || !selected.length} onClick={() => void check('online')}>補查線上仿單與標準名稱</button></div>
      <p className="text-xs text-slate-500 mt-2">本機分析不呼叫外部查藥 API。選擇線上補查才會將藥名／成分傳送至 NLM、openFDA；RxNorm 品項需使用線上補查。</p>
    </section>

    {busy && busy !== 'extract' && <div role="status" className="flex items-center gap-2 text-sm text-emerald-800"><Loader2 size={16} className="animate-spin" />{busy === 'report' ? reportMode === 'local' ? '正在讀取本機成分與交互作用資料…' : '正在補查線上資料，首次查詢可能需要一些時間…' : '處理中…'}</div>}
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 break-words">{error}</div>}

    {report && <section className="space-y-5" aria-label="藥物查詢結果">
      {reportRefreshError && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="font-semibold">這次更新失敗，以下保留上次成功的查詢結果。</p>
        <p className="mt-1">{reportRefreshError} 結果仍採原查詢時間，並非本次更新成功。</p>
        <button type="button" disabled={!!busy} className={`${secondary} mt-3`} onClick={() => void check(reportMode)}>重試這次查詢</button>
      </div>}
      {busy === 'report' && <p role="status" className="text-sm text-slate-600">更新中，以下暫時顯示上次成功的結果。</p>}
      <div className="flex flex-wrap justify-between gap-3 items-center"><div><h3 ref={resultHeading} tabIndex={-1} className="font-bold text-xl outline-none scroll-mt-6">3. 查詢重點</h3><p className="text-xs text-slate-500 mt-1">{report.mode === 'local' ? '本機資料分析' : '含線上補查'} · {report.medications.length} 款藥 · {dateText(report.checkedAt)}</p></div>
        <div className="flex flex-wrap gap-2"><button className={secondary} onClick={() => selectionSection.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>調整年齡／查詢清單</button><button className={secondary} onClick={() => searchSection.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>加入其他藥品</button><button className={secondary} disabled={!!busy || saveDisabled || reportSaved} onClick={save}>{reportSaved ? '已儲存至對話' : '儲存報告至對話'}</button></div>
      </div>
      <MedicationResults report={report} onPackageChange={() => void refreshVisionStatus()} />
      <details className="rounded-2xl border border-slate-200 bg-white p-5">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">需要其他語言？整理查詢摘要</summary><p className="text-xs text-slate-500 mt-2">依查詢結果整理，保留未查得紀錄與資料不足的部分。</p>
        <div className="flex flex-wrap gap-2 mt-3"><select aria-label="摘要語言" className="border border-slate-300 rounded-xl p-2 text-sm" value={language} disabled={!!busy} onChange={e => { setLanguage(e.target.value); setExplanation(''); setSaved(false); }}>
          {['繁體中文', 'English', '日本語', 'Tiếng Việt'].map(lang => <option key={lang}>{lang}</option>)}
        </select><button className={secondary} disabled={!!busy} onClick={explain}>整理查詢摘要</button></div>
        {explanation && <div className="mt-4"><MarkdownContent>{explanation}</MarkdownContent></div>}
      </details>
      <details className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600"><summary className="cursor-pointer font-medium">資料版本、涵蓋範圍與授權</summary>{report.datasets.map(d => <div key={d.source} className="mt-3 space-y-1 break-words"><a href={d.sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-800 underline">{datasetNames[d.source]}</a><p>匯入：{dateText(d.importedAt)} · {d.count.toLocaleString()} 筆</p><p>{d.coverage}</p><p>{d.fileName}</p><p>{d.license}</p></div>)}</details>
    </section>}

    {cropId && files.find(file => file.id === cropId) && <PhotoCropDialog data={files.find(file => file.id === cropId)!.data} onClose={() => setCropId(null)} onApply={data => { setFiles(previous => previous.map(file => file.id === cropId ? { ...file, id: crypto.randomUUID(), data, name: file.name.replace(/\.[^.]+$/, '') + '-裁切.jpg', type: 'image/jpeg', size: Math.ceil(data.split(',')[1].length * 3 / 4) } : file)); setVisionResult(null); setOcrPages([]); setScanMatches([]); replaceCandidates([]); setSearched(false); setNotices([]); }} />}
    {cameraOpen && <CameraDialog onCapture={file => void addFiles([file])} onClose={() => setCameraOpen(false)} />}
  </div>;
}
