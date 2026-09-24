import { useRef, useState } from 'react';
import { api } from '../api/client';

// Phone photos are 3–12 MB; OCR doesn't need that. Images are scaled to at
// most 2200px on the long side and re-encoded as JPEG before upload, which
// also converts HEIC on iPhones (Safari decodes it for us). Uses only
// <canvas> and createImageBitmap — no secure-context APIs, so it works over
// plain HTTP on the LAN. The camera opens through <input capture>, not
// getUserMedia, for the same reason.
const MAX_SIDE = 2200;

async function shrink(file: File): Promise<{ blob: Blob; name: string }> {
  if (file.type === 'application/pdf' || !file.type.startsWith('image/')) return { blob: file, name: file.name };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
    if (!blob) return { blob: file, name: file.name };
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
  } catch {
    return { blob: file, name: file.name };
  }
}

export default function ReceiptUpload({
  transactionId,
  onUploaded,
  compact = false,
}: {
  transactionId?: string;
  onUploaded: (ids: string[]) => void;
  compact?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  async function upload(list: FileList | File[] | null) {
    const files = list ? Array.from(list) : [];
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      const shrunk = await Promise.all(files.map(shrink));
      const res = await api.uploadReceipts(
        shrunk.map((s) => s.blob),
        shrunk.map((s) => s.name),
        transactionId
      );
      onUploaded(res.ids);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
      if (cameraRef.current) cameraRef.current.value = '';
    }
  }

  const inputs = (
    <>
      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => upload(e.target.files)} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => upload(e.target.files)} />
    </>
  );

  if (compact) {
    return (
      <span className="row">
        {inputs}
        <button onClick={() => cameraRef.current?.click()} disabled={busy}>
          📷 Photo of slip
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? 'Uploading…' : 'Choose file'}
        </button>
        {error && <span className="error small">{error}</span>}
      </span>
    );
  }

  return (
    <div
      className={`dropzone${drag ? ' drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        upload(e.dataTransfer.files);
      }}
    >
      {inputs}
      <p style={{ marginTop: 0 }}>Drop slip photos or PDF e-slips here</p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="primary" onClick={() => cameraRef.current?.click()} disabled={busy}>
          📷 Take photo
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? 'Uploading…' : 'Choose files'}
        </button>
      </div>
      {error && (
        <div className="error small" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
          {error}
        </div>
      )}
    </div>
  );
}
