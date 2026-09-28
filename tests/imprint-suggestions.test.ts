import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { applyImprintSuggestion, imprintDifference, imprintSuggestionInputs } from '../shared/imprint-suggestions';
import type { MedicationObservation } from '../shared/medication';
import { suggestLocalImprints } from '../server/medications/imprint-suggestions';
import { openDrugDatabase } from '../server/medications/store';
import { importTfda } from '../server/medications/importers';
import { importAppearance, matchObservation } from '../server/medications/appearance';
import { medicationRouter } from '../server/medications/router';
import { DrugProviders } from '../server/medications/providers';
import { listenForFetch } from './http-listener';

const headers = ['許可證字號','中文品名','英文品名','形狀','特殊劑型','顏色','特殊氣味','刻痕','外觀尺寸','標註一','標註二','外觀圖檔連結'];
const row = (id: string, first: string, second = '') => [id, '人工測試錠10毫克', 'TEST TABLETS 10MG', '圓形', '', '白', '', '', '', first, second, ''];
const csv = (rows: string[][]) => Buffer.from([headers, ...rows].map(values => values.map(value => `"${value.replaceAll('"','""')}"`).join(',')).join('\n'));
const observation = (imprints = ['FC16']): MedicationObservation => ({ name: '', strength: '', dosageForm: '', appearance: { shape: '', color: '', imprints } });
function database(t: TestContext) { const db = openDrugDatabase(':memory:'); t.after(() => db.close()); return db; }

test('Imprint comparison only offers one substituted character in a complete 3–16 character imprint', () => {
  assert.deepEqual(imprintDifference('ＦＣ １６', 'FC 10'), { position: 4, from: '6', to: '0' });
  assert.deepEqual(imprintDifference('FY C0I4', 'FY C014'), { position: 5, from: 'I', to: '1' });
  for (const [a,b] of [['FC10','fc 10'],['FC1','FC10'],['FC100','FC10'],['FC01','FC10'],['AB/25','AB125'],['KBF','SKKBT'],['FC\n16','FC10'],['C','G'],['12','13'],['?C16','FC16'],['a'.repeat(17),'a'.repeat(16)+'b']])
    assert.equal(imprintDifference(a,b), null, `${a} -> ${b}`);
  assert.deepEqual(imprintSuggestionInputs(observation(['FC16','C'])), [{ index: 0, text: 'FC16' }]);
});

test('A failed imprint search offers distinct source comparisons without changing the exact query or source records', t => {
  const db = database(t);
  importAppearance(db, csv([row('ONE','FC 10'), row('OTHER','UC16'), row('DUPLICATE','fc10')]), 'synthetic.csv');
  const input = observation(), copy = structuredClone(input), before = db.prepare('SELECT * FROM tfda_appearances ORDER BY id').all();
  assert.equal(matchObservation(db,input).total,0);
  const result = suggestLocalImprints(db,input);
  assert.deepEqual(result,{suggestions:[{index:0,text:'fc10',count:2},{index:0,text:'UC16',count:1}],hasMore:false});
  assert.deepEqual(input,copy); assert.deepEqual(db.prepare('SELECT * FROM tfda_appearances ORDER BY id').all(),before);
  assert.equal(matchObservation(db,input).total,0);
  assert.equal(matchObservation(db,applyImprintSuggestion(input,result.suggestions[0])).total,2);
  assert.deepEqual(suggestLocalImprints(db,observation(['FC10'])),{suggestions:[],hasMore:false});
});

