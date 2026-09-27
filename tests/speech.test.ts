import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSpeechEnvironment, createSpeechController, speechChunks, type SpeechEnvironment } from '../src/services/speech';

function fixture(env: SpeechEnvironment = {}) {
  const transcripts: string[] = [], errors: string[] = [];
  let listening = false, speaking: string | null = null;
  const controller = createSpeechController(env, {
    onListening: value => { listening = value; }, onSpeaking: value => { speaking = value; },
    onTranscript: text => transcripts.push(text), onError: text => errors.push(text),
  });
  return { controller, transcripts, errors, get listening() { return listening; }, get speaking() { return speaking; } };
}
function recognizer() {
  return { lang: '', continuous: true, interimResults: true,
    onstart: null, onend: null, onerror: null, onresult: null,
    started: 0, stopped: 0, aborted: 0,
    start() { this.started++; }, stop() { this.stopped++; }, abort() { this.aborted++; },
  };
}
const result = (text: string) => ({ results: [[{ transcript: text }]] });

test('Unavailable speech APIs do not crash consultation setup or cleanup', () => {
  const env = browserSpeechEnvironment({} as Window);
  const f = fixture(env);
  assert.doesNotThrow(() => f.controller.cancel());
  f.controller.toggleListening(); f.controller.toggleSpeech('test');
  assert.equal(f.errors.length, 2);
  assert.match(f.errors[0], /不支援語音輸入/); assert.match(f.errors[1], /不支援語音播放/);
  assert.equal(f.listening, false); assert.equal(f.speaking, null);
});

test('Second microphone click stops the same recognition and accepts its final transcript', () => {
  const recognition = recognizer(); let created = 0;
  const f = fixture({ createRecognition: () => { created++; return recognition; } });
  f.controller.toggleListening(); f.controller.toggleListening();
  assert.equal(created, 1); assert.equal(recognition.started, 1); assert.equal(recognition.stopped, 1);
  assert.equal(recognition.lang, 'zh-TW'); assert.equal(recognition.interimResults, false);
  recognition.onresult!(result(' 三十歲 ')); recognition.onend!();
  assert.deepEqual(f.transcripts, ['三十歲']); assert.equal(f.listening, false);
});

test('Switching consultation ignores queued voice events from the previous person', () => {
  const recognitions = [recognizer(), recognizer()]; let created = 0;
  const f = fixture({ createRecognition: () => recognitions[created++] });
  f.controller.toggleListening(); const previous = recognitions[0];
  f.controller.cancel(); f.controller.toggleListening();
  previous.onresult!(result('上一位病人的資料')); previous.onend!(); previous.onerror!({ error: 'network' });
  assert.equal(previous.aborted, 1); assert.equal(f.listening, true);
  assert.deepEqual(f.transcripts, []); assert.deepEqual(f.errors, []);
  recognitions[1].onresult!(result('目前對象')); recognitions[1].onend!();
  assert.deepEqual(f.transcripts, ['目前對象']); assert.equal(f.listening, false);
});

test('Permission, missing device and start failures release listening state and allow retry', () => {
  for (const error of ['not-allowed', 'audio-capture', 'no-speech', 'network']) {
    const recognition = recognizer(); const f = fixture({ createRecognition: () => recognition });
    f.controller.toggleListening(); recognition.onerror!({ error });
    assert.equal(f.listening, false); assert.equal(f.errors.length, 1);
    f.controller.toggleListening(); assert.equal(recognition.started, 2);
    f.controller.cancel(); assert.equal(f.listening, false);
  }
  const f = fixture({ createRecognition: () => ({ ...recognizer(), start() { throw new Error('device failure'); } }) });
  assert.doesNotThrow(() => f.controller.toggleListening());
  assert.equal(f.listening, false); assert.match(f.errors[0], /無法啟動/);
});

test('Queued speech can be stopped immediately; older callbacks cannot clear a newer playback', () => {
  const utterances: SpeechSynthesisUtterance[] = [];
  const recognition = recognizer();
  const f = fixture({ createRecognition: () => recognition,
    createUtterance: text => ({ text, onend: null, onerror: null } as SpeechSynthesisUtterance),
    synthesis: { getVoices: () => [], cancel: () => {}, speak: value => { utterances.push(value); } },
  });
  f.controller.toggleListening(); f.controller.toggleSpeech('第一段');
  assert.equal(recognition.aborted, 1); assert.equal(f.listening, false); assert.equal(f.speaking, '第一段');
  f.controller.toggleSpeech('第二段');
  utterances[0].onend!(null!); utterances[0].onerror!(null!);
  assert.equal(f.speaking, '第二段'); assert.equal(f.errors.length, 0);
  f.controller.toggleSpeech('第二段'); assert.equal(f.speaking, null); assert.equal(utterances.length, 2);
  f.controller.toggleSpeech('第三段'); utterances[2].onerror!(null!);
  assert.equal(f.speaking, null); assert.match(f.errors[0], /語音播放未完成/);
});

