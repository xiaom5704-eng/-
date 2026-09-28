import { Router, type Response } from 'express';
import { datasetStatus, getTfda, searchLocalCandidates, type DrugDatabase } from './store';
import { DrugProviders } from './providers';
import type { DrugSelection } from '../../shared/medication';
import { localAppearanceOptions, matchObservation, validObservations } from './appearance';
import { VisionService } from '../vision/service';
import { visionRouter } from '../vision/router';
import { PackageVisionService } from '../vision/packages';
import { OfficialPackageReferences } from '../vision/official-packages';
import { officialPackageRouter } from '../vision/official-package-router';
import { PersonalPillReferences } from '../vision/personal-pills';
import { personalPillRouter } from '../vision/personal-pill-router';
import { pillObserverRouter } from '../vision/observer';
import { caseProducts, infantDemo, matchesCaseProduct, validMedicationPatient } from '../../shared/medication-safety';
import { parsePageOptions, SearchSnapshotChanged } from './search-index';
import { measurementSearchNotice } from './search-measurements';
import { localDosageForms, dosageFormSearchNotice } from './dosage-forms';
import { LocalMedicationImages } from './local-images';
import { suggestLocalNames } from './name-suggestions';
import { suggestLocalImprints } from './imprint-suggestions';
import type { MedicationReport } from '../../shared/medication';
import { attachSourceDocuments, readSourceDocument } from './source-documents';
import { missingLocalNames, type LocalDataSetup } from '../../shared/local-data';
import { TfdaDocuments, tfdaDocumentRouter } from './tfda-documents';

