import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertAttachmentLimits, cropAttachment, restoreAttachment, MAX_FILE_BYTES, MAX_TOTAL_BYTES, type MedicationAttachment} from '../src/services/medication-files';
import {readMedicationScan} from '../src/services/medication-scan';

const original: MedicationAttachment = Object.freeze({id:'upload',name:'藥錠.正面.png',type:'image/png',size:6,data:'data:image/png;base64,AAAAAQID'});
const jpeg = (bytes: number) => `data:image/jpeg;base64,${Buffer.alloc(bytes,1).toString('base64')}`;

test('Repeated crops restore the original bytes, name and type without accumulating backups or filename suffixes', () => {
  const first = cropAttachment(original,jpeg(10));
  const second = cropAttachment(first,jpeg(11));
  assert.equal(second.name,'藥錠.正面-裁切.jpg');
  assert.equal(second.original,first.original);
  assert.equal(second.original?.data,original.data);
  assert.deepEqual(Object.keys(second.original!).sort(),['data','name','size','type']);
  const restored = restoreAttachment(second);
  assert.deepEqual({...restored,id:original.id},original);
  assert.equal(restored.original,undefined);
  assert.equal(new Set([original.id,first.id,second.id,restored.id]).size,4);
  assert.equal(restoreAttachment(original),original);
  assert.equal(cropAttachment(restored,jpeg(12)).original?.data,original.data);
});

test('Cropped byte sizes account for base64 padding and preserve the actual scan data', () => {
  for(const size of [9,10,11]) {
    const data=jpeg(size),cropped=cropAttachment(original,data);
    assert.equal(cropped.size,size);assert.equal(cropped.data,data);assert.equal(cropped.type,'image/jpeg');
  }
  assert.throws(()=>cropAttachment(original,'data:,'));
  assert.throws(()=>cropAttachment(original,original.data),/JPEG/);
  assert.throws(()=>cropAttachment({...original,type:'application/pdf'},jpeg(10)),/JPEG/);
});

test('Adding files reserves original sizes so restoring any photo stays within per-file and total limits', () => {
  const large={...original,size:MAX_FILE_BYTES};
  const cropped=cropAttachment(large,jpeg(100));
  const other={...original,id:'other',size:MAX_TOTAL_BYTES-MAX_FILE_BYTES};
  assert.doesNotThrow(()=>assertAttachmentLimits([cropped,other]));
  assert.doesNotThrow(()=>assertAttachmentLimits([restoreAttachment(cropped),other]));
  assert.throws(()=>assertAttachmentLimits([cropped,{...other,size:other.size+1}]),/12 MB/);
  assert.throws(()=>assertAttachmentLimits([{...cropped,size:MAX_FILE_BYTES+1}]),/8 MB/);
  assert.throws(()=>assertAttachmentLimits([cropAttachment({...large,size:MAX_FILE_BYTES+1},jpeg(10))]),/8 MB/);
  // A small compressed PNG can become a larger JPEG; both current and original must fit.
  assert.throws(()=>assertAttachmentLimits([{...cropAttachment(original,jpeg(10)),size:MAX_FILE_BYTES}, {...other,size:other.size+1}]),/12 MB/);
  assert.equal(large.data,original.data);
});

test('Optional cloud scanning receives only the current crop, and only the original after explicit restoration',async () => {
  const cropped=cropAttachment(original,jpeg(10));
  const sent:string[][]=[];
  const readers={local:async()=>[],gemini:async(data:string[])=>{sent.push(data);return [];}};
  const options={target:'label' as const,signal:new AbortController().signal,onProgress:()=>{}};
  await readMedicationScan('gemini',[cropped],'synthetic-test-key',options,readers);
  await readMedicationScan('gemini',[restoreAttachment(cropped)],'synthetic-test-key',options,readers);
  assert.deepEqual(sent,[[cropped.data],[original.data]]);
});