test('Long displayed text is bounded without losing content, decimal strengths or Unicode characters', () => {
  const text = ('測試資料，不是處方。\n濃度 0.4mg/mL、規格 500mg、0.5–1.5 mg、日期 2026-09-23。\n'
    + '每個完整段落都有來源名稱與最後的限制條件。 🧪 '.repeat(8)).repeat(130) + '最後一句不得遺失。';
  assert.ok(text.length > 32767);
  const chunks = speechChunks(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 240 && chunk.length > 0));
  assert.equal(chunks.filter(chunk => chunk.includes('0.4mg/mL')).length, 130);
  assert.equal(chunks.filter(chunk => chunk.includes('2026-09-23')).length, 130);
  assert.ok(chunks.every(chunk => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk)));
  const unbroken = 'x'.repeat(1000) + '🧪'.repeat(300);
  assert.equal(speechChunks(unbroken).join(''), unbroken);
  assert.ok(speechChunks(unbroken).every(chunk => chunk.length <= 240));
  assert.deepEqual(speechChunks(' \n\t'), []);
});

function playbackFixture() {
  const queued: SpeechSynthesisUtterance[] = [];
  const f = fixture({ createUtterance: text => ({ text } as SpeechSynthesisUtterance),
    synthesis: { getVoices: () => [], cancel: () => { queued.at(-1)?.onend?.(null!); }, speak: value => { queued.push(value); } },
  });
  return { ...f, queued, state: f };
}

test('Long playback queues one segment at a time and reaches the full ending without stale events skipping content', () => {
  const f = playbackFixture();
  const text = '合成報告的文字與數值 0.4mg/mL。\n'.repeat(1500) + '報告結束。';
  f.controller.toggleSpeech(text, 'report');
  assert.equal(f.queued.length, 1);
  f.queued[0].onend!(null!);
  assert.equal(f.queued.length, 2);
  f.queued[0].onend!(null!); f.queued[0].onerror!(null!);
  assert.equal(f.queued.length, 2);
  for (let index = 1; index < f.queued.length; index++) {
    assert.equal(f.state.speaking, 'report');
    f.queued[index].onend!(null!);
  }
  assert.equal(f.queued.map(value => value.text).join(''), text);
  assert.equal(f.state.speaking, null);
  assert.deepEqual(f.errors, []);
});

test('Duplicate answers have separate controls; scoped cleanup and cancel cannot restart old segments', () => {
  const f = playbackFixture(), text = '測試一段相同的回答。'.repeat(100);
  f.controller.toggleSpeech(text, 'first');
  const first = f.queued[0];
  f.controller.toggleSpeech(text, 'second');
  assert.equal(f.state.speaking, 'second'); assert.equal(f.queued.length, 2);
  f.controller.stopSpeaking('first');
  first.onend!(null!); first.onerror!(null!);
  assert.equal(f.state.speaking, 'second'); assert.equal(f.queued.length, 2);
  f.controller.stopSpeaking('second');
  assert.equal(f.state.speaking, null); assert.equal(f.queued.length, 2);
  f.queued[1].onend!(null!);
  assert.equal(f.queued.length, 2);
  f.controller.toggleSpeech(text, 'second'); f.controller.toggleSpeech(text, 'second');
  assert.equal(f.state.speaking, null); assert.equal(f.queued.length, 3);
  assert.deepEqual(f.errors, []);
});

test('Failures while starting a later segment release playback and permit a clean retry', () => {
  for (const failingStep of ['create', 'voices', 'speak', 'event']) {
    const queued: SpeechSynthesisUtterance[] = [];
    let created = 0, fail = true;
    const shouldFail = (step: string) => {
      if (fail && created === 2 && failingStep === step) throw new Error('Synthetic engine failure');
    };
    const f = fixture({
      createUtterance: text => { created++; shouldFail('create'); return { text } as SpeechSynthesisUtterance; },
      synthesis: { cancel: () => {}, getVoices: () => { shouldFail('voices'); return []; },
        speak: value => { shouldFail('speak'); queued.push(value); } },
    });
    f.controller.toggleSpeech('第一段。\n第二段。\n不應播放的第三段。', 'test');
    assert.doesNotThrow(() => queued[0].onend!(null!));
    if (failingStep === 'event') queued[1].onerror!(null!);
    assert.equal(f.speaking, null); assert.equal(f.errors.length, 1);
    const count = queued.length;
    queued.at(-1)!.onend!(null!);
    assert.equal(queued.length, count);
    fail = false;
    f.controller.toggleSpeech('重試成功。', 'retry'); queued.at(-1)!.onend!(null!);
    assert.equal(f.speaking, null); assert.equal(f.errors.length, 1);
  }
});
