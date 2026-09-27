import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cameraErrorMessage, captureCameraPhoto, createCameraSession } from '../services/camera';

export default function CameraDialog({ onCapture, onClose }: { onCapture: (file: File) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), video = useRef<HTMLVideoElement>(null);
  const session = useRef<ReturnType<typeof createCameraSession> | null>(null);
  const [phase, setPhase] = useState<'opening' | 'ready' | 'capturing' | 'error'>('opening');
  const [error, setError] = useState('');
  const titleId = useId();
  const close = () => { session.current?.stop(); if (video.current) video.current.srcObject = null; dialog.current?.close(); onClose(); };

  async function start(camera: ReturnType<typeof createCameraSession>) {
    setPhase('opening'); setError('');
    if (video.current) video.current.srcObject = null;
    try {
      const media = await camera.start();
      if (!media) return;
      const target = video.current;
      if (!target) { camera.stop(); return; }
      const interrupted = () => {
        if (!camera.isCurrent(media)) return;
        camera.stop(); target.srcObject = null;
        setError('相機連線已中斷，請重新啟動或改用上傳檔案。'); setPhase('error');
      };
      media.getVideoTracks().forEach(track => track.addEventListener('ended', interrupted, { once: true }));
      target.srcObject = media;
      try { await target.play(); }
      catch (cause) {
        if (!camera.isCurrent(media)) return;
        camera.stop(); target.srcObject = null; throw cause;
      }
      if (camera.isCurrent(media) && target.readyState >= 2 && target.videoWidth && target.videoHeight) setPhase('ready');
    } catch (cause) {
      // start() suppresses failures from cancelled permission requests.
      setError(cameraErrorMessage(cause)); setPhase('error');
    }
  }

  useEffect(() => {
    const element = dialog.current, target = video.current;
    const devices = navigator.mediaDevices;
    const camera = createCameraSession(devices?.getUserMedia ? () => devices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }) : undefined);
    session.current = camera;
    element?.showModal(); void start(camera);
    return () => { camera.stop(); if (target) target.srcObject = null; element?.close(); };
  }, []);

  async function capture() {
    const camera = session.current, target = video.current;
    const media = target?.srcObject as MediaStream | null;
    if (phase !== 'ready' || !camera || !target || !camera.isCurrent(media)) return;
    setPhase('capturing'); setError('');
    try {
      const file = await captureCameraPhoto(target);
      if (!camera.isCurrent(media)) return;
      onCapture(file); close();
    } catch (cause) {
      if (camera.isCurrent(media)) { setError(cameraErrorMessage(cause)); setPhase('error'); }
    }
  }

  return createPortal(<dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}
    className="m-auto max-h-[94dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl bg-slate-950 p-5 text-white backdrop:bg-slate-950/70">
    <h3 id={titleId} className="font-bold text-lg">拍攝藥物照片</h3>
    <p className="mt-2 text-sm text-slate-300">請將藥品或文字放在畫面中，等畫面清楚後再拍攝。</p>
    <video ref={video} autoPlay muted playsInline aria-label="相機預覽" className="mx-auto mt-4 max-h-[60dvh] max-w-full rounded-lg"
      onLoadedData={() => { const target = video.current; if (phase === 'opening' && target?.videoWidth && target.videoHeight && session.current?.isCurrent(target.srcObject as MediaStream)) setPhase('ready'); }} />
    {phase === 'opening' && <p role="status" className="mt-3 text-sm">正在開啟相機，請確認瀏覽器的權限提示…</p>}
    {phase === 'capturing' && <p role="status" className="mt-3 text-sm">正在擷取照片…</p>}
    {error && <p role="alert" className="mt-3 rounded-lg bg-red-950 p-3 text-sm text-red-100">{error}</p>}
    <div className="mt-4 flex flex-wrap gap-3">
      <button type="button" autoFocus onClick={close} className="rounded-xl border border-slate-500 px-4 py-2.5 text-sm">取消</button>
      {phase === 'error' && <button type="button" onClick={() => session.current && void start(session.current)} className="rounded-xl border border-slate-500 px-4 py-2.5 text-sm">重試相機</button>}
      <button type="button" disabled={phase !== 'ready'} onClick={() => void capture()} className="rounded-xl bg-emerald-700 px-4 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-50">拍攝照片</button>
    </div>
  </dialog>, document.body);
}
