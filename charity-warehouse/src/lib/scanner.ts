/**
 * 扫码适配器：
 * - 摄像头路径使用 ZXing (@zxing/browser)；
 * - 摄像头不可用（无设备 / 无权限 / 非 https+非 localhost / getUserMedia 拒绝）时，
 *   给出结构化原因，UI 自动引导到键盘录入与文件导入 —— 业务功能不依赖摄像头。
 */
import { BrowserMultiFormatReader } from '@zxing/browser';

export type CameraErrorKind =
  | 'NO_MEDIA_API'
  | 'NO_DEVICE'
  | 'PERMISSION_DENIED'
  | 'NOT_SECURE_CONTEXT'
  | 'IN_USE'
  | 'UNKNOWN';

export class CameraError extends Error {
  kind: CameraErrorKind;
  constructor(kind: CameraErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

function classify(err: unknown): CameraError {
  const e = err as DOMException;
  const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return new CameraError(
      'NO_MEDIA_API',
      insecure
        ? '非安全上下文：摄像头要求 https 或 localhost，已切换为键盘/文件录入'
        : '当前浏览器不支持摄像头接口 (navigator.mediaDevices)'
    );
  }
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('PERMISSION_DENIED', '摄像头权限被拒绝，可继续使用键盘录入或文件导入');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('NO_DEVICE', '未检测到摄像头设备，可继续使用键盘录入或文件导入');
    case 'NotReadableError':
      return new CameraError('IN_USE', '摄像头被其他程序占用');
    default:
      return new CameraError('UNKNOWN', `摄像头启动失败：${e?.message || String(err)}`);
  }
}

/** 只检测是否存在视频输入设备（不强行弹权限也尽力探测） */
export async function detectCameras(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

export interface ScanHandle {
  stop: () => void;
}

/**
 * 启动连续扫码。
 * @param video 视频元素
 * @param onCode 解码回调（内部做去抖，同一码 2.5s 内不重复上报）
 */
export async function startCameraScan(
  video: HTMLVideoElement,
  onCode: (code: string) => void,
  onStatus?: (s: string) => void
): Promise<ScanHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw classify(null);
  }
  // 先做一次最小权限探测，拿到具体的不可用原因
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false
    });
  } catch (err) {
    throw classify(err);
  }
  stream.getTracks().forEach((t) => t.stop());

  const reader = new BrowserMultiFormatReader();
  let controls: { stop: () => void } | null = null;
  let lastCode = '';
  let lastAt = 0;
  try {
    controls = await reader.decodeFromVideoDevice(
      undefined,
      video,
      (result, err) => {
        if (result) {
          const text = result.getText().trim();
          const t = Date.now();
          if (text && (text !== lastCode || t - lastAt > 2500)) {
            lastCode = text;
            lastAt = t;
            onCode(text);
          }
        } else if (err) {
          // ZXing 每一帧未识别都会回调 err，属于正常现象，不打扰用户
          onStatus?.('对准条码中…');
        }
      }
    );
  } catch (err) {
    throw classify(err);
  }
  onStatus?.('摄像头已启动，请对准条码');
  return {
    stop: () => {
      try {
        controls?.stop();
      } catch {
        /* ignore */
      }
    }
  };
}