export function validSelections(value: unknown): value is DrugSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return false;
  const keys = new Set<string>();
  return value.every(item => {
    if (!item || !['tfda', 'rxnorm'].includes(item.source) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 80) return false;
    if (item.source === 'rxnorm' && !/^\d+$/.test(item.id)) return false;
    const key = `${item.source}:${item.id}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

export function medicationRouter(db: DrugDatabase, providers = new DrugProviders(db), localImages = new LocalMedicationImages(db), dataSetup?: () => LocalDataSetup) {
  const router = Router();
  const documents = new TfdaDocuments(db);
  router.use('/tfda-documents', tfdaDocumentRouter(documents));
  const requireLocalNames = (res: Response) => {
    const { available } = db.prepare('SELECT EXISTS(SELECT 1 FROM tfda_drugs) OR EXISTS(SELECT 1 FROM tfda_appearances) AS available').get() as { available: number };
    if (!available) res.status(503).json({ error: missingLocalNames });
    return !!available;
  };
  const reportImages = (report: MedicationReport) => {
    const drugs = localImages.attach(report.medications.map(entry => entry.drug));
    return documents.attach(attachSourceDocuments(db, { ...report, medications: report.medications.map((entry, i) => ({ ...entry, drug: drugs[i] })) }));
  };
  const visionQueue = { busy: false };
  const personalPills = new PersonalPillReferences(db);
  const pillVision = new VisionService(db, undefined, undefined, undefined, undefined, 'pill', personalPills);
  router.use('/vision/observe', pillObserverRouter(visionQueue));
  router.use('/vision', personalPillRouter(personalPills, pillVision, visionQueue));
  router.use('/vision', visionRouter(pillVision, visionQueue));
  const officialPackages = new OfficialPackageReferences(db);
  router.use('/packages', officialPackageRouter(officialPackages, visionQueue));
  router.use('/packages', visionRouter(new PackageVisionService(db, undefined, undefined, undefined, undefined, officialPackages), visionQueue));
  router.get('/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ datasets: datasetStatus(db), dosageForms: localDosageForms(db), appearanceOptions: localAppearanceOptions(db), dataSetup: dataSetup?.() });
  });
  router.get('/name-suggestions', (req, res) => {
    const query = req.query.q, form = req.query.dosageForm ?? '';
    if (typeof query !== 'string' || query.length > 120 || typeof form !== 'string' || form.length > 120) {
      res.status(400).json({ error: '請提供有效的藥名與劑型。' }); return;
    }
    try { if (requireLocalNames(res)) res.json(suggestLocalNames(db, query, form)); }
    catch { res.status(503).json({ error: '本機相近品名查詢未完成，請稍後重試。' }); }
  });
  router.post('/imprint-suggestions', (req, res) => {
    if (!validObservations([req.body?.observation])) { res.status(400).json({ error: '請提供有效的刻字與外觀查詢條件。' }); return; }
    try {
      if (!requireLocalNames(res)) return;
      const { available } = db.prepare('SELECT EXISTS(SELECT 1 FROM tfda_appearances) AS available').get() as { available: number };
      if (!available) { res.status(503).json({ error: '本機藥品外觀資料尚未安裝，請先安裝資料包或匯入 TFDA 外觀 CSV，再查刻字。' }); return; }
      res.json(suggestLocalImprints(db, req.body.observation));
    }
    catch { res.status(503).json({ error: '本機刻字對照未完成，請稍後重試。' }); }
  });
  router.get('/source-documents/:filename', (req, res) => {
    const match = /^([a-f0-9]{64})\.(pdf|json)$/.exec(req.params.filename);
    const document = match && readSourceDocument(db, match[1]);
    if (!document) { res.status(404).json({ error: '此版本的本機仿單副本尚未保存或已損毀，請核對原始來源。' }); return; }
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (match[2] === 'json') { res.json({ ...document.metadata, title: document.title, sourceUrl: document.sourceUrl }); return; }
    res.setHeader('Content-Disposition', `inline; filename="source-${match[1]}.pdf"`);
    res.type('application/pdf').send(document.pdf);
  });
  router.get('/reference-images/:filename', (req, res) => {
    const match = /^([a-f0-9]{64})\.webp$/.exec(req.params.filename);
    const file = match && localImages.fileFor(match[1]);
    if (!file) { res.status(404).json({ error: '本機參考圖已失效或尚未收錄，請核對來源圖片。' }); return; }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(file);
  });
  router.post('/demo', async (_req, res) => {
    try {
      const drugs = caseProducts.map(spec => getTfda(db, spec.id));
      if (drugs.some((drug, index) => !drug || !matchesCaseProduct(drug, caseProducts[index]))) {
        res.status(409).json({ error: '示範品項缺少本機紀錄或成分已變動，請更新資料並人工核對，不能載入不完整案例。' }); return;
      }
      const report = await providers.report(drugs, 'local', { age: { value: '1', unit: 'months' }, premature: 'unknown' });
      res.json({ ...reportImages(report), demo: infantDemo });
    } catch { res.status(503).json({ error: '本機示範資料讀取失敗，請稍後重試。' }); }
  });
  router.post('/match', (req, res) => {
    if (!validObservations(req.body?.observations)) { res.status(400).json({ error: '請提供 1–6 筆有效的藥名或外觀特徵。' }); return; }
    const page = parsePageOptions(req.body.offset, req.body.revision);
    if (!page || (page.offset && req.body.observations.length !== 1)) { res.status(400).json({ error: '分頁格式無效；翻頁時請選定一筆辨識結果。' }); return; }
    try { if (requireLocalNames(res)) res.json({ matches: req.body.observations.map(observation => { const match = matchObservation(db, observation, page); return { ...match, candidates: localImages.attach(match.candidates) }; }) }); }
    catch (error) { res.status(error instanceof SearchSnapshotChanged ? 409 : 500).json({ error: error instanceof SearchSnapshotChanged ? error.message : '本機外觀比對失敗，請確認資料已完整匯入。' }); }
  });
  router.get('/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const source = req.query.source || 'tfda';
    const dosageForm = req.query.dosageForm ?? '';
    if (query.length < 2 || query.length > 120 || typeof source !== 'string' || !['tfda', 'rxnorm'].includes(source)) {
      res.status(400).json({ error: '請輸入 2–120 個字的藥名，並選擇資料來源。' }); return;
    }
    const page = parsePageOptions(req.query.offset, req.query.revision);
    if (typeof dosageForm !== 'string' || dosageForm.length > 120 || (source !== 'tfda' && dosageForm.trim())) {
      res.status(400).json({ error: '劑型篩選限本機查詢，請提供不超過 120 字的劑型。' }); return;
    }
    if (!page || (source === 'rxnorm' && (page.offset || page.revision))) { res.status(400).json({ error: '分頁格式無效；線上 RxNorm 查詢只提供有限候選。' }); return; }
    try {
      if (source === 'tfda') {
        if (!requireLocalNames(res)) return;
        const result = searchLocalCandidates(db, query, undefined, { ...page, dosageForm });
        const warnings = ['依關鍵字尋找候選，名稱的簡繁字形、空格與部分標點會一併搜尋；請核對原始完整品名、規格及許可證。', ...measurementSearchNotice(query), ...dosageFormSearchNotice(db, dosageForm)];
        if (!datasetStatus(db)[0].count) warnings.push('臺灣藥品主檔尚未載入，目前可能只有外觀紀錄，請由管理者更新資料。');
        res.json({ ...result, candidates: localImages.attach(result.candidates), warnings });
      } else {
        const candidates = await providers.searchRxnorm(query);
        res.json({ candidates, warnings: ['線上來源最多列出 20 個候選，並非全部結果；請輸入完整成分或品名縮小範圍。'],
          page: { offset: 0, limit: 20, total: null, hasMore: false } });
      }
    } catch (error) { res.status(error instanceof SearchSnapshotChanged ? 409 : 503).json({ error: error instanceof SearchSnapshotChanged ? error.message : source === 'tfda' ? '本機藥品搜尋失敗，請確認資料已完整匯入；此情況不代表查無藥品。' : '標準藥名服務暫時無法連線，請稍後再試；此情況不代表查無藥品。' }); }
  });
  router.post('/report', async (req, res) => {
    if (!validSelections(req.body?.drugs)) { res.status(400).json({ error: '請選擇 1–6 種不重複、已確認的藥品。' }); return; }
    if (req.body.patient !== undefined && !validMedicationPatient(req.body.patient)) {
      res.status(400).json({ error: '請輸入有效的年齡、單位及早產狀況。' }); return;
    }
    const mode = req.body.mode || 'local';
    if (!['local', 'online'].includes(mode)) { res.status(400).json({ error: '查詢模式無效。' }); return; }
    if (mode === 'local' && req.body.drugs.some(drug => drug.source !== 'tfda')) {
      res.status(400).json({ error: '本機分析適用臺灣藥品；RxNorm 品項請選擇線上補查。' }); return;
    }
    try {
      const drugs = [];
      for (const selection of req.body.drugs) {
        const drug = selection.source === 'tfda' ? getTfda(db, selection.id) : await providers.getRxnorm(selection.id);
        if (!drug) { res.status(400).json({ error: '藥品已失效或不存在，請重新搜尋並確認。' }); return; }
        if (drug.ingredients.length > 20) { res.status(422).json({ error: '此品項成分過多，請交由藥師逐項核對。' }); return; }
        drugs.push(drug);
      }
      const report = await providers.report(drugs, mode, req.body.patient);
      if (req.body.demoId === infantDemo.id && drugs.length === caseProducts.length && caseProducts.every(spec => drugs.some(drug => matchesCaseProduct(drug, spec)))) report.demo = infantDemo;
      res.json(reportImages(report));
    } catch { res.status(503).json({ error: mode === 'local' ? '本機資料讀取失敗，請確認資料庫與服務狀態後重試；此情況不代表查無紀錄。' : '資料查詢未完成，請確認服務與連線狀態後重試；此情況不代表查無紀錄。' }); }
  });
  return router;
}
