export interface OllamaStatus {
  status: 'online' | 'offline';
  model: string;
  code: 'ready' | 'model_missing' | 'unreachable' | 'invalid_response';
  message: string;
  installedModels: string[];
}
