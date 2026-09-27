const release = (stream: MediaStream) => stream.getTracks().forEach(track => track.stop());

// getUserMedia cannot be aborted. A late result must release its own stream,
// never attach to a newer camera view or report an error in that view.
export function createCameraSession(getStream?: () => Promise<MediaStream>) {
  let revision = 0, current: MediaStream | null = null;
  const stop = () => {
    revision++;
    const previous = current; current = null;
    if (previous) release(previous);
  };
  return {
    stop,
    isCurrent: (stream: MediaStream | null) => !!stream && current === stream,
    async start() {
      stop();
      const request = revision;
      try {
        if (!getStream) throw new Error('此瀏覽器無法使用相機，請改用上傳檔案。');
        const stream = await getStream();
        if (request !== revision) { release(stream); return null; }
        if (!stream.getVideoTracks().some(track => track.readyState === 'live')) {
          release(stream); throw new Error('相機沒有提供可用畫面，請重新啟動或改用上傳檔案。');
        }
        current = stream;
        return stream;
      } catch (error) {
        if (request !== revision) return null;
        throw error;
      }
    },
  };
}

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '未取得相機使用權限，請確認此網站的相機權限，或取消後改用上傳檔案。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '找不到可用的相機，請接上相機後重試，或改用上傳檔案。';
  if (name === 'NotReadableError' || name === 'TrackStartError') return '相機可能正被其他程式使用或無法啟動，請關閉其他相機程式後重試。';
  if (name === 'Error' && error instanceof Error) return error.message;
  return '無法取得相機畫面，請重試或取消後改用上傳檔案。';
}

export function cameraFrameSize(width: number, height: number) {
  if (![width, height].every(value => Number.isFinite(value) && value >= 1)) throw new Error('相機畫面尚未就緒，請稍候再拍攝。');
  const scale = Math.min(1, 1800 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function captureCameraPhoto(video: HTMLVideoElement, makeCanvas = () => document.createElement('canvas')): Promise<File> {
  if (video.readyState < 2) throw new Error('相機畫面尚未就緒，請稍候再拍攝。');
  const size = cameraFrameSize(video.videoWidth, video.videoHeight);
  const canvas = makeCanvas(); canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('無法擷取照片，請重試或改用上傳檔案。');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => {
    if (value?.size) resolve(value);
    else reject(new Error('照片未能儲存，請重新拍攝或改用上傳檔案。'));
  }, 'image/jpeg', 0.9));
  return new File([blob], blob.type === 'image/png' ? '藥物照片.png' : '藥物照片.jpg', { type: blob.type });
}
