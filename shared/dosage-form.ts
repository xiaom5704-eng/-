// Bilingual terms only, not manufacturing coverage or clinical equivalence.
// TFDA terminology reference: https://www.fda.gov.tw/tc/includes/GetFile.ashx?id=f636694183792583215
const spelling = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s-]+/g, '');
const terms: [string, string[]][] = [
  ['錠劑', ['tablet', 'tablets']], ['膜衣錠', ['film-coated tablet', 'film-coated tablets']],
  ['糖衣錠', ['sugar coated tablet', 'sugar coated tablets']], ['腸溶錠', ['enteric-coated tablet', 'enteric-coated tablets']],
  ['膠囊劑', ['capsule', 'capsules']], ['軟膠囊劑', ['soft capsule', 'soft capsules']],
  ['糖漿劑', ['syrup', 'syrups']], ['內服液劑', ['solution for internal use']],
  ['口服液劑', ['oral solution', 'oral solutions']], ['外用液劑', ['solution for external use']],
  ['乳膏劑', ['cream', 'creams']], ['軟膏劑', ['ointment', 'ointments']],
  ['點眼液劑', ['ophthalmic solution', 'ophthalmic solutions']],
  ['舌下錠', ['sublingual tablet', 'sublingual tablets']],
  ['發泡錠', ['effervescent tablet', 'effervescent tablets']], ['咀嚼錠', ['chewable tablet', 'chewable tablets']],
];
const translations = new Map(terms.flatMap(([name, aliases]) => aliases.map(alias => [spelling(alias), spelling(name)])));
export function dosageFormKey(value: string) { const key = spelling(value); return translations.get(key) || key; }
