import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraErrorMessage, cameraFrameSize, captureCameraPhoto, createCameraSession } from '../src/services/camera';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function media() {
  const tracks = [{ readyState: 'live', stops: 0, stop() { this.readyState = 'ended'; this.stops++; } }];
  return { stream: { getTracks: () => tracks, getVideoTracks: () => tracks } as unknown as MediaStream, tracks };
}

test('Cancelled camera permission results cannot replace a newer stream or leave tracks running', async () => {
  const old = deferred<MediaStream>(), recent = deferred<MediaStream>();
  let count = 0;
  const camera = createCameraSession(() => ++count === 1 ? old.promise : recent.promise);
  const first = camera.start(); camera.stop();
  const second = camera.start();
  const previousMedia = media(), currentMedia = media();
  recent.resolve(currentMedia.stream); assert.equal(await second, currentMedia.stream);
  old.resolve(previousMedia.stream); assert.equal(await first, null);
  assert.equal(previousMedia.tracks[0].readyState, 'ended');
  assert.equal(currentMedia.tracks[0].readyState, 'live');
  assert.equal(camera.isCurrent(currentMedia.stream), true);
  camera.stop(); camera.stop();
  assert.equal(currentMedia.tracks[0].stops, 1);
  assert.equal(camera.isCurrent(currentMedia.stream), false);
});

test('Late permission rejection is discarded; stop also invalidates an encoding operation using the old stream', async () => {
  const old = deferred<MediaStream>(), source = media();
  let count = 0;
  const camera = createCameraSession(() => ++count === 1 ? old.promise : Promise.resolve(source.stream));
  const first = camera.start();
  await camera.start();
  old.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  assert.equal(await first, null);
  assert.equal(camera.isCurrent(source.stream), true);
  camera.stop();
  assert.equal(camera.isCurrent(source.stream), false);
  assert.equal(source.tracks[0].readyState, 'ended');
});

test('Missing camera, denied permission and inactive video tracks fail clearly and permit retry', async () => {
  await assert.rejects(createCameraSession().start(), /無法使用相機/);
  for (const [name, message] of [['NotAllowedError', /權限/], ['NotFoundError', /找不到/], ['NotReadableError', /其他程式/]]) {
    const cause = Object.assign(new Error('synthetic failure'), { name });
    let fail = true;
    const source = media();
    const camera = createCameraSession(() => fail ? Promise.reject(cause) : Promise.resolve(source.stream));
    await assert.rejects(camera.start(), cause);
    assert.match(cameraErrorMessage(cause), message as RegExp);
    fail = false; assert.equal(await camera.start(), source.stream); camera.stop();
  }
  const inactive = media(); inactive.tracks[0].readyState = 'ended';
  await assert.rejects(createCameraSession(() => Promise.resolve(inactive.stream)).start(), /沒有提供可用畫面/);
  assert.equal(inactive.tracks[0].stops, 1);
});

test('Camera images preserve portrait and landscape proportions within the longest-edge bound', () => {
  assert.deepEqual(cameraFrameSize(1920, 1080), { width: 1800, height: 1013 });
  assert.deepEqual(cameraFrameSize(1080, 1920), { width: 1013, height: 1800 });
  assert.deepEqual(cameraFrameSize(640, 480), { width: 640, height: 480 });
  for (const [width, height] of [[0, 1080], [1080, 0], [NaN, 480], [640, Infinity], [-1, 480]]) assert.throws(() => cameraFrameSize(width, height), /尚未就緒/);
});

test('Capture refuses a missing frame or drawing context instead of silently adding a blank photo', async () => {
  const video = { readyState: 1, videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;
  await assert.rejects(captureCameraPhoto(video, () => { throw new Error('Canvas must not be touched'); }), /尚未就緒/);
  const readyVideo = { ...video, readyState: 2 } as HTMLVideoElement;
  await assert.rejects(captureCameraPhoto(readyVideo, () => ({ getContext: () => null } as unknown as HTMLCanvasElement)), /無法擷取/);
});

test('Capture encodes the current frame once and reports a missing image instead of silently closing', async () => {
  let drawn = 0;
  const video = { readyState: 2, videoWidth: 640, videoHeight: 480 } as HTMLVideoElement;
  const canvas = (fail = false) => ({ width: 0, height: 0,
    getContext: () => ({ drawImage: (source: HTMLVideoElement) => { assert.equal(source, video); drawn++; } }),
    toBlob: (done: BlobCallback, type: string) => { assert.equal(type, 'image/jpeg'); done(fail ? null : new Blob(['synthetic'], { type })); },
  } as unknown as HTMLCanvasElement);
  const file = await captureCameraPhoto(video, () => canvas());
  assert.equal(file.name, '藥物照片.jpg'); assert.equal(file.type, 'image/jpeg');
  assert.equal(await file.text(), 'synthetic'); assert.equal(drawn, 1);
  await assert.rejects(captureCameraPhoto(video, () => canvas(true)), /照片未能儲存/);
});
