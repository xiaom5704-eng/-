// General definitions of DDInter's published annotation classes, not an
// individualized explanation, treatment recommendation, or inferred mechanism.
export const mechanismDefinitions = {
  absorption: { label: '影響吸收', description: '藥物進入體內的吸收過程可能改變。' },
  distribution: { label: '影響體內分布', description: '藥物在血液或組織中的分布可能改變。' },
  metabolism: { label: '影響藥物代謝', description: '身體分解或轉化藥物的過程可能受到影響。' },
  excretion: { label: '影響藥物排出', description: '藥物排出體外的過程可能受到影響。' },
  synergy: { label: '作用可能增強', description: '兩種藥的作用可能互相增強；這個分類本身不能判定是治療效益或副作用。' },
  antagonism: { label: '作用可能互相抵消', description: '某些藥物作用可能被削弱；單靠分類無法判定實際影響。' },
  others: { label: '其他機轉', description: '來源歸為其他類別，尚不能由此確定具體原因。' },
  unknown: { label: '機轉尚不明', description: '來源沒有明確機轉資訊，不能據此推定安全。' },
} as const;

export type InteractionMechanismType = keyof typeof mechanismDefinitions;
export interface InteractionMechanism {
  types: InteractionMechanismType[];
  sourceUrl: string;
  dataUrl: string;
  retrievedAt: string;
  sha256: string;
}
export const mechanismDefinitionUrl = 'https://ddinter2.scbdd.com/explanation/';
export const mechanismScope = '這是官方機轉分類的一般詞義說明；未指出哪種藥受影響、具體症狀或個人風險，不能據此調整服藥。';

export function mechanismTypes(value: unknown): InteractionMechanismType[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > Object.keys(mechanismDefinitions).length ||
      value.some(type => typeof type !== 'string' || !Object.hasOwn(mechanismDefinitions, type)) || new Set(value).size !== value.length)
    return undefined;
  return Object.keys(mechanismDefinitions).filter(type => value.includes(type)) as InteractionMechanismType[];
}
