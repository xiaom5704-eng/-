export interface Session {
  id: string;
  title: string;
  is_pinned: boolean;
  is_manual_title: boolean;
  created_at: string;
}

export interface Message {
  id?: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
  client_id?: string | null;
}
