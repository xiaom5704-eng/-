import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {openDrugDatabase} from '../server/medications/store';
import {VisionService} from '../server/vision/service';
import {DIMENSIONS,MODEL_VERSION} from '../server/vision/config.mjs';

function fixture(){
  const root=mkdtempSync(path.join(os.tmpdir(),'medsafe-vision-files-'));
  const images=path.join(root,'images'),models=path.join(root,'models'),file=path.join(root,'index.db');
  mkdirSync(images);mkdirSync(path.join(models,'onnx'),{recursive:true});
  writeFileSync(path.join(models,'onnx/model_quantized.onnx'),'synthetic');
  const drugs=openDrugDatabase(':memory:'),index=new Database(file);
  index.exec('CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE images(key TEXT,drug_id TEXT,source_url TEXT,sha256 TEXT,model TEXT,embedding BLOB);');
  index.prepare('INSERT INTO metadata VALUES(?,?)').run('index',JSON.stringify({state:'ready',modelVersion:MODEL_VERSION,indexedAt:'unchanged'}));
  const vector=new Float32Array(DIMENSIONS);vector[0]=1;
  const hashes=['a'.repeat(64),'b'.repeat(64)];
  for(const [i,sha] of hashes.entries()){
    const id=`SYNTHETIC-${i}`,url=`https://example.test/${i}.webp`;
    const drug={id,source:'tfda',name:id,englishName:id,ingredients:['SYNTHETIC'],dosageForm:'錠劑',manufacturer:'',licenseStatus:'',validUntil:'',indications:'',dosageText:'',sourceUrl:'https://example.test'};
    const appearance={shape:'圓形',color:'白',score:'',size:'',imprint1:'',imprint2:'',imageUrls:[url],sourceUrl:'https://example.test'};
    drugs.prepare('INSERT INTO tfda_drugs VALUES(?,?,?,?,?,?)').run(id,id,id,id,1,JSON.stringify(drug));
    drugs.prepare('INSERT INTO tfda_appearances VALUES(?,?,?,?,?)').run(id,id,id,id,JSON.stringify(appearance));
    const ref=vector.slice();if(i){ref[0]=.8;ref[1]=.6;}
    index.prepare('INSERT INTO images VALUES(?,?,?,?,?,?)').run(id,id,url,sha,MODEL_VERSION,Buffer.from(ref.buffer));
  }
  const filenames=hashes.map(sha=>path.join(images,`${sha}.webp`));
  const service=(embed=async()=>vector)=>new VisionService(drugs,file,images,models,embed);
  return {root,hashes,filenames,vector,service,close(){index.close();drugs.close();
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    rmSync(root,{recursive:true,force:true});}};
}

test('Missing reference images recover without restarting or rebuilding the unchanged index',async()=>{
  const f=fixture();try{
    const service=f.service();assert.equal(service.status().ready,false);
    writeFileSync(f.filenames[0],'synthetic');
    assert.equal(service.status().imageCount,1,'restored reference must become available');
    assert.equal((await service.search([Buffer.from('query')],'',new AbortController().signal)).candidates[0].drug.id,'SYNTHETIC-0');
    rmSync(f.filenames[0]);assert.equal(service.status().ready,false);
    assert.equal(service.imagePath(f.hashes[0]),null);
    writeFileSync(f.filenames[0],'synthetic');assert.equal(service.status().ready,true);
  }finally{f.close();}
});

test('Reference files removed during inference cannot remain visual candidates; directories are not images',async()=>{
  const f=fixture();try{
    for(const file of f.filenames)writeFileSync(file,'synthetic');
    const service=f.service(async()=>{rmSync(f.filenames[0]);mkdirSync(f.filenames[0]);return f.vector;});
    assert.equal(service.status().imageCount,2);
    const result=await service.search([Buffer.from('query')],'',new AbortController().signal);
    assert.deepEqual(result.candidates.map(c=>c.drug.id),['SYNTHETIC-1']);
    assert.equal(result.status.imageCount,1);
    assert.equal(service.imagePath(f.hashes[0]),null);
    assert.equal(service.status().imageCount,1);
  }finally{f.close();}
});
