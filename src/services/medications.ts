import type { DatasetStatus, DrugSearchResult, DrugSelection, DrugSource, MedicationReport, MedicationMatch, MedicationObservation, ReportMode } from '../../shared/medication';
import { requestJson as request, sendJson } from './http';
import type { MedicationPatient } from '../../shared/medication-safety';

export const getMedicationStatus = () => request<{ datasets: DatasetStatus[]; dosageForms: string[] }>('/api/medications/status');
export const searchMedications = (query: string, source: DrugSource, offset = 0, revision?: string, dosageForm = '') =>
  request<DrugSearchResult>(`/api/medications/search?${new URLSearchParams({ q: query, source, offset: String(offset), ...(revision ? { revision } : {}), ...(dosageForm.trim() ? { dosageForm: dosageForm.trim() } : {}) })}`);
export const queryMedicationReport = (drugs: DrugSelection[], mode: ReportMode = 'local', patient?: MedicationPatient, demoId?: string) => sendJson<MedicationReport>('/api/medications/report', { drugs, mode, patient, demoId });
export const loadMedicationDemo = () => sendJson<MedicationReport>('/api/medications/demo', {});
export const matchMedications = (observations: MedicationObservation[], offset = 0, revision?: string) => sendJson<{ matches: MedicationMatch[] }>('/api/medications/match', { observations, offset, revision });