test('Manual corrections keep name, strength, form, colors, shape and the other face; never fix two faces together', t => {
  const db = database(t);
  importTfda(db,[{許可證字號:'ONE',中文品名:'人工測試錠10毫克',英文品名:'TEST TABLETS 10MG',主成分略述:'ALPHA',劑型:'錠劑'}]);
  importAppearance(db,csv([row('ONE','FC10','YSX')]),'synthetic.csv');
  const input: MedicationObservation = {...observation(['FC16','YSX']),name:'TEST',strength:'10mg',dosageForm:'錠劑',appearance:{shape:'圓形',color:'白',imprints:['FC16','YSX']}};
  assert.equal(suggestLocalImprints(db,input).suggestions.length,1);
  const corrected = applyImprintSuggestion(input,{index:0,text:'FC10'});
  assert.deepEqual(corrected,{...input,appearance:{...input.appearance!,imprints:['FC10','YSX']}});
  for (const altered of [
    {...input,name:'NONEXISTENT'}, {...input,strength:'20mg'}, {...input,dosageForm:'內服液劑'},
    {...input,appearance:{...input.appearance!,shape:'橢圓形'}}, {...input,appearance:{...input.appearance!,color:'紅'}},
    {...input,appearance:{...input.appearance!,imprints:['FC16','YSZ']}},
  ]) assert.deepEqual(suggestLocalImprints(db,altered),{suggestions:[],hasMore:false});
  const back = suggestLocalImprints(db,observation(['FC10','YSZ']));
  assert.deepEqual(back.suggestions,[{index:1,text:'YSX',count:1}]);
  assert.throws(()=>applyImprintSuggestion(input,{index:2,text:'FC10'}));
  assert.throws(()=>applyImprintSuggestion(input,{index:0,text:'10'}));
});

test('Split-field comparisons use both source columns, not alternatives in one column, and reflect imports immediately', t => {
  const db = database(t);
  importAppearance(db,csv([row('SPLIT','FY','C014'),row('ALTERNATIVES','FY;;;C014')]),'synthetic.csv');
  const input = observation(['FYC0I4']);
  assert.deepEqual(suggestLocalImprints(db,input),{suggestions:[{index:0,text:'FY C014',count:1}],hasMore:false});
  assert.equal(matchObservation(db,input).total,0);
  assert.equal(matchObservation(db,applyImprintSuggestion(input,{index:0,text:'FY C014'})).total,1);
  importAppearance(db,csv([row('ALTERNATIVES','FY;;;C014')]),'updated.csv');
  assert.deepEqual(suggestLocalImprints(db,input),{suggestions:[],hasMore:false});
});

test('Suggestions are bounded, ordered independently of expected identity and exclude punctuation or multiple changes', t => {
  const db = database(t);
  importAppearance(db,csv(Array.from({length:10},(_,i)=>row(`ID${i}`,`ABC${i}`)).concat([row('PUNCT','ABC/'),row('TWO','AZZQ')])), 'synthetic.csv');
  const result = suggestLocalImprints(db,observation(['ABCQ']));
  assert.equal(result.suggestions.length,8);assert.equal(result.hasMore,true);
  assert.deepEqual(result.suggestions.map(s=>s.text),Array.from({length:8},(_,i)=>`ABC${i}`));
  for(const text of ['AB','ABC?',"';--",'ABC\nQ'])assert.deepEqual(suggestLocalImprints(db,observation([text])),{suggestions:[],hasMore:false});
});

test('Imprint suggestion HTTP validates input, distinguishes missing data and stays local', async t => {
  const db = database(t); let externalCalls = 0;
  const app=express();app.use(express.json());app.use('/meds',medicationRouter(db,new DrugProviders(db,(async()=>{externalCalls++;throw Error('External call');}) as typeof fetch)));
  const server=await listenForFetch(app);t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/meds/imprint-suggestions`;
  const post=(body:unknown)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({observation:observation()})).status,503);
  importTfda(db,[{許可證字號:'ONE',中文品名:'人工測試錠',英文品名:'TEST TABLETS',主成分略述:'ALPHA'}]);
  const missing=await post({observation:observation()});assert.equal(missing.status,503);assert.match((await missing.json()).error,/外觀資料尚未安裝/);
  importAppearance(db,csv([row('ONE','FC10')]),'synthetic.csv');
  assert.deepEqual(await(await post({observation:observation()})).json(),{suggestions:[{index:0,text:'FC10',count:1}],hasMore:false});
  for(const body of [{},{observation:null},{observation:{...observation(),strength:42}},{observation:observation(['a'.repeat(121)])},{observation:observation(['A','B','C'])}])
    assert.equal((await post(body)).status,400);
  assert.equal((await post({observation:observation(['?'])})).status,200);
  assert.equal(externalCalls,0);
});
