import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import type { CompressOutput, WorkerRequest, WorkerResponse, OutputFormat, PerceptualLevel } from './lib/types';
import {
  isNative,
  pickImagesNative,
  replaceImageNative,
  saveImageNative,
  downloadBlob,
  base64ToArrayBuffer,
  requestPermissions,
  requestWritePermissions,
  type PickedImage,
} from './native/replacePlugin';

interface ImageItem {
  id: string;
  name: string;
  originalSize: number;
  mimeType: string;
  thumbnailUrl: string;
  contentUri?: string;
  data: ArrayBuffer;
  status: 'pending' | 'processing' | 'done' | 'failed';
  result?: CompressOutput;
  resultUrl?: string;
  replaced: boolean;
  errorReason?: string;
}

const FORMATS: { value: Exclude<OutputFormat, 'auto'>; label: string }[] = [
  { value: 'webp', label: 'WebP' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'avif', label: 'AVIF' },
  { value: 'png', label: 'PNG' },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function extFromMime(mime: string): string {
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('avif')) return 'avif';
  if (mime.includes('png')) return 'png';
  return 'img';
}

export function App() {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [format, setFormat] = useState<OutputFormat | null>(null);
  const [quality, setQuality] = useState(75);
  const [visuallyLossless, setVisuallyLossless] = useState(false);
  const [perceptualLevel, setPerceptualLevel] = useState<PerceptualLevel>('normal');
  const [processing, setProcessing] = useState(false);
  const [compressProgress, setCompressProgress] = useState(0);
  const [replacing, setReplacing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerPoolRef = useRef<Worker[]>([]);
  const cancelRef = useRef(false);

  useEffect(() => {
    const count = Math.min(6, Math.max(2, (navigator.hardwareConcurrency || 4)));
    const pool: Worker[] = [];
    for (let i = 0; i < count; i++) {
      pool.push(new Worker(new URL('./workers/compress.worker.ts', import.meta.url), { type: 'module' }));
    }
    workerPoolRef.current = pool;
    requestPermissions().catch(() => {});
    return () => pool.forEach((w) => w.terminate());
  }, []);

  const addFromFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    const promises: Promise<ImageItem | null>[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      promises.push(
        file.arrayBuffer().then((data): ImageItem => ({
          id: crypto.randomUUID(),
          name: file.name,
          originalSize: file.size,
          mimeType: file.type,
          thumbnailUrl: URL.createObjectURL(file),
          data,
          status: 'pending',
          replaced: false,
        })),
      );
    }
    Promise.all(promises).then((items) => {
      const valid = items.filter((i): i is ImageItem => i !== null);
      if (valid.length > 0) setImages((prev) => [...prev, ...valid]);
    });
  }, []);

  const addFromNative = useCallback((picked: PickedImage[]) => {
    const items: ImageItem[] = picked.map((p) => {
      const data = base64ToArrayBuffer(p.base64);
      const blob = new Blob([data], { type: p.mimeType });
      return {
        id: p.id,
        name: p.name,
        originalSize: p.size,
        mimeType: p.mimeType,
        thumbnailUrl: URL.createObjectURL(blob),
        contentUri: p.contentUri,
        data,
        status: 'pending' as const,
        replaced: false,
      };
    });
    setImages((prev) => [...prev, ...items]);
  }, []);

  const handlePick = useCallback(async () => {
    if (isNative()) {
      try {
        const picked = await pickImagesNative();
        if (picked.length > 0) addFromNative(picked);
      } catch (err) {
        alert('选择图片失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [addFromNative]);

  const compress = useCallback(async () => {
    const pool = workerPoolRef.current;
    if (pool.length === 0 || images.length === 0) return;
    setProcessing(true);
    setCompressProgress(0);
    cancelRef.current = false;

    const pending = images.filter((img) => img.status === 'pending' || img.status === 'failed');
    const total = pending.length;
    let completed = 0;
    let taskIndex = 0;

    const runWorker = async (worker: Worker) => {
      while (taskIndex < pending.length && !cancelRef.current) {
        const myIndex = taskIndex++;
        const item = pending[myIndex];
        setImages((prev) => prev.map((img) => (img.id === item.id ? { ...img, status: 'processing' } : img)));
        try {
          const buffer = item.data.slice(0);
          const request: WorkerRequest = {
            type: visuallyLossless ? 'visuallyLossless' : 'compress',
            id: item.id,
            buffer,
            mimeType: item.mimeType,
            format: format ?? 'auto',
            quality,
            perceptualLevel: visuallyLossless ? perceptualLevel : undefined,
          };
          const result = await new Promise<CompressOutput>((resolve, reject) => {
            const handler = (e: MessageEvent<WorkerResponse>) => {
              const msg = e.data;
              if (msg.id !== item.id) return;
              worker.removeEventListener('message', handler);
              if (msg.type === 'success') resolve(msg.result);
              else reject(new Error(msg.error));
            };
            worker.addEventListener('message', handler);
            worker.postMessage(request, { transfer: [buffer] });
          });
          if (cancelRef.current) break;
          const resultUrl = URL.createObjectURL(new Blob([result.buffer], { type: result.mimeType }));
          setImages((prev) =>
            prev.map((img) => (img.id === item.id ? { ...img, status: 'done', result, resultUrl } : img)),
          );
        } catch (err) {
          if (cancelRef.current) break;
          setImages((prev) =>
            prev.map((img) =>
              img.id === item.id ? { ...img, status: 'failed', errorReason: err instanceof Error ? err.message : String(err) } : img,
            ),
          );
        }
        completed++;
        setCompressProgress(Math.round((completed / total) * 100));
      }
    };

    await Promise.all(pool.map((w) => runWorker(w)));
    if (cancelRef.current) {
      setImages((prev) => prev.map((img) => img.status === 'processing' ? { ...img, status: 'pending' } : img));
    }
    setProcessing(false);
    setCompressProgress(0);
  }, [images, format, quality, visuallyLossless, perceptualLevel]);

  const cancelCompress = useCallback(() => {
    cancelRef.current = true;
    workerPoolRef.current.forEach((w) => w.terminate());
    const count = Math.min(6, Math.max(2, (navigator.hardwareConcurrency || 4)));
    const pool: Worker[] = [];
    for (let i = 0; i < count; i++) {
      pool.push(new Worker(new URL('./workers/compress.worker.ts', import.meta.url), { type: 'module' }));
    }
    workerPoolRef.current = pool;
  }, []);

  const native = isNative();

  const replaceOriginal = useCallback(async (item: ImageItem) => {
    if (!item.result) return;
    if (isNative() && !confirm('替换原图需要授权覆盖写入，接下来系统会弹出授权对话框，请点"允许"')) {
      return;
    }
    try {
      if (isNative() && item.contentUri) {
        await replaceImageNative(item.contentUri, item.result.buffer, item.result.mimeType);
      } else {
        downloadBlob(item.result.buffer, item.result.mimeType, 'compressed-' + item.name);
      }
      setImages((prev) => prev.map((img) => (img.id === item.id ? { ...img, replaced: true } : img)));
    } catch (err) {
      alert('替换失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, []);


  const replaceAll = useCallback(async () => {
    const toReplace = images.filter(
      (img) => img.status === 'done' && !img.replaced && img.result && (native ? img.contentUri : true),
    );
    if (toReplace.length === 0) return;
    if (native) {
      if (!confirm(`将替换 ${toReplace.length} 张原图，接下来只弹出一次授权对话框，请点击"允许"。`)) {
        return;
      }
      try {
        await requestWritePermissions(toReplace.map((img) => img.contentUri!));
      } catch (err) {
        alert('授权失败，无法替换原图: ' + (err instanceof Error ? err.message : String(err)));
        return;
      }
    }
    setReplacing(true);
    let failed = 0;
    for (const item of toReplace) {
      try {
        if (native && item.contentUri) {
          await replaceImageNative(item.contentUri, item.result!.buffer, item.result!.mimeType);
        } else {
          downloadBlob(item.result!.buffer, item.result!.mimeType, 'compressed-' + item.name);
        }
        setImages((prev) => prev.map((img) => (img.id === item.id ? { ...img, replaced: true } : img)));
      } catch {
        failed++;
      }
    }
    setReplacing(false);
    if (failed > 0) alert(`${toReplace.length - failed} 张替换成功，${failed} 张失败`);
  }, [images, native]);

  const saveToGallery = useCallback(async (item: ImageItem) => {
    if (!item.result) return;
    try {
      if (isNative()) {
        const displayName = 'compressed-' + item.name.replace(/\.[^.]+$/, '') + '.' + extFromMime(item.result.mimeType);
        await saveImageNative(item.result.buffer, item.result.mimeType, displayName);
      } else {
        downloadBlob(item.result.buffer, item.result.mimeType, 'compressed-' + item.name);
      }
      setImages((prev) => prev.map((img) => (img.id === item.id ? { ...img, replaced: true } : img)));
    } catch (err) {
      alert('保存失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, []);

  const doneCount = images.filter((i) => i.status === 'done').length;
  const totalSaved = images.reduce((sum, i) => sum + (i.result ? i.originalSize - i.result.byteLength : 0), 0);


  return (
    <div class="app">
      <div class="header">
        <h1>图片压缩</h1>
        {images.length > 0 && <span class="header__count">{images.length} 张{doneCount > 0 && ` · 省 ${formatSize(totalSaved)}`}</span>}
      </div>

      {images.length === 0 ? (
        <div class="picker">
          <button class="picker__btn" onClick={handlePick}>📷 从相册选择图片</button>
          <p class="picker__hint">支持 JPEG / PNG / WebP / AVIF / HEIC，可多选</p>
        </div>
      ) : (
        <>
          <div class="settings">
            <div class="settings__row">
              <span class="settings__label">格式 <span class="settings__value">{format === null ? '原格式' : ''}</span></span>
              <div class="segmented">
                {FORMATS.map((f) => (
                  <button
                    class={`segmented__btn${format === f.value ? ' segmented__btn--active' : ''}`}
                    onClick={() => setFormat(format === f.value ? null : f.value)}
                  >{f.label}</button>
                ))}
              </div>
            </div>
            <div class="settings__row">
              <span class="settings__label">视觉无损</span>
              <button
                class={`segmented__btn${visuallyLossless ? ' segmented__btn--active' : ''}`}
                style="padding: 6px 16px; border-radius: 6px; background: #161b22;"
                onClick={() => setVisuallyLossless(!visuallyLossless)}
              >{visuallyLossless ? '开' : '关'}</button>
            </div>
            {visuallyLossless ? (
              <div class="settings__row">
                <span class="settings__label">严格程度</span>
                <div class="segmented">
                  {(['normal', 'high', 'maximum'] as const).map((lvl) => (
                    <button
                      class={`segmented__btn${perceptualLevel === lvl ? ' segmented__btn--active' : ''}`}
                      onClick={() => setPerceptualLevel(lvl)}
                    >{lvl === 'normal' ? '标准' : lvl === 'high' ? '高' : '极致'}</button>
                  ))}
                </div>
              </div>
            ) : (
              <div class="settings__row">
                <span class="settings__label">质量 <span class="settings__value">{quality}</span></span>
                <input class="slider" type="range" min="1" max="100" value={quality}
                  onInput={(e) => setQuality(Number((e.currentTarget as HTMLInputElement).value))} />
              </div>
            )}
          </div>

          <div class="image-list">
            {images.map((item) => (
              <div class="image-item" key={item.id}>
                <img class="image-item__thumb" src={item.thumbnailUrl} alt="" />
                <div class="image-item__info">
                  <div class="image-item__name">{item.name}</div>
                  <div class="image-item__sizes">
                    {formatSize(item.originalSize)}
                    {item.result && <> <span class="image-item__arrow">→</span> {formatSize(item.result.byteLength)}（省 {Math.round((1 - item.result.byteLength / item.originalSize) * 100)}%）</>}
                    {item.result && <span class="image-item__sizes"> · Q{item.result.qualityUsed}</span>}
                  </div>
                </div>
                {item.replaced ? (
                  <span class="image-item__saved">✓ 已替换</span>
                ) : item.status === 'done' ? (
                  <div style="display:flex;flex-direction:column;gap:4px;">
                    <button style="font-size:12px;padding:6px 10px;background:#1f6feb;color:#fff;border-radius:6px;" onClick={() => replaceOriginal(item)}>{native ? '替换原图' : '下载'}</button>
                    <button style="font-size:12px;padding:6px 10px;background:#21262d;color:#e6edf3;border-radius:6px;" onClick={() => saveToGallery(item)}>{native ? '另存' : '下载另存'}</button>
                  </div>
                ) : (
                  <span class={`image-item__status status--${item.status}`}>
                    {item.status === 'pending' ? '待压缩' : item.status === 'processing' ? '压缩中' : '失败'}
                  </span>
                )}
              </div>
            ))}
          </div>

          {processing && (
            <div class="progress-bar">
              <div class="progress-bar__fill" style={`width:${compressProgress}%`}></div>
              <span class="progress-bar__text">{compressProgress}%</span>
            </div>
          )}

          <div class="actions">
            {processing ? (
              <button class="actions__btn" style="background:#da3633;color:#fff;" onClick={cancelCompress}>中断压缩</button>
            ) : (
              <button class="actions__btn actions__compress" disabled={images.every((i) => i.status === 'done')}
                onClick={compress}>开始压缩</button>
            )}
            {doneCount > 0 && images.some((i) => i.status === 'done' && !i.replaced) && (
              <button class="actions__btn" disabled={replacing}
                style="background:#1f6feb;color:#fff;"
                onClick={replaceAll}>{replacing ? '替换中...' : `一键替换（${images.filter((i) => i.status === 'done' && !i.replaced).length}张）`}</button>
            )}
            <button class="picker__btn" style="padding: 14px 20px;" onClick={handlePick}>+ 添加</button>
          </div>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style="display:none"
        onChange={(e) => addFromFiles((e.currentTarget as HTMLInputElement).files)}
      />
    </div>
  );
}
