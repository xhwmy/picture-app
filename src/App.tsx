import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import type { CompressOutput, WorkerRequest, WorkerResponse, OutputFormat, PerceptualLevel } from './lib/types';
import {
  isNative,
  pickImagesNative,
  readImageNative,
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
  data?: ArrayBuffer;
  status: 'pending' | 'processing' | 'done' | 'failed';
  result?: CompressOutput;
  resultUrl?: string;
  replaced: boolean;
  saved?: boolean;
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
  const [compressStats, setCompressStats] = useState({ done: 0, total: 0 });
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
      const thumbData = base64ToArrayBuffer(p.thumbnailBase64);
      const thumbBlob = new Blob([thumbData], { type: 'image/jpeg' });
      return {
        id: p.id,
        name: p.name,
        originalSize: p.size,
        mimeType: p.mimeType,
        thumbnailUrl: URL.createObjectURL(thumbBlob),
        contentUri: p.contentUri,
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
    setCompressStats({ done: 0, total });
    let completed = 0;
    let taskIndex = 0;
    const stageMap: Record<string, number> = {};
    const updateProgress = () => {
      const sum = Object.values(stageMap).reduce((a, b) => a + b, 0);
      setCompressProgress(Math.round((sum / total) * 100));
    };

    const runWorker = async (worker: Worker) => {
      while (taskIndex < pending.length && !cancelRef.current) {
        const myIndex = taskIndex++;
        const item = pending[myIndex];
        stageMap[item.id] = 0.05;
        updateProgress();
        setImages((prev) => prev.map((img) => (img.id === item.id ? { ...img, status: 'processing' } : img)));
        try {
          let buffer: ArrayBuffer;
          if (item.data) {
            buffer = item.data.slice(0);
          } else if (item.contentUri) {
            buffer = await readImageNative(item.contentUri);
          } else {
            throw new Error('No image data');
          }
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
              if (msg.type === 'progress') {
                stageMap[item.id] = msg.stage === 'decoded' ? 0.4 : 0.8;
                updateProgress();
                return;
              }
              worker.removeEventListener('message', handler);
              if (msg.type === 'success') resolve(msg.result);
              else reject(new Error(msg.error));
            };
            worker.addEventListener('message', handler);
            worker.postMessage(request, { transfer: [buffer] });
          });
          if (cancelRef.current) break;
          stageMap[item.id] = 1;
          completed++;
          setCompressStats({ done: completed, total });
          updateProgress();
          const resultUrl = URL.createObjectURL(new Blob([result.buffer], { type: result.mimeType }));
          setImages((prev) =>
            prev.map((img) => (img.id === item.id ? { ...img, status: 'done', result, resultUrl } : img)),
          );
        } catch (err) {
          if (cancelRef.current) break;
          stageMap[item.id] = 1;
          updateProgress();
          setImages((prev) =>
            prev.map((img) =>
              img.id === item.id ? { ...img, status: 'failed', errorReason: err instanceof Error ? err.message : String(err) } : img,
            ),
          );
        }
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
    setImages((prev) => prev.map((img) => img.status === 'processing' ? { ...img, status: 'pending' } : img));
    setProcessing(false);
    setCompressProgress(0);
  }, []);

  const native = isNative();

  const replaceOriginal = useCallback(async (item: ImageItem) => {
    if (!item.result) return;

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
      setImages((prev) => prev.map((img) => (img.id === item.id ? { ...img, saved: true } : img)));
    } catch (err) {
      alert('保存失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target) {
        URL.revokeObjectURL(target.thumbnailUrl);
        if (target.resultUrl) URL.revokeObjectURL(target.resultUrl);
      }
      return prev.filter((img) => img.id !== id);
    });
  }, []);

  const clearImages = useCallback(() => {
    setImages((prev) => {
      prev.forEach((img) => {
        URL.revokeObjectURL(img.thumbnailUrl);
        if (img.resultUrl) URL.revokeObjectURL(img.resultUrl);
      });
      return [];
    });
  }, []);

  const doneCount = images.filter((i) => i.status === 'done').length;
  const totalSaved = images.reduce((sum, i) => sum + (i.result ? i.originalSize - i.result.byteLength : 0), 0);


  return (
    <div class="app">
      <div class="header">
        <div class="header__brand">
          <span class="header__logo">◈</span>
          <h1>图片压缩</h1>
        </div>
        {images.length > 0 && (
          <div class="header__right">
            <span class="header__count">{images.length} 张{doneCount > 0 && ` · 省 ${formatSize(totalSaved)}`}</span>
            <button class="header__clear" onClick={clearImages} disabled={processing}>清空</button>
          </div>
        )}
      </div>

      {images.length === 0 ? (
        <div class="picker">
          <div class="picker__card">
            <div class="picker__icon">✦</div>
            <h2 class="picker__title">开始压缩图片</h2>
            <p class="picker__desc">本地压缩，保护隐私，最高支持视觉无损</p>
            <button class="picker__btn" onClick={handlePick}>📷 从相册选择图片</button>
            <p class="picker__hint">支持 JPEG / PNG / WebP / AVIF / HEIC，可多选</p>
          </div>
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
                class={`toggle-btn${visuallyLossless ? ' toggle-btn--on' : ''}`}
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
            {images.map((item) => {
              const pct = item.result ? Math.round((1 - item.result.byteLength / item.originalSize) * 100) : 0;
              return (
              <div class="image-item" key={item.id}>
                <img class="image-item__thumb" src={item.thumbnailUrl} alt="" />
                <div class="image-item__info">
                  <div class="image-item__name">{item.name}</div>
                  <div class="image-item__sizes">
                    {formatSize(item.originalSize)}
                    {item.result && <> <span class="image-item__arrow">→</span> {formatSize(item.result.byteLength)}（{pct >= 0 ? `省 ${pct}%` : `增大 ${-pct}%`}）</>}
                    {item.result && <span class="image-item__sizes"> · Q{item.result.qualityUsed}</span>}
                  </div>
                  {item.status === 'failed' && item.errorReason && (
                    <div class="image-item__fail-reason" onClick={() => alert('压缩失败: ' + item.errorReason)}>点击查看失败原因</div>
                  )}
                </div>
                {item.replaced ? (
                  <span class="image-item__saved">✓ 已替换</span>
                ) : item.saved ? (
                  <span class="image-item__saved image-item__saved--saved">✓ 已保存</span>
                ) : item.status === 'done' ? (
                  <div class="item-actions">
                    <button class="item-actions__btn item-actions__btn--primary" onClick={() => replaceOriginal(item)}>{native ? '替换原图' : '下载'}</button>
                    <button class="item-actions__btn item-actions__btn--ghost" onClick={() => saveToGallery(item)}>{native ? '另存' : '下载另存'}</button>
                  </div>
                ) : (
                  <span class={`image-item__status status--${item.status}`}>
                    {item.status === 'pending' ? '待压缩' : item.status === 'processing' ? '压缩中' : '失败'}
                  </span>
                )}
                <button class="image-item__remove" onClick={() => removeImage(item.id)} disabled={processing}>✕</button>
              </div>
              );
            })}
          </div>


          <div class="actions">
            {processing ? (
              <button class="actions__btn actions__cancel" onClick={cancelCompress}>中断压缩</button>
            ) : (
              <button class="actions__btn actions__compress" disabled={images.every((i) => i.status === 'done')}
                onClick={compress}>开始压缩</button>
            )}
            {doneCount > 0 && images.some((i) => i.status === 'done' && !i.replaced) && (
              <button class="actions__btn actions__replace" disabled={replacing}
                onClick={replaceAll}>{replacing ? '替换中...' : `一键替换（${images.filter((i) => i.status === 'done' && !i.replaced).length}张）`}</button>
            )}
            <button class="actions__btn actions__add" onClick={handlePick}>+ 添加</button>
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

      {processing && (
        <div class="progress-modal">
          <div class="progress-modal__box">
            <div class="progress-modal__header">
              <span>压缩中</span>
              <span class="progress-modal__count">{compressStats.done}/{compressStats.total}</span>
            </div>
            <div class="progress-modal__bar">
              <div class="progress-modal__fill" style={`width:${compressProgress}%`}></div>
            </div>
            <div class="progress-modal__info">
              <span class="progress-modal__percent">{compressProgress}%</span>
              <button class="progress-modal__cancel" onClick={cancelCompress}>中断</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
