import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readMedicationPhoto, type LocalOcrOptions} from '../src/services/medication-scan';
import type {VisionResult} from '../shared/medication-vision';
import type {OcrPage} from '../shared/medication-ocr';

const files=[{name:'synthetic.png',data:'data:image/png;base64,AAAA'}];
const pages:OcrPage[]=[{fileName:'synthetic.png',page:1,text:'TEST\n10',confidence:80}];
const vision:VisionResult={status:{ready:true,imageCount:1,drugCount:1,model:'synthetic'},candidates:[],outcome:'low_similarity',warnings:[]};
const options=(controller=new AbortController()):LocalOcrOptions=>({target:'label',imprint:'MANUAL',signal:controller.signal,onProgress:()=>{}});
const cloud=async()=>{assert.fail('Combined local scans must never call Gemini');};
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

test('Photo and OCR start together, retain separate evidence and use the correct target',async()=>{
 for(const engine of ['vision','package'] as const){
  const image=deferred<VisionResult>(),text=deferred<OcrPage[]>(),calls:string[]=[];
  const result=readMedicationPhoto(engine,files,options(),{
   [engine]:async(input:typeof files,config:LocalOcrOptions)=>{calls.push('image');assert.deepEqual(input,files);assert.equal(config.imprint,'MANUAL');return image.promise;},
   local:async(input,config)=>{calls.push('text');assert.deepEqual(input,files);assert.equal(config.target,engine==='vision'?'pill':'label');return text.promise;},gemini:cloud,
  });
  await Promise.resolve();assert.deepEqual(calls,['image','text']);
  text.resolve(pages);image.resolve(vision);
  assert.deepEqual(await result,{vision,pages,issues:[]});
 }
});

test('Missing image index retains OCR; failed OCR retains image candidates',async()=>{
 const noIndex=await readMedicationPhoto('vision',files,options(),{vision:async()=>{throw Error('index unavailable');},local:async()=>pages,gemini:cloud});
 assert.equal(noIndex.vision,null);assert.deepEqual(noIndex.pages,pages);assert.match(noIndex.issues.join(' '),/圖片比對.*index unavailable/);
 const noText=await readMedicationPhoto('package',files,options(),{package:async()=>vision,local:async()=>{throw Error('OCR unavailable');},gemini:cloud});
 assert.equal(noText.vision,vision);assert.deepEqual(noText.pages,[]);assert.match(noText.issues.join(' '),/文字讀取.*OCR unavailable/);
});

test('No readable text is preserved as an empty reading, without guessing an imprint',async()=>{
 const blank=[{...pages[0],text:'',confidence:0}];let imageCalls=0;
 const result=await readMedicationPhoto('vision',files,options(),{vision:async()=>{imageCalls++;return vision;},local:async()=>blank,gemini:cloud});
 assert.deepEqual(result.pages,blank);assert.deepEqual(result.issues,[]);assert.equal(imageCalls,1);
});

test('Both failures produce a recoverable error naming each source',async()=>{
 await assert.rejects(readMedicationPhoto('vision',files,options(),{vision:async()=>{throw Error('index unavailable');},local:async()=>{throw Error('OCR unavailable');},gemini:cloud}),error=>{
  assert.match(String(error),/圖片比對.*index unavailable/);assert.match(String(error),/文字讀取.*OCR unavailable/);return true;
 });
});

test('Cancel promptly discards late results even if an underlying reader ignores cancellation',async()=>{
 const controller=new AbortController(),image=deferred<VisionResult>(),text=deferred<OcrPage[]>(),progress:string[]=[];
 let config:LocalOcrOptions;
 const result=readMedicationPhoto('vision',files,{...options(controller),onProgress:message=>progress.push(message)},
  {vision:async(_input,opts)=>{config=opts;return image.promise;},local:async()=>text.promise,gemini:cloud});
 await Promise.resolve();controller.abort();
 await assert.rejects(result,{name:'AbortError'});
 const before=progress.length;config!.onProgress('late update');image.resolve(vision);text.resolve(pages);
 await Promise.resolve();await Promise.resolve();assert.equal(progress.length,before);
});

test('Invalid photo batches and pre-cancellation never start either local reader',async()=>{
 let calls=0;const dependencies={local:async()=>{calls++;return pages;},vision:async()=>{calls++;return vision;},gemini:cloud};
 for(const invalid of [[],Array(3).fill(files[0]),[{name:'test.pdf',data:'data:application/pdf;base64,AAAA'}]])
  await assert.rejects(readMedicationPhoto('vision',invalid,options(),dependencies),/1–2 張照片/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(readMedicationPhoto('vision',files,options(controller),dependencies),{name:'AbortError'});assert.equal(calls,0);
});
