import { afterEach, describe, expect, it, vi } from 'vitest';
import { handwritingMetrics, recordCandidatePresentation } from './handwritingMetrics';

function frames() {
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const listeners = new Set<() => void>();
  const document = {
    visibilityState: 'visible',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pending.set(++nextId, callback); return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
  const paint = () => {
    const callbacks = [...pending.values()]; pending.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  };
  return { paint, document, listeners };
}

afterEach(() => { handwritingMetrics.stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('handwriting presentation timing', () => {
  it('includes queue and transport time and waits beyond the first frame', () => {
    const f = frames(); handwritingMetrics.start();
    vi.spyOn(performance, 'now').mockReturnValue(100);
    recordCandidatePresentation({ penUpAt: 10, sentAt: 30, receivedAt: 80 }, 4);
    f.paint(); expect(handwritingMetrics.snapshot()).toEqual([]);
    f.paint();
    expect(handwritingMetrics.snapshot()).toEqual([{
      queue_ms: 20, roundtrip_ms: 50, compute_ms: 4,
      pen_up_to_presentation_opportunity_ms: 90,
    }]);
    expect(f.listeners.size).toBe(0);
  });

  it('excludes superseded candidates, hidden intervals and document-only updates', () => {
    const f = frames(); handwritingMetrics.start();
    const timing = { penUpAt: 10, sentAt: 30, receivedAt: 80 };
    const cancel = recordCandidatePresentation(timing, 4);
    f.paint(); cancel(); f.paint();
    recordCandidatePresentation({ ...timing, penUpAt: null }, 4);
    recordCandidatePresentation(timing, 4);
    f.document.visibilityState = 'hidden'; f.listeners.forEach((listener) => listener());
    f.document.visibilityState = 'visible';
    f.paint(); f.paint();
    expect(handwritingMetrics.snapshot()).toEqual([]);
    expect(f.listeners.size).toBe(0);
  });
});
