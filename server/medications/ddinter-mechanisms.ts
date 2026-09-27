import { createHash } from 'node:crypto';
import { mechanismTypes, type InteractionMechanism, type InteractionMechanismType } from '../../shared/interaction-mechanism';
import { ddinterDrugUrl, ddinterGraphUrl, parseDdinterGraph } from './ddinter-supplements';
import { normalizeName, type DrugDatabase } from './store';

interface Snapshot { id: string; sha256: string; retrieved_at: string; source_url: string; data_url: string }
interface ParsedSnapshot {
  names: Map<string, string>;
  pairs: Map<string, { level: string; types: InteractionMechanismType[] | undefined }>;
}

// One report owns this cache. Re-read snapshots on the next report so updates,
// damage, removals and reciprocal disagreement cannot leave stale annotations.
export function createDdinterMechanismReader(db: DrugDatabase) {
  const sources = db.prepare(`SELECT s.id,s.sha256,s.retrieved_at,s.source_url,s.data_url FROM ddinter_web_pairs p
    JOIN ddinter_web_snapshots s ON s.id=p.root_id WHERE p.drug_a=? AND p.drug_b=?
    ORDER BY s.retrieved_at DESC,s.id`);
  const rawById = db.prepare('SELECT raw FROM ddinter_web_snapshots WHERE id=?');
  const currentNames = db.prepare('SELECT normalized_name FROM ddinter_all_drugs WHERE id=?');
  const snapshots = new Map<string, ParsedSnapshot | undefined>();
  const names = new Map<string, string | undefined>();
  const nameFor = (id: string) => {
    if (!names.has(id)) {
      const rows = currentNames.all(id) as { normalized_name: string }[];
      names.set(id, rows.length === 1 ? rows[0].normalized_name : undefined);
    }
    return names.get(id);
  };
  const snapshotFor = (source: Snapshot) => {
    const key = JSON.stringify(source);
    if (!snapshots.has(key)) {
      let parsed: ParsedSnapshot | undefined;
      try {
        const row = rawById.get(source.id) as { raw: string } | undefined;
        if (!row || source.source_url !== ddinterDrugUrl(source.id) || source.data_url !== ddinterGraphUrl(source.id) ||
            !/^\d{4}-\d{2}-\d{2}T/.test(source.retrieved_at) || !Number.isFinite(Date.parse(source.retrieved_at)) ||
            createHash('sha256').update(row.raw).digest('hex') !== source.sha256) throw Error('Invalid snapshot');
        const graph = parseDdinterGraph(row.raw, source.id);
        const items = JSON.parse(row.raw).interactions as { id: string; actions?: unknown }[];
        const actions = new Map(items.map(item => [item.id, mechanismTypes(item.actions)]));
        parsed = { names: graph.drugs, pairs: new Map(graph.pairs.map(pair => {
          const partner = pair.drugA === source.id ? pair.drugB : pair.drugA;
          return [`${pair.drugA}:${pair.drugB}`, { level: pair.level, types: actions.get(partner) }];
        })) };
      } catch { /* Keep pair-level results usable; do not invent a mechanism. */ }
      snapshots.set(key, parsed);
    }
    return snapshots.get(key);
  };
  return (drugA: string, drugB: string, level: string): InteractionMechanism | undefined => {
    const [a, b] = [drugA, drugB].sort();
    const rows = sources.all(a, b) as Snapshot[];
    if (!rows.length || rows.length > 2) return undefined;
    let evidence: InteractionMechanism | undefined;
    for (const source of rows) {
      // Each graph must be rooted in this pair, not another drug's corrupted row.
      if (source.id !== a && source.id !== b) return undefined;
      const graph = snapshotFor(source), pair = graph?.pairs.get(`${a}:${b}`);
      if (!pair?.types || pair.level !== level || ![a, b].every(id => {
        const name = graph!.names.get(id);
        return name && nameFor(id) === normalizeName(name);
      })) return undefined;
      // A newer incomplete/different annotation does not inherit older meaning.
      if (evidence && evidence.types.join('|') !== pair.types.join('|')) return undefined;
      evidence ??= { types: [...pair.types], sourceUrl: source.source_url, dataUrl: source.data_url,
        retrievedAt: source.retrieved_at, sha256: source.sha256 };
    }
    return evidence;
  };
}
