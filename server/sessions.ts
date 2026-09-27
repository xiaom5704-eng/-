import { Router } from 'express';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { replyRequestId } from '../shared/conversation-retry';
import { medicationReportQuestion } from '../shared/medication-save';

export function openSessionDatabase(filename: string) {
  if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, title TEXT, is_pinned INTEGER DEFAULT 0,
      is_manual_title INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    CREATE TABLE IF NOT EXISTS deleted_sessions (id TEXT PRIMARY KEY);
  `);
  const columns = db.pragma('table_info(sessions)') as { name: string }[];
  for (const column of ['is_pinned', 'is_manual_title']) {
    if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE sessions ADD COLUMN ${column} INTEGER DEFAULT 0`);
  }
  const messageColumns = db.pragma('table_info(messages)') as { name: string }[];
  if (!messageColumns.some(item => item.name === 'client_id')) db.exec('ALTER TABLE messages ADD COLUMN client_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS message_client_id ON messages(session_id, client_id) WHERE client_id IS NOT NULL');
  return db;
}

export function sessionRouter(db: ReturnType<typeof openSessionDatabase>) {
  const router = Router();
  const exists = (id: string) => !!db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
  const wasDeleted = (id: string) => !!db.prepare('SELECT id FROM deleted_sessions WHERE id = ?').get(id);
  const validText = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
  const putMessage = db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)');
  const putIdentifiedMessage = db.prepare('INSERT INTO messages (session_id, role, content, client_id) VALUES (?, ?, ?, ?)');
  const existingMessage = db.prepare('SELECT id, role, content FROM messages WHERE session_id = ? AND client_id = ?');
  class MessageConflict extends Error {}
  class DeletedSession extends Error {}
  const saveMessage = (sessionId: string, role: string, content: string, clientId?: string) => {
    if (!clientId) return Number(putMessage.run(sessionId, role, content).lastInsertRowid);
    const existing = existingMessage.get(sessionId, clientId) as { id: number; role: string; content: string } | undefined;
    if (existing) {
      if (existing.role !== role || existing.content !== content) throw new MessageConflict('這筆訊息的內容與已儲存版本不同，請重新載入歷史紀錄核對。');
      return existing.id;
    }
    return Number(putIdentifiedMessage.run(sessionId, role, content, clientId).lastInsertRowid);
  };

  router.get('/sessions', (_req, res) => {
    res.json(db.prepare('SELECT * FROM sessions ORDER BY is_pinned DESC, created_at DESC, rowid DESC').all());
  });
  router.post('/sessions', (req, res) => {
    const { id, title } = req.body || {};
    if (!validText(id, 200) || !validText(title, 2000)) { res.status(400).json({ error: '對話資料無效' }); return; }
    if (wasDeleted(id)) { res.status(410).json({ error: '這個對話已刪除，請建立新的對話。' }); return; }
    if (exists(id)) { res.status(409).json({ error: '對話已存在' }); return; }
    db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(id, title);
    res.json({ success: true });
  });
  router.patch('/sessions/:id', (req, res) => {
    const { title, is_pinned, is_manual_title } = req.body || {};
    if (title !== undefined && !validText(title, 2000)) { res.status(400).json({ error: '標題無效' }); return; }
    if (!exists(req.params.id)) { res.status(404).json({ error: '對話不存在' }); return; }
    db.transaction(() => {
      if (title !== undefined) {
        // A delayed AI title must never overwrite a user's manual rename.
        if (is_manual_title === 0) {
          db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND COALESCE(is_manual_title, 0) = 0').run(title, req.params.id);
        } else {
          db.prepare('UPDATE sessions SET title = ?, is_manual_title = 1 WHERE id = ?').run(title, req.params.id);
        }
      }
      if (is_pinned !== undefined) db.prepare('UPDATE sessions SET is_pinned = ? WHERE id = ?').run(is_pinned ? 1 : 0, req.params.id);
    })();
    res.json({ success: true });
  });
  router.get('/messages/:sessionId', (req, res) => {
    if (!exists(req.params.sessionId)) { res.status(404).json({ error: '對話不存在' }); return; }
    res.json(db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC').all(req.params.sessionId));
  });
  router.post('/messages', (req, res) => {
    const { session_id, role, content, client_id } = req.body || {};
    if (!validText(session_id, 200) || !['user', 'assistant'].includes(role) || !validText(content, 2_000_000) ||
      (client_id !== undefined && !validText(client_id, 240))) {
      res.status(400).json({ error: '訊息資料無效' }); return;
    }
    if (!exists(session_id)) { res.status(404).json({ error: '對話不存在，訊息未儲存' }); return; }
    try { res.json({ success: true, id: saveMessage(session_id, role, content, client_id) }); }
    catch (error) { if (error instanceof MessageConflict) res.status(409).json({ error: error.message }); else throw error; }
  });
  router.post('/sessions/:id/exchange', (req, res) => {
    const { requestId, userContent, assistantContent, userMessageId } = req.body || {};
    if (!validText(requestId, 200) || !validText(userContent, 2_000_000) || !validText(assistantContent, 2_000_000) ||
      (userMessageId !== undefined && (!Number.isSafeInteger(userMessageId) || userMessageId <= 0))) {
      res.status(400).json({ error: '回答資料無效或過長' }); return;
    }
    if (!exists(req.params.id)) { res.status(404).json({ error: '對話不存在，回答尚未儲存' }); return; }
    try {
      const ids = db.transaction(() => {
        let questionId: number;
        if (userMessageId !== undefined) {
          const original = db.prepare('SELECT id, role, content, client_id FROM messages WHERE session_id = ? AND id = ?')
            .get(req.params.id, userMessageId) as { id: number; role: string; content: string; client_id: string | null } | undefined;
          if (!original || original.role !== 'user' || original.content !== userContent || replyRequestId(original) !== requestId)
            throw new MessageConflict('原問題與儲存資料不符，請重新載入歷史紀錄核對。');
          const savedAnswer = existingMessage.get(req.params.id, `${requestId}:assistant`);
          const latest = db.prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(req.params.id) as { id: number };
          if (!savedAnswer && latest.id !== original.id) throw new MessageConflict('歷史紀錄已更新，回答尚未儲存；請重新載入並核對原問題。');
          questionId = original.id;
        } else questionId = saveMessage(req.params.id, 'user', userContent, `${requestId}:user`);
        return [questionId, saveMessage(req.params.id, 'assistant', assistantContent, `${requestId}:assistant`)];
      })();
      res.json({ success: true, ids });
    } catch (error) { if (error instanceof MessageConflict) res.status(409).json({ error: error.message }); else throw error; }
  });
  router.post('/sessions/:id/medication-report', (req, res) => {
    const { content, requestId, newSessionTitle } = req.body || {};
    if (!validText(req.params.id, 200) || !validText(content, 2_000_000) ||
      (requestId !== undefined && !validText(requestId, 200)) ||
      (newSessionTitle !== undefined && (!validText(newSessionTitle, 2000) || !validText(requestId, 200)))) {
      res.status(400).json({ error: '報告內容或儲存識別無效' }); return;
    }
    if (!exists(req.params.id) && newSessionTitle === undefined) { res.status(404).json({ error: '對話不存在' }); return; }
    try {
      const messages = db.transaction(() => {
        if (wasDeleted(req.params.id)) throw new DeletedSession('原對話已刪除，報告未重新建立對話或寫入。');
        if (!exists(req.params.id)) db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(req.params.id, newSessionTitle);
        return [{ role: 'user', content: medicationReportQuestion }, { role: 'assistant', content }].map(message => ({
          ...message, session_id: req.params.id,
          id: saveMessage(req.params.id, message.role, message.content, requestId ? `report:${requestId}:${message.role}` : undefined),
        }));
      })();
      res.json({ messages });
    } catch (error) {
      if (error instanceof DeletedSession) res.status(410).json({ error: error.message });
      else if (error instanceof MessageConflict) res.status(409).json({ error: error.message });
      else throw error;
    }
  });
  router.delete('/sessions/:id', (req, res) => {
    if (!validText(req.params.id, 200)) { res.status(400).json({ error: '對話識別無效' }); return; }
    db.transaction(() => {
      // Keep only the ID so an in-flight first report cannot recreate a deleted
      // conversation. No title, medical content or timestamps are retained here.
      db.prepare('INSERT OR IGNORE INTO deleted_sessions (id) VALUES (?)').run(req.params.id);
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(req.params.id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
    })();
    res.json({ success: true });
  });
  return router;
}
