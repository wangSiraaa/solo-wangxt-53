import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraError, detectCameras, startCameraScan } from '../lib/scanner';

/**
 * 案例1：摄像头不可用。
 * 通过桩来模拟：无 mediaDevices、权限拒绝、无设备三种情况，
 * 验证业务得到结构化 CameraError，可据此降级到键盘/文件入口（不依赖真实摄像头）。
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('案例1：摄像头不可用时的结构化降级', () => {
  it('没有 mediaDevices 接口 → NO_MEDIA_API', async () => {
    vi.stubGlobal('navigator', { mediaDevices: undefined });
    const video = {} as HTMLVideoElement;
    await expect(startCameraScan(video, () => {})).rejects.toMatchObject({ kind: 'NO_MEDIA_API' });
    expect(await detectCameras()).toEqual([]);
  });

  it('权限被拒绝 → PERMISSION_DENIED', async () => {
    const err = new DOMException('denied', 'NotAllowedError');
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () => Promise.reject(err),
        enumerateDevices: () => Promise.resolve([])
      }
    });
    await expect(startCameraScan({} as HTMLVideoElement, () => {})).rejects.toBeInstanceOf(CameraError);
    try {
      await startCameraScan({} as HTMLVideoElement, () => {});
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as CameraError).kind).toBe('PERMISSION_DENIED');
    }
  });

  it('无视频设备 → NO_DEVICE', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () => Promise.reject(new DOMException('none', 'NotFoundError')),
        enumerateDevices: () => Promise.resolve([])
      }
    });
    await expect(startCameraScan({} as HTMLVideoElement, () => {})).rejects.toMatchObject({ kind: 'NO_DEVICE' });
  });
});
