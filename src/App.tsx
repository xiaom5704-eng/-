import React, { useState, useEffect, useRef, useCallback } from 'react';
import MarkdownContent from './components/MarkdownContent';
import SpokenAnswer from './components/SpokenAnswer';
import { 
  Plus, 
  MessageSquare, 
  Trash2, 
  Send, 
  History, 
  ChevronRight, 
  Stethoscope, 
  Pill, 
  AlertCircle,
  Loader2,
  X,
  Pin,
  MoreVertical,
  Edit2,
  Mic
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Session, Message } from './types';
import MedicationPanel from './components/MedicationPanel';
import ConsultationAgeField from './components/ConsultationAgeField';
import { ageError, withConsultationAge, type ConsultationAge } from '../shared/consultation';
import { getSymptomAdvice, chatWithAI, generateTitleSummary, testGeminiKey } from './services/gemini';
import { requestJson, sendJson } from './services/http';
import { browserSpeechEnvironment, createSpeechController } from './services/speech';
import { readPendingReplies, writePendingReplies, savePendingReply, type PendingReplies, type PendingReply } from './services/pending-replies';
import { unansweredQuestion } from '../shared/conversation-retry';
import { medicationReportQuestion, type MedicationSaveAttempt } from '../shared/medication-save';

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);
  const [consultationAge, setConsultationAge] = useState<ConsultationAge>({ value: '', unit: 'years' });
  const [consultationRevision, setConsultationRevision] = useState(0);
  const [symptomText, setSymptomText] = useState('');
  const invalidAge = ageError(consultationAge);

  const selectSession = (id: string | null, preserveDraft = false) => {
    if (window.matchMedia('(max-width: 767px)').matches) setIsSidebarOpen(false);
    if (id !== currentSessionIdRef.current && !preserveDraft) {
      generationRef.current?.abort();
      speechRef.current?.cancel();
      setConsultationAge({ value: '', unit: 'years' });
      setSymptomText('');
      setConsultationRevision(revision => revision + 1);
    }
    if (id !== currentSessionIdRef.current) {
      setIsHistoryLoading(!!id);
      setHistoryError(null);
    }
    currentSessionIdRef.current = id;
    setCurrentSessionId(id);
  };
  const messagesRequestRef = useRef(0);
  const sessionsRequestRef = useRef(0);
  const pendingAIRef = useRef(false);
  const generationRef = useRef<AbortController | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const beginGeneration = () => {
    const controller = new AbortController();
    generationRef.current = controller;
    setIsGenerating(true);
    return controller;
  };
  const finishGeneration = (controller: AbortController) => {
    if (generationRef.current !== controller) return;
    generationRef.current = null;
    setIsGenerating(false);
  };
  useEffect(() => () => { generationRef.current?.abort(); }, []);
  const pendingTitlesRef = useRef(new Set<string>());
  const deletedSessionsRef = useRef(new Set<string>());
  const pendingReplySection = useRef<HTMLElement>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingReplies, setPendingReplies] = useState(() => readPendingReplies(() => window.sessionStorage));
  const pendingRepliesRef = useRef(pendingReplies);
  const [pendingStorageReady, setPendingStorageReady] = useState(true);
  const [savedMedicationRequestId, setSavedMedicationRequestId] = useState<string>();
  const [savedMedicationSessionId, setSavedMedicationSessionId] = useState<string>();
  const pendingReply = currentSessionId && Object.hasOwn(pendingReplies, currentSessionId) ? pendingReplies[currentSessionId] : null;
  const pendingNewReports = Object.values(pendingReplies).filter(reply => reply.kind === 'medication' && reply.newSessionTitle && !sessions.some(session => session.id === reply.sessionId));
  const retryableQuestion = unansweredQuestion(messages, currentSessionId);
  const updatePendingReplies = (change: (previous: PendingReplies) => PendingReplies) => {
    const next = change(pendingRepliesRef.current);
    pendingRepliesRef.current = next;
    setPendingReplies(next);
    setPendingStorageReady(writePendingReplies(() => window.sessionStorage, next));
  };
  const [symptomResponse, setSymptomResponse] = useState<{ sessionId: string; content: string } | null>(null);
  const symptomResult = symptomResponse?.sessionId === currentSessionId ? symptomResponse.content : null;
  const showError = (error: unknown) => setActionError(error instanceof Error ? error.message : '操作失敗，請稍後重試。');

  const [isListening, setIsListening] = useState(false);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const speechRef = useRef<ReturnType<typeof createSpeechController> | null>(null);
  const speak = (text: string, key: string) => speechRef.current?.toggleSpeech(text, key);
  const stopAnswerSpeech = useCallback((key: string) => speechRef.current?.stopSpeaking(key), []);
  useEffect(() => {
    const speech = createSpeechController(browserSpeechEnvironment(window), {
      onListening: setIsListening, onSpeaking: setSpeakingKey, onError: setActionError,
      onTranscript: text => setInputText(previous => previous + text),
    });
    speechRef.current = speech;
    return () => { speech.cancel(); speechRef.current = null; };
  }, []);
  const [activeTab, setActiveTab] = useState<'chat' | 'medication' | 'symptoms'>('chat');
  const [medicationVisited, setMedicationVisited] = useState(false);
  const changeTab = (tab: typeof activeTab) => {
    if (tab !== activeTab) speechRef.current?.cancel();
    if (tab === 'medication') setMedicationVisited(true);
    setActiveTab(tab);
  };
  const [symptomMode, setSymptomMode] = useState<'concise' | 'detailed'>('concise');
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth >= 768);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 767px)');
    const onResize = () => { if (compact.matches) setIsSidebarOpen(false); };
    compact.addEventListener('change', onResize);
    return () => compact.removeEventListener('change', onResize);
  }, []);
  const closeSidebar = () => { setIsSidebarOpen(false); sidebarToggle.current?.focus(); };
  useEffect(() => {
    if (!isSidebarOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && window.matchMedia('(max-width: 767px)').matches) closeSidebar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSidebarOpen]);
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [renamingSession, setRenamingSession] = useState<Session | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [userApiKey, setUserApiKey] = useState('');
  const [isOllamaOnline, setIsOllamaOnline] = useState<boolean | null>(null);
  const [ollamaModel, setOllamaModel] = useState<string | null>(null);
  const [isGeminiValid, setIsGeminiValid] = useState<boolean>(false);
  const [selectedEngine, setSelectedEngine] = useState<'gemini' | 'ollama'>(import.meta.env.VITE_GEMINI_API_KEY ? 'gemini' : 'ollama');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  const handleEngineChange = (engine: 'gemini' | 'ollama') => {
    if (engine === 'gemini') {
      const hasKey = userApiKey || import.meta.env.VITE_GEMINI_API_KEY;
      if (!hasKey) {
        alert('請先配置 API 金鑰以啟用 Gemini');
        setShowApiKeyInput(true);
        setSelectedEngine('ollama');
        return;
      }
    }
    setSelectedEngine(engine);
  };
  const [isTestingKey, setIsTestingKey] = useState(false);
  const [keyTestResult, setKeyTestResult] = useState<'success' | 'error' | null>(null);
  const [keyTestError, setKeyTestError] = useState('');
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [showDisclaimerModal, setShowDisclaimerModal] = useState(() => {
    const lastAccepted = localStorage.getItem('disclaimerAcceptedAt');
    if (lastAccepted) {
      const lastAcceptedTime = parseInt(lastAccepted, 10);
      const now = Date.now();
      const twentyFourHours = 24 * 60 * 60 * 1000;
      if (now - lastAcceptedTime < twentyFourHours) {
        return false;
      }
    }
    return true;
  });
  const [apiMetrics, setApiMetrics] = useState({
    totalRequests: 0,
    successfulRequests: 0,
    totalLatencyMs: 0
  });

  const trackApiCall = async <T,>(apiCall: () => Promise<T>): Promise<T> => {
    const startTime = Date.now();
    setApiMetrics(prev => ({ ...prev, totalRequests: prev.totalRequests + 1 }));
    try {
      const result = await apiCall();
      const latency = Date.now() - startTime;
      setApiMetrics(prev => ({
        ...prev,
        successfulRequests: prev.successfulRequests + (result ? 1 : 0),
        totalLatencyMs: prev.totalLatencyMs + latency
      }));
      return result;
    } catch (error) {
      const latency = Date.now() - startTime;
      setApiMetrics(prev => ({
        ...prev,
        totalLatencyMs: prev.totalLatencyMs + latency
      }));
      throw error;
    }
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchSessions();
    checkOllamaStatus();
    const interval = setInterval(checkOllamaStatus, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, []);

  const checkOllamaStatus = async () => {
    try {
      const res = await fetch('/api/ai/ollama/status');
      const data = await res.json();
      setIsOllamaOnline(data.status === 'online');
      if (data.status === 'online' && data.model) {
        setOllamaModel(data.model);
      } else {
        setOllamaModel(null);
      }
    } catch (e) {
      setIsOllamaOnline(false);
      setOllamaModel(null);
    }
  };

  const handleTestKey = async () => {
    setKeyTestError('');
    if (!userApiKey.trim()) {
      setUserApiKey('');
      setIsGeminiValid(false);
      setKeyTestResult(null);
      setSelectedEngine('ollama');
      setShowApiKeyInput(false);
      return;
    }

    setIsTestingKey(true);
    setKeyTestResult(null);
    try {
      await trackApiCall(() => testGeminiKey(userApiKey));
      setIsGeminiValid(true);
      setKeyTestResult('success');
      setSelectedEngine('gemini');
      setTimeout(() => {
        setShowApiKeyInput(false);
      }, 1500);
    } catch (error) {
      setIsGeminiValid(false);
      setKeyTestResult('error');
      setKeyTestError(error instanceof Error ? error.message : '無法連線至 Gemini，請稍後再試。');
    } finally {
      setIsTestingKey(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setMessages([]);
    setActionError(null);
    setHistoryError(null);
    if (currentSessionId && !pendingRepliesRef.current[currentSessionId]?.newSessionTitle) {
      fetchMessages(currentSessionId, controller.signal);
    } else {
      setIsHistoryLoading(false);
    }
    setSymptomResponse(previous => previous?.sessionId === currentSessionId ? previous : null);
    setInputText('');
    speechRef.current?.cancel();
    return () => { controller.abort(); messagesRequestRef.current += 1; };
  }, [currentSessionId]);

  useEffect(() => {
    if (pendingReply) pendingReplySection.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    else messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingReply?.requestId]);

  useEffect(() => {
    const handleClickOutside = () => setActiveMenuId(null);
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, []);

  const fetchSessions = async () => {
    const request = ++sessionsRequestRef.current;
    try {
      const data = await requestJson<Session[]>('/api/sessions');
      if (request === sessionsRequestRef.current) setSessions(data);
    } catch (e) {
      if (request === sessionsRequestRef.current) showError(e);
    }
  };

  const fetchMessages = async (id: string, signal?: AbortSignal) => {
    if (currentSessionIdRef.current !== id) return;
    const request = ++messagesRequestRef.current;
    setIsHistoryLoading(true);
    setHistoryError(null);
    const isCurrent = () => !signal?.aborted && request === messagesRequestRef.current && currentSessionIdRef.current === id;
    try {
      const data = await requestJson<Message[]>(`/api/messages/${encodeURIComponent(id)}`, { signal });
      if (isCurrent()) setMessages(data);
    } catch (e) {
      if (isCurrent()) setHistoryError(e instanceof Error ? e.message : '歷史紀錄載入失敗，請重試。');
    } finally {
      if (isCurrent()) setIsHistoryLoading(false);
    }
  };

  const createSession = async (title: string) => {
    const id = crypto.randomUUID();
    await sendJson('/api/sessions', { id, title });
    await fetchSessions();
    return id;
  };

  const createNewSession = async () => {
    const title = `新對話 ${new Date().toLocaleString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`;
    try {
      const id = await createSession(title);
      selectSession(id);
      changeTab('chat');
    } catch (e) {
      showError(e);
    }
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      deletedSessionsRef.current.add(id);
      updatePendingReplies(previous => { const next = { ...previous }; delete next[id]; return next; });
      fetchSessions();
      if (currentSessionIdRef.current === id) selectSession(null);
    } catch (e) {
      showError(e);
    }
  };

  const togglePin = async (session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await sendJson(`/api/sessions/${encodeURIComponent(session.id)}`, { is_pinned: !session.is_pinned }, 'PATCH');
      fetchSessions();
      setActiveMenuId(null);
    } catch (e) {
      showError(e);
    }
  };

  const openRenameDialog = (session: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingSession(session);
    setNewTitle(session.title);
    setIsRenameDialogOpen(true);
    setActiveMenuId(null);
  };

  const handleRename = async () => {
    if (!renamingSession || !newTitle.trim()) return;
    try {
      await sendJson(`/api/sessions/${encodeURIComponent(renamingSession.id)}`, { title: newTitle.trim(), is_manual_title: 1 }, 'PATCH');
      fetchSessions();
      setIsRenameDialogOpen(false);
      setRenamingSession(null);
    } catch (e) {
      showError(e);
    }
  };

  const updateAutomaticTitle = async (sessionId: string, question: string, answer: string) => {
    const session = sessions.find(item => item.id === sessionId);
    if (session && (session.is_manual_title || !/^(新對話|藥物分析|症狀諮詢)/.test(session.title))) return;
    if (pendingTitlesRef.current.has(sessionId)) return;
    pendingTitlesRef.current.add(sessionId);
    try {
      const title = await trackApiCall(() => generateTitleSummary(question, answer, userApiKey, selectedEngine));
      if (title) {
        // The server also checks manual titles, including renames made while AI was running.
        await sendJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { title, is_manual_title: 0 }, 'PATCH');
        await fetchSessions();
      }
    } catch (error) {
      console.error('Automatic title update failed', error);
    } finally {
      pendingTitlesRef.current.delete(sessionId);
    }
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() || pendingAIRef.current || pendingReply || isHistoryLoading || historyError) return;
    if (invalidAge) { setActionError(invalidAge); return; }
    pendingAIRef.current = true;
    setIsLoading(true);
    setActionError(null);
    const question = withConsultationAge(inputText, consultationAge);
    speechRef.current?.cancelListening();
    const startingSessionId = currentSessionIdRef.current;
    let sessionId = startingSessionId;
    const requestId = crypto.randomUUID();
    const controller = beginGeneration();
    try {
      if (!sessionId) {
        sessionId = await createSession(`新對話 ${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`);
        controller.signal.throwIfAborted();
        if (currentSessionIdRef.current === startingSessionId) selectSession(sessionId, true);
      }
      controller.signal.throwIfAborted();
      const saved = await sendJson<{ id: number }>('/api/messages', { session_id: sessionId, role: 'user', content: question, client_id: `${requestId}:user` });
      if (currentSessionIdRef.current === sessionId) setInputText('');
      await fetchMessages(sessionId);
      controller.signal.throwIfAborted();
      const answer = await trackApiCall(() => chatWithAI(messages, question, userApiKey, selectedEngine, controller.signal));
      controller.signal.throwIfAborted();
      finishGeneration(controller);
      await persistReply({ requestId, sessionId, userMessageId: saved.id, userContent: question, assistantContent: answer, question, answer, kind: 'chat' });
    } catch (error) {
      if (currentSessionIdRef.current === sessionId || currentSessionIdRef.current === startingSessionId)
        showError(controller.signal.aborted ? new Error('已停止等待。已儲存的問題可按「重試回答上一個問題」繼續。') : error);
    } finally {
      finishGeneration(controller);
      pendingAIRef.current = false;
      setIsLoading(false);
    }
  };

  const retryLastQuestion = async () => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId || !retryableQuestion || pendingAIRef.current || pendingReply || isHistoryLoading || historyError) return;
    const expectedId = retryableQuestion.message.id;
    pendingAIRef.current = true; setIsLoading(true); setActionError(null);
    const controller = beginGeneration();
    try {
      // Read again before contacting AI: another tab may already have answered.
      const history = await requestJson<Message[]>(`/api/messages/${encodeURIComponent(sessionId)}`, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const retry = unansweredQuestion(history, sessionId);
      setMessages(history);
      if (!retry || retry.message.id !== expectedId) throw new Error('歷史紀錄已更新，請核對最新訊息後再操作。');
      const question = retry.message.content;
      const answer = await trackApiCall(() => chatWithAI(retry.history, question, userApiKey, selectedEngine, controller.signal));
      controller.signal.throwIfAborted();
      finishGeneration(controller);
      await persistReply({ requestId: retry.requestId, sessionId, userMessageId: retry.message.id,
        userContent: question, assistantContent: answer, question, answer, kind: 'chat' });
    } catch (error) {
      if (currentSessionIdRef.current === sessionId) showError(controller.signal.aborted ? new Error('已停止等待，原問題仍保留，可稍後再重試。') : error);
    } finally {
      finishGeneration(controller); pendingAIRef.current = false; setIsLoading(false);
    }
  };

  const persistReply = async (reply: PendingReply, generateTitle = true) => {
    if (deletedSessionsRef.current.has(reply.sessionId)) throw new Error('對話已刪除，未儲存這份回答。');
    const pending = pendingRepliesRef.current[reply.sessionId];
    if (pending && pending.requestId !== reply.requestId) throw new Error('此對話仍有待儲存內容，請先完成原內容的儲存。');
    // Keep generated text before attempting the write. The same request ID is
    // reused after an uncertain response; the server will not insert duplicates.
    updatePendingReplies(previous => ({ ...previous, [reply.sessionId]: reply }));
    if (reply.newSessionTitle && currentSessionIdRef.current === null) selectSession(reply.sessionId, true);
    await savePendingReply(reply);
    updatePendingReplies(previous => {
      const next = { ...previous };
      if (next[reply.sessionId]?.requestId === reply.requestId) delete next[reply.sessionId];
      return next;
    });
    if (reply.kind === 'medication') {
      setSavedMedicationRequestId(reply.requestId);
      setSavedMedicationSessionId(reply.sessionId);
      await fetchSessions();
    }
    if (currentSessionIdRef.current === reply.sessionId) {
      if (reply.kind === 'symptoms') setSymptomResponse({ sessionId: reply.sessionId, content: reply.answer });
      await fetchMessages(reply.sessionId);
    }
    if (generateTitle) void updateAutomaticTitle(reply.sessionId, reply.question, reply.answer);
  };

  const retryReplySave = async () => {
    if (!pendingReply || pendingAIRef.current) return;
    const reply = pendingReply;
    pendingAIRef.current = true; setIsLoading(true); setActionError(null);
    try { await persistReply(reply, false); }
    catch (error) { if (currentSessionIdRef.current === reply.sessionId) showError(error); }
    finally { pendingAIRef.current = false; setIsLoading(false); }
  };

  const saveMedicationReport = async (attempt: MedicationSaveAttempt) => {
    if (pendingAIRef.current) throw new Error('正在處理另一項回答或儲存，請完成後再儲存報告。');
    const startingId = currentSessionIdRef.current;
    const pending = startingId ? pendingRepliesRef.current[startingId] : undefined;
    if (pending && (pending.kind !== 'medication' || pending.requestId !== attempt.requestId || pending.assistantContent !== attempt.content))
      throw new Error('此對話仍有待儲存內容，請先重試儲存，避免覆蓋原內容。');
    const reply: PendingReply = pending || {
      requestId: attempt.requestId, sessionId: startingId || crypto.randomUUID(), kind: 'medication',
      userContent: medicationReportQuestion, assistantContent: attempt.content, question: medicationReportQuestion, answer: attempt.content,
      ...(!startingId ? { newSessionTitle: '藥物資料查詢' } : {}),
    };
    setSavedMedicationSessionId(undefined);
    pendingAIRef.current = true; setIsLoading(true); setActionError(null);
    try { await persistReply(reply, false); }
    finally { pendingAIRef.current = false; setIsLoading(false); }
  };

  const handleSymptomSubmit = async (symptoms: string) => {
    if (!symptoms.trim() || pendingAIRef.current || pendingReply || isHistoryLoading || historyError) return;
    if (invalidAge) { setActionError(invalidAge); return; }
    const question = withConsultationAge(symptoms, consultationAge);
    pendingAIRef.current = true;
    setIsLoading(true);
    setActionError(null);
    setSymptomResponse(null);
    const startingSessionId = currentSessionIdRef.current;
    let sessionId = startingSessionId;
    const controller = beginGeneration();
    try {
      if (!sessionId) {
        sessionId = await createSession(`症狀諮詢 ${new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}`);
        controller.signal.throwIfAborted();
        if (currentSessionIdRef.current === startingSessionId) selectSession(sessionId, true);
      }
      controller.signal.throwIfAborted();
      const result = await trackApiCall(() => getSymptomAdvice(question, symptomMode, userApiKey, selectedEngine, messages, controller.signal));
      controller.signal.throwIfAborted();
      finishGeneration(controller);
      const mode = symptomMode === 'concise' ? '簡潔' : '詳細';
      await persistReply({ requestId: crypto.randomUUID(), sessionId, userContent: `[症狀諮詢 - ${mode}]\n${question}`,
        assistantContent: `### 症狀建議 (${mode})\n\n${result}`, question, answer: result, kind: 'symptoms' });
    } catch (error) {
      if (currentSessionIdRef.current === startingSessionId || currentSessionIdRef.current === sessionId)
        showError(controller.signal.aborted ? new Error('已停止等待，症狀內容仍保留在表單，可按「獲取建議」重試。') : error);
    } finally {
      finishGeneration(controller);
      pendingAIRef.current = false;
      setIsLoading(false);
    }
  };
  return (
    <div className="flex h-dvh bg-[#F8FAFC] text-slate-800 font-sans">
      {/* Sidebar */}
      {isSidebarOpen && <button type="button" aria-label="關閉對話紀錄遮罩" onClick={closeSidebar} className="fixed inset-0 z-30 bg-slate-950/40 md:hidden" />}
      <motion.aside 
        id="session-sidebar" aria-label="對話紀錄" inert={!isSidebarOpen}
        initial={false}
        animate={{ width: isSidebarOpen ? 280 : 0, opacity: isSidebarOpen ? 1 : 0 }}
        className="fixed inset-y-0 left-0 z-40 shrink-0 bg-white border-r border-slate-200 overflow-hidden flex flex-col md:relative md:z-auto"
      >
        <div className="flex items-center justify-between px-4 pt-3 md:hidden"><span className="text-sm font-semibold">對話紀錄</span><button type="button" aria-label="關閉對話紀錄" onClick={closeSidebar} className="rounded-lg p-2 hover:bg-slate-100"><X size={20} /></button></div>
        <div className="p-4 border-bottom border-slate-100">
          <button 
            onClick={createNewSession}
            className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-2xl transition-all shadow-md font-bold text-lg"
          >
            <Plus size={20} />
            建立新對話
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {pendingNewReports.map(reply => <button type="button" key={reply.sessionId}
            onClick={() => { selectSession(reply.sessionId); changeTab('medication'); }}
            className="w-full rounded-xl bg-amber-50 p-3 text-left text-sm text-amber-950">
            <span className="font-semibold">{reply.newSessionTitle}</span><span className="ml-2 text-xs">待儲存報告</span>
          </button>)}
          {sessions.map(session => (
            <div 
              key={session.id}
              className={`group relative flex items-center justify-between p-3 rounded-xl cursor-pointer transition-colors ${currentSessionId === session.id ? 'bg-emerald-50 text-emerald-700' : 'hover:bg-slate-50'}`}
            >
              <button type="button" onClick={() => { selectSession(session.id); changeTab('chat'); }}
                aria-current={currentSessionId === session.id ? 'true' : undefined}
                className="flex items-center gap-3 overflow-hidden flex-1 text-left">
                {!!session.is_pinned && (
                  <Pin size={14} className="text-emerald-600 fill-emerald-600 shrink-0" />
                )}
                <span className="truncate text-sm font-medium">{session.title}</span>
                {Object.hasOwn(pendingReplies, session.id) && <span className="shrink-0 text-[10px] text-amber-700">{pendingReplies[session.id].kind === 'medication' ? '待儲存報告' : '待儲存回答'}</span>}
              </button>
              
              <div className="flex items-center gap-1">
                <button 
                  aria-label={`對話選單：${session.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveMenuId(activeMenuId === session.id ? null : session.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 hover:bg-slate-200 rounded-md transition-all text-slate-400"
                >
                  <MoreVertical size={14} />
                </button>
              </div>

              {activeMenuId === session.id && (
                <div className="absolute right-2 top-10 w-32 bg-white border border-slate-200 rounded-lg shadow-xl z-50 py-1">
                  <button 
                    onClick={(e) => togglePin(session, e)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-slate-50 text-slate-600"
                  >
                    <Pin size={12} />
                    {session.is_pinned ? '取消釘選' : '釘選至頂部'}
                  </button>
                  <button 
                    onClick={(e) => openRenameDialog(session, e)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-slate-50 text-slate-600"
                  >
                    <Edit2 size={12} />
                    重新命名
                  </button>
                  <button 
                    onClick={(e) => deleteSession(session.id, e)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-red-50 text-red-600"
                  >
                    <Trash2 size={12} />
                    刪除對話
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-slate-100 flex flex-col gap-2">
          <button 
            onClick={() => { if (window.matchMedia('(max-width: 767px)').matches) setIsSidebarOpen(false); setShowGuideModal(true); }}
            className="flex items-center gap-2 text-sm text-slate-600 hover:text-emerald-600 transition-colors p-2 rounded-lg hover:bg-slate-50"
          >
            <AlertCircle size={16} />
            使用指南
          </button>
          <div className="text-xs text-slate-400 text-center">
            智慧醫療助理 v1.0
          </div>
        </div>
      </motion.aside>

      {/* Main Content */}
      <main className="min-w-0 flex-1 flex flex-col relative overflow-hidden">
        {/* Header */}
        <header className="min-h-16 shrink-0 bg-white border-b border-slate-200 flex flex-wrap gap-3 items-center justify-between px-4 py-3 z-10">
          <div className="flex items-center gap-4">
            <button 
              ref={sidebarToggle} type="button" aria-label={isSidebarOpen ? '收起對話紀錄' : '開啟對話紀錄'} aria-expanded={isSidebarOpen} aria-controls="session-sidebar"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500"
            >
              <History size={20} />
            </button>
            <h1 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Stethoscope className="text-emerald-600" size={22} />
              智慧醫療助理
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            {/* AI Status Box */}
            <div className="hidden md:flex items-center bg-white px-4 py-1.5 rounded-lg text-sm font-medium border border-slate-200 shadow-sm">
              <span className="text-slate-600 mr-2">優先引擎：</span>
              {selectedEngine === 'gemini' 
                ? <span className={`${isGeminiValid ? 'text-blue-600' : 'text-slate-600'} font-bold flex items-center gap-1`}><span className={`w-2 h-2 rounded-full ${isGeminiValid ? 'bg-blue-500' : 'bg-slate-300'}`} />Gemini · {isGeminiValid ? '金鑰已測試' : '金鑰未測試'}</span>
                : <span className={`${isOllamaOnline ? 'text-emerald-600' : 'text-slate-600'} font-bold flex items-center gap-1`}><span className={`w-2 h-2 rounded-full ${isOllamaOnline ? 'bg-emerald-500' : 'bg-slate-300'}`} />Ollama · {isOllamaOnline === null ? '檢查中' : isOllamaOnline ? '可連線' : '未就緒'}</span>}
            </div>

            {/* Engine Selectors */}
            <div className="hidden sm:flex items-center gap-2 bg-slate-100 p-1 rounded-full">
              <button 
                onClick={() => handleEngineChange('ollama')}
                className={`relative group flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${selectedEngine === 'ollama' ? 'bg-white text-emerald-700 shadow-sm border border-emerald-200' : 'text-slate-500 hover:text-slate-700 border border-transparent'}`}
                title="優先使用 Ollama 本地端"
              >
                <div className={`w-2 h-2 rounded-full ${isOllamaOnline ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                Ollama
                {isOllamaOnline && ollamaModel && (
                  <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 px-2 py-1 bg-black text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50">
                    目前模型：{ollamaModel}
                  </div>
                )}
              </button>
              <button 
                onClick={() => handleEngineChange('gemini')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${selectedEngine === 'gemini' ? 'bg-white text-blue-700 shadow-sm border border-blue-200' : 'text-slate-500 hover:text-slate-700 border border-transparent'}`}
                title="優先使用 Gemini 雲端模式"
              >
                <div className={`w-2 h-2 rounded-full ${isGeminiValid ? 'bg-blue-500' : 'bg-slate-300'}`} />
                Gemini
              </button>
            </div>

            {/* Config Button */}
            <button 
              onClick={() => setShowApiKeyInput(!showApiKeyInput)}
              className="px-4 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors border border-slate-200"
            >
              配置金鑰
            </button>

            {/* Tabs */}
            <nav className="flex flex-wrap bg-slate-100 p-1 rounded-xl gap-1">
              <button 
                onClick={() => changeTab('chat')}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'chat' ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                對話模式
              </button>
              <button 
                onClick={() => changeTab('medication')}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'medication' ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                藥物辨識
              </button>
              <button 
                onClick={() => changeTab('symptoms')}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'symptoms' ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                症狀諮詢
              </button>
            </nav>
          </div>
        </header>

        {/* API Key Input Overlay */}
        <AnimatePresence>
          {showApiKeyInput && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="absolute top-16 left-0 right-0 bg-white border-b border-slate-200 p-6 z-20 shadow-lg"
            >
              <div className="max-w-3xl mx-auto flex flex-col gap-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-slate-800">Gemini API 設定與測試</h3>
                  <button onClick={() => setShowApiKeyInput(false)} className="text-slate-400 hover:text-slate-600">
                    <X size={20} />
                  </button>
                </div>
                
                <p className="text-sm text-slate-500">
                  如果您無法使用本地 Ollama，請輸入您的「Gemini API 金鑰」以啟用雲端 AI 功能。
                  您可以從 <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-emerald-600 underline">Google AI Studio</a> 獲取金鑰。
                </p>

                <div className="flex gap-4">
                  <input 
                    type="password" 
                    disabled={isTestingKey}
                    value={userApiKey}
                    onChange={(e) => {
                      setUserApiKey(e.target.value);
                      setKeyTestResult(null);
                      setKeyTestError('');
                      setIsGeminiValid(false);
                    }}
                    placeholder="在此輸入 Gemini API Key..."
                    className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <button 
                    onClick={handleTestKey}
                    disabled={isTestingKey}
                    className="px-6 py-3 bg-emerald-600 text-white rounded-xl text-sm font-bold hover:bg-emerald-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {isTestingKey && <Loader2 size={16} className="animate-spin" />}
                    儲存並關閉
                  </button>
                </div>

                {keyTestResult === 'success' && (
                  <div className="text-sm text-emerald-600 font-medium flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-500" />
                    金鑰測試成功！Gemini 雲端 AI 已啟用。
                  </div>
                )}
                {keyTestResult === 'error' && (
                  <div className="text-sm text-red-500 font-medium flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-red-500" />
                    {keyTestError}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-4 mt-2">
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                    <div className="text-xs text-slate-500 mb-1">平均延遲</div>
                    <div className="text-xl font-bold text-emerald-600">
                      {apiMetrics.totalRequests > 0 ? Math.round(apiMetrics.totalLatencyMs / apiMetrics.totalRequests) : 0} ms
                    </div>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                    <div className="text-xs text-slate-500 mb-1">成功率</div>
                    <div className="text-xl font-bold text-blue-600">
                      {apiMetrics.totalRequests > 0 ? Math.round((apiMetrics.successfulRequests / apiMetrics.totalRequests) * 100) : 100}%
                    </div>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                    <div className="text-xs text-slate-500 mb-1">總請求</div>
                    <div className="text-xl font-bold text-slate-700">{apiMetrics.totalRequests}</div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Guide Modal */}
        <AnimatePresence>
          {showGuideModal && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4"
              onClick={() => setShowGuideModal(false)}
            >
              <motion.div 
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]"
              >
                <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                  <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                    <AlertCircle className="text-emerald-600" />
                    使用指南
                  </h2>
                  <button 
                    onClick={() => setShowGuideModal(false)}
                    className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
                  >
                    <X size={20} />
                  </button>
                </div>
                
                <div className="p-6 overflow-y-auto flex-1 text-slate-600 text-sm leading-relaxed space-y-6">
                  
                  <section>
                    <h3 className="text-base font-bold text-slate-800 mb-3 flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs">1</div>
                      什麼是 Ollama？
                    </h3>
                    <p className="mb-2">
                      Ollama 是一個可以讓你在「自己的電腦上」執行大型語言模型（例如 Llama 3, Mistral 等）的工具。
                      它的最大優點是「完全免費、保護隱私（資料不會上傳到雲端），且不需要網路連線」即可運作。
                    </p>
                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                      <p className="font-medium text-slate-700 mb-2">如何安裝與啟動 Ollama：</p>
                      <ol className="list-decimal list-inside space-y-1 ml-2">
                        <li>前往 <a href="https://ollama.com/" target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline">Ollama 官方網站</a> 下載並安裝。</li>
                        <li>打開終端機 (Terminal) 或命令提示字元 (CMD)。</li>
                        <li>輸入指令下載模型：<code className="bg-slate-200 px-1.5 py-0.5 rounded text-emerald-700">ollama run llama3</code> (或你喜歡的模型)。</li>
                        <li>在專案的環境設定中，將 OLLAMA_MODEL 設為已下載的模型名稱，再重新啟動應用程式。網頁會透過後端連線到 Ollama。</li>
                      </ol>
                    </div>
                  </section>

                  <section>
                    <h3 className="text-base font-bold text-slate-800 mb-3 flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs">2</div>
                      什麼是 Gemini API？
                    </h3>
                    <p className="mb-2">
                      Gemini 是 Google 開發的強大雲端 AI 模型。當你無法在本地執行 Ollama，或者需要更強大的推理能力（例如圖片辨識）時，可以使用 Gemini。
                    </p>
                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-200">
                      <p className="font-medium text-slate-700 mb-2">如何獲取 Gemini API Key：</p>
                      <ol className="list-decimal list-inside space-y-1 ml-2">
                        <li>前往 <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">Google AI Studio</a>。</li>
                        <li>登入你的 Google 帳號。</li>
                        <li>點擊 "Create API key" 按鈕。</li>
                        <li>複製產生的金鑰，並貼到本應用程式右上角的「配置金鑰」設定中。</li>
                      </ol>
                    </div>
                  </section>

                  <section>
                    <h3 className="text-base font-bold text-slate-800 mb-3 flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-xs">3</div>
                      系統如何選擇 AI？
                    </h3>
                    <p>
                      本系統採用「智慧切換機制」：
                    </p>
                    <ul className="list-disc list-inside space-y-2 mt-2 ml-2">
                      <li>
                        <span className="font-medium text-slate-700">依選定引擎使用：</span>
                        文字功能依上方選定引擎優先嘗試，Ollama 由後端代理連線 (預設 <code className="bg-slate-100 px-1 py-0.5 rounded">http://127.0.0.1:11434</code>)。若選定服務無法使用，一般聊天會嘗試另一引擎；藥物頁的查詢摘要直接依資料狀態生成，不呼叫模型。
                      </li>
                      <li>
                        <span className="font-medium text-slate-700">自動切換 Gemini：</span>
                        如果 Ollama 未啟動，且您已設定了有效的 Gemini API Key，一般文字功能會嘗試使用 Gemini。此備援只用於一般文字功能；本機圖片比對或 OCR 失敗不會自動上傳雲端。
                      </li>
                      <li>
                        <span className="font-medium text-slate-700">本機照片比對與 OCR：</span>
                        藥錠與藥盒照片可比對本機參考圖，預設同時使用瀏覽器 OCR 讀文字，不需金鑰或 Ollama。可上傳同一種藥的正反面、裁切並核對文字；候選仍需人工確認。藥袋或 PDF 請切換本機 OCR。只有選擇 Gemini 輔助並按辨識時才上傳雲端。確認品項後先用本機 DDInter 分析，需要時才補查線上仿單。查無紀錄不代表用藥安全。
                      </li>
                      <li>
                        <span className="font-medium text-slate-700">保留藥物查詢：</span>
                        同一對話內切換功能，會保留藥單、年齡、照片與已完成結果；離開藥物頁會停止尚未完成的照片辨識。切換對話或重新整理會清空未儲存內容，需要留存時請先按「儲存報告至對話」。
                      </li>
                    </ul>
                  </section>

                </div>
                
                <div className="p-4 border-t border-slate-100 bg-slate-50 flex justify-end">
                  <button 
                    onClick={() => setShowGuideModal(false)}
                    className="px-6 py-2 bg-emerald-600 text-white rounded-xl text-sm font-bold hover:bg-emerald-700 transition-colors"
                  >
                    我了解了
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Disclaimer Modal */}
        <AnimatePresence>
          {showDisclaimerModal && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4"
            >
              <motion.div 
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col"
              >
                <div className="p-6 border-b border-slate-100 flex items-center gap-3 bg-amber-50">
                  <AlertCircle className="text-amber-600" size={24} />
                  <h2 className="text-xl font-bold text-slate-800">醫療免責聲明</h2>
                </div>
                
                <div className="p-6 text-slate-600 text-sm leading-relaxed">
                  <p>
                    本系統由 AI 技術生成，分析結果僅供參考，不具備醫療診斷與處方權。若有任何身體不適，請務必諮詢專業醫療人員。
                  </p>
                </div>
                
                <div className="p-4 border-t border-slate-100 bg-slate-50 flex justify-end">
                  <button 
                    onClick={() => {
                      setShowDisclaimerModal(false);
                      localStorage.setItem('disclaimerAcceptedAt', Date.now().toString());
                    }}
                    className="px-6 py-2 bg-emerald-600 text-white rounded-xl text-sm font-bold hover:bg-emerald-700 transition-colors"
                  >
                    我同意並了解
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Content Area */}
        {savedMedicationSessionId === currentSessionId && activeTab === 'medication' && <div role="status" className="mx-6 mt-4 flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <span>藥物報告已儲存至此對話。</span><button type="button" className="font-semibold underline" onClick={() => changeTab('chat')}>查看已儲存報告</button>
        </div>}
        {isGenerating && <div role="status" className="mx-6 mt-4 flex shrink-0 items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
          <span>正在等待回答；停止後可重試原問題。</span>
          <button type="button" onClick={() => generationRef.current?.abort()} className="shrink-0 rounded-lg bg-sky-800 px-3 py-2 font-semibold text-white">停止等待</button>
        </div>}
        {actionError && <div role="alert" className="mx-6 mt-4 whitespace-pre-line rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div>}
        {historyError && <div role="alert" className="mx-6 mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p>無法載入這個對話的歷史紀錄：{historyError}</p>
          <p className="mt-1">請重試載入後再繼續諮詢，避免漏掉原本的年齡與問題。</p>
          <button type="button" className="mt-2 font-semibold underline" onClick={() => currentSessionId && fetchMessages(currentSessionId)}>重試載入</button>
        </div>}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl mx-auto h-full flex flex-col">
            {pendingReply && <section ref={pendingReplySection} aria-label={pendingReply.kind === 'medication' ? '待儲存的藥物報告' : '待儲存的回答'} className="mb-5 shrink-0 rounded-2xl border border-amber-300 bg-amber-50 p-5">
              <h2 className="font-bold text-amber-950">{pendingReply.kind === 'medication' ? '藥物報告已保留，尚未確認儲存' : '回答已產生，尚未確認儲存'}</h2>
              <p className="mt-2 text-sm text-amber-900">{pendingStorageReady ? '內容暫存在此分頁，重新整理後可由側欄找回；關閉分頁前請先完成儲存。' : '瀏覽器暫存空間無法使用，內容僅保留在目前畫面；請先重試儲存，避免重新整理或關閉分頁。'}{pendingReply.kind === 'medication' ? '重試只保存這份報告，不重新查詢、不改動原年齡、來源或結果。' : '重試只儲存這份回答，不會再次呼叫 AI。'}</p>
              <details className="mt-3 text-sm"><summary className="cursor-pointer">查看這次問題與年齡</summary><p className="mt-2 whitespace-pre-wrap">{pendingReply.userContent}</p></details>
              <div className="mt-4 max-h-80 overflow-y-auto rounded-xl bg-white p-4"><MarkdownContent>{pendingReply.assistantContent}</MarkdownContent></div>
              <button type="button" onClick={() => void retryReplySave()} disabled={isLoading} className="mt-4 rounded-xl bg-amber-800 px-4 py-2.5 font-semibold text-white disabled:opacity-50">{isLoading ? '正在處理…' : pendingReply.kind === 'medication' ? '重試儲存報告' : '重試儲存回答'}</button>
            </section>}
            {activeTab !== 'medication' && <ConsultationAgeField age={consultationAge} disabled={isLoading || isHistoryLoading || !!historyError}
              onChange={age => { setConsultationAge(age); setSymptomResponse(null); }} />}
            {medicationVisited && <div hidden={activeTab !== 'medication'}>
              <MedicationPanel key={consultationRevision} active={activeTab === 'medication'} apiKey={userApiKey} onSave={saveMedicationReport} saveDisabled={isLoading || !!pendingReply} savedRequestId={savedMedicationRequestId} />
            </div>}
            <AnimatePresence mode="wait">
              {activeTab === 'chat' && (
                <motion.div 
                  key="chat"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex-1 flex flex-col gap-4"
                >
                  {isHistoryLoading && messages.length === 0 ? (
                    <div role="status" className="flex justify-center gap-2 p-8 text-slate-500"><Loader2 className="animate-spin" size={20} />載入對話中…</div>
                  ) : historyError && messages.length === 0 ? null : messages.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-4 sm:p-12 pb-28 sm:pb-28 space-y-6">
                      <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center text-emerald-600">
                        <MessageSquare size={40} />
                      </div>
                      <div className="max-w-md">
                        <h2 className="text-2xl font-bold text-slate-900 mb-2">各年齡的健康照護助手</h2>
                        <p className="text-slate-500">從嬰幼兒、兒童、青少年到成人與高齡者，都可以提出健康問題。提供諮詢對象的年齡，讓照護資訊更貼近需求。</p>
                      </div>
                      <div className="grid grid-cols-2 gap-4 w-full max-w-lg">
                        <button onClick={() => changeTab('medication')} className="p-4 bg-white border border-slate-200 rounded-2xl hover:border-emerald-500 transition-all text-left group">
                          <Pill className="text-emerald-600 mb-2 group-hover:scale-110 transition-transform" />
                          <div className="font-semibold">查詢藥物資料</div>
                          <div className="text-xs text-slate-400">確認藥品、查看仿單與交互作用</div>
                        </button>
                        <button onClick={() => changeTab('symptoms')} className="p-4 bg-white border border-slate-200 rounded-2xl hover:border-emerald-500 transition-all text-left group">
                          <AlertCircle className="text-amber-500 mb-2 group-hover:scale-110 transition-transform" />
                          <div className="font-semibold">症狀照護資訊</div>
                          <div className="text-xs text-slate-400">依年齡與症狀提供照護資訊</div>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-6 pb-24">
                      {messages.map((msg, i) => (
                        <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                          <div className={`min-w-0 max-w-full sm:max-w-[90%] p-4 rounded-2xl shadow-sm relative ${msg.role === 'user' ? 'bg-emerald-600 text-white rounded-tr-none' : 'bg-white border border-slate-100 rounded-tl-none'}`}>
                            {msg.role === 'assistant'
                              ? <SpokenAnswer speakingKey={speakingKey} onSpeak={speak} onStop={stopAnswerSpeech}>{msg.content}</SpokenAnswer>
                              : <MarkdownContent inverse>{msg.content}</MarkdownContent>}
                          </div>
                        </div>
                      ))}
                      {retryableQuestion && !pendingReply && !isLoading && !isHistoryLoading && !historyError && <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
                        <p>上一個問題尚未有已儲存的回答。重試會沿用原問題及當時的年齡，不會新增重複問題。</p>
                        <button type="button" onClick={() => void retryLastQuestion()} className="mt-3 rounded-lg bg-sky-800 px-4 py-2.5 font-semibold text-white">重試回答上一個問題</button>
                      </div>}
                      {isLoading && (
                        <div className="flex justify-start">
                          <div className="bg-white border border-slate-100 p-4 rounded-2xl rounded-tl-none flex items-center gap-2">
                            <Loader2 size={16} className="animate-spin text-emerald-600" />
                            <span className="text-sm text-slate-500">{isGenerating ? '正在等待模型回覆，較長內容可能需要幾分鐘…' : '正在儲存或更新對話…'}</span>
                          </div>
                        </div>
                      )}
                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </motion.div>
              )}

              {activeTab === 'symptoms' && (
                <motion.div 
                  key="symptoms"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="flex-1 flex flex-col items-center"
                >
                  <div className="w-full max-w-2xl bg-white p-8 rounded-3xl shadow-xl border border-slate-100 mb-6">
                    <div className="text-center mb-8">
                      <h2 className="text-2xl font-bold text-slate-900 mb-2">依年齡提供照護資訊</h2>
                      <p className="text-slate-500">請提供本人或家人的年齡與症狀，AI 會參考這些資訊回覆；藥品與用量請至藥物頁查核來源，並諮詢醫師或藥師。</p>
                    </div>

                    <div className="space-y-6">
                      <div>
                        <label htmlFor="symptomInput" className="block text-sm font-semibold text-slate-700 mb-2">症狀描述</label>
                        <textarea 
                          className="w-full h-32 p-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all outline-none resize-none"
                          placeholder="例如：咳嗽兩天，何時開始、還有哪些不舒服、目前正在使用哪些藥物…"
                          id="symptomInput"
                          value={symptomText}
                          disabled={isLoading || isHistoryLoading}
                          onChange={e => { setSymptomText(e.target.value); setSymptomResponse(null); }}
                        ></textarea>
                      </div>

                      <div className="flex gap-4">
                        <button 
                          onClick={() => setSymptomMode('concise')}
                          className={`flex-1 py-3 rounded-xl font-medium border transition-all ${symptomMode === 'concise' ? 'bg-emerald-50 border-emerald-500 text-emerald-700' : 'bg-white border-slate-200 text-slate-500'}`}
                        >
                          簡潔版建議
                        </button>
                        <button 
                          onClick={() => setSymptomMode('detailed')}
                          className={`flex-1 py-3 rounded-xl font-medium border transition-all ${symptomMode === 'detailed' ? 'bg-emerald-50 border-emerald-500 text-emerald-700' : 'bg-white border-slate-200 text-slate-500'}`}
                        >
                          詳細版建議
                        </button>
                      </div>

                      <button 
                        onClick={() => handleSymptomSubmit(symptomText)}
                        disabled={!symptomText.trim() || !!invalidAge || isLoading || !!pendingReply || isHistoryLoading || !!historyError}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white py-4 rounded-2xl font-bold text-lg transition-all shadow-lg flex items-center justify-center gap-2"
                      >
                        {isLoading ? <Loader2 className="animate-spin" /> : <ChevronRight size={20} />}
                        獲取建議
                      </button>
                    </div>
                  </div>

                  {/* Inline Result Display */}
                  <AnimatePresence>
                    {symptomResult && (
                      <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="w-full max-w-2xl bg-white p-8 rounded-3xl shadow-lg border border-emerald-100"
                      >
                        <SpokenAnswer speakingKey={speakingKey} onSpeak={speak} onStop={stopAnswerSpeech}
                          heading={<div className="flex items-center gap-2 text-emerald-600">
                            <Stethoscope size={20} />
                            <h3 className="font-bold text-lg">照護資訊與就醫提醒</h3>
                          </div>}>
                          {symptomResult}
                        </SpokenAnswer>
                        <div className="mt-6 pt-6 border-t border-slate-100 flex justify-between items-center">
                          <span className="text-xs text-slate-400">此建議已同步儲存至對話紀錄</span>
                          <button 
                            onClick={() => changeTab('chat')}
                            className="text-emerald-600 text-sm font-semibold hover:underline"
                          >
                            前往對話詳談
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Input Bar (Only in Chat Tab) */}
        {activeTab === 'chat' && (
          <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-[#F8FAFC] via-[#F8FAFC] to-transparent">
            <div className="max-w-4xl mx-auto relative">
              <input 
                type="text" 
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) handleSendMessage(); }}
                placeholder="輸入本人或家人的健康問題…"
                aria-label="健康問題"
                className="w-full bg-white border border-slate-200 rounded-2xl py-4 pl-6 pr-28 shadow-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all outline-none"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                <button 
                  onClick={() => speechRef.current?.toggleListening()}
                  disabled={isLoading || isHistoryLoading || !!historyError}
                  className={`p-2.5 rounded-xl transition-all shadow-md ${isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                  title={isListening ? '停止語音輸入' : '語音輸入'}
                  aria-pressed={isListening}
                >
                  <Mic size={20} />
                </button>
                <button 
                  onClick={handleSendMessage}
                  disabled={!inputText.trim() || !!invalidAge || isLoading || !!pendingReply || isHistoryLoading || !!historyError}
                  aria-label="送出問題"
                  className="p-2.5 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:bg-slate-300 transition-all shadow-md"
                >
                  <Send size={20} />
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Rename Dialog */}
      <AnimatePresence>
        {isRenameDialogOpen && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="p-6">
                <h3 className="text-lg font-bold text-slate-900 mb-4">重新命名對話</h3>
                <input 
                  type="text" 
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="輸入新標題..."
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) handleRename(); }}
                />
              </div>
              <div className="flex border-t border-slate-100">
                <button 
                  onClick={() => setIsRenameDialogOpen(false)}
                  className="flex-1 py-4 text-slate-500 font-medium hover:bg-slate-50 transition-colors"
                >
                  取消
                </button>
                <button 
                  onClick={handleRename}
                  className="flex-1 py-4 text-emerald-600 font-bold hover:bg-emerald-50 transition-colors border-l border-slate-100"
                >
                  確認
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
