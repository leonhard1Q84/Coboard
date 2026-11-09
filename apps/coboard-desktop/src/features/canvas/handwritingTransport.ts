import { Channel, invoke } from '@tauri-apps/api/core';
import type { IncrementalRecognitionResponse } from '../../ipc/types';
import type { RecognitionTransport } from './handwritingClient';

export const recognizeIncrementally: RecognitionTransport = async (request, receive) => {
  const onUpdate = new Channel<IncrementalRecognitionResponse>();
  let delivered: (() => void) | undefined;
  const received = new Promise<void>((resolve) => { delivered = resolve; });
  onUpdate.onmessage = (response) => { receive(response); delivered?.(); };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([invoke('recognize_handwriting', { request, onUpdate }), received]),
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('手写识别暂未响应，已保留笔迹。')), 10_000); }),
    ]);
  } finally {
    clearTimeout(watchdog);
    onUpdate.onmessage = () => undefined;
  }
};
