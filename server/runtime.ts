import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';

// This module and the bundled server both live one directory below the app root.
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadRuntimeConfig(root = projectRoot, env: NodeJS.ProcessEnv = process.env, readEnv = true) {
  if (readEnv) loadDotEnv({ path: path.join(root, '.env'), processEnv: env, quiet: true });
  const rawPort = env.PORT ?? '3000';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('PORT 必須是 0–65535 的整數；0 代表自動選擇可用埠。');
  const resolvePath = (value: string | undefined, fallback: string) => path.resolve(root, value || fallback);
  const paths = {
    chatDb: resolvePath(env.CHAT_DB_PATH, 'medsafe.db'),
    drugDb: resolvePath(env.DRUG_DB_PATH, 'data/drugs.db'),
    vision: resolvePath(env.VISION_DATA_DIR, 'data/vision'),
    dist: path.join(root, 'dist'),
  };
  // Set these before importing providers whose vision paths are initialized on import.
  env.CHAT_DB_PATH = paths.chatDb; env.DRUG_DB_PATH = paths.drugDb; env.VISION_DATA_DIR = paths.vision;
  return { root, paths, port: Number(rawPort), host: env.HOST || '0.0.0.0', production: env.NODE_ENV === 'production' };
}

export type RuntimeConfig = ReturnType<typeof loadRuntimeConfig>;
