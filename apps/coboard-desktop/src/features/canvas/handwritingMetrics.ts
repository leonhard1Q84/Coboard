/** Opt-in, bounded, memory-only diagnostics. Never stores ink, text or IDs. */
export type RecognitionTiming = { penUpAt: number | null; sentAt: number; receivedAt: number };
type Sample = {
  queue_ms: number;
  roundtrip_ms: number;
  compute_ms: number;
  pen_up_to_presentation_opportunity_ms: number;
};
const LIMIT = 256;
let enabled = false;
let samples: Sample[] = [];
let generation = 0;

export const handwritingMetrics = {
  start() { generation += 1; samples = []; enabled = true; },
  stop() { enabled = false; generation += 1; },
  snapshot() { return samples.map((sample) => ({ ...sample })); },
};

// Deliberate developer-console entry point, available in the actual WKWebView.
// Nothing is collected until start() is explicitly called.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'coboardHandwritingMetrics', { value: handwritingMetrics, configurable: true });
}

export function recordCandidatePresentation(timing: RecognitionTiming, computeMs: number): () => void {
  const penUpAt = timing.penUpAt;
  if (!enabled || penUpAt === null || document.visibilityState !== 'visible') return () => undefined;
  const startedGeneration = generation;
  let frame = 0;
  let hidden = false;
  const visibilityChanged = () => { if (document.visibilityState !== 'visible') hidden = true; };
  document.addEventListener('visibilitychange', visibilityChanged);
  // Called after React's DOM commit. The second frame follows a paint opportunity;
  // this is a browser scheduling measurement, not a display-photon measurement.
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      if (!enabled || generation !== startedGeneration || hidden) return;
      samples.push({
        queue_ms: timing.sentAt - penUpAt,
        roundtrip_ms: timing.receivedAt - timing.sentAt,
        compute_ms: computeMs,
        pen_up_to_presentation_opportunity_ms: performance.now() - penUpAt,
      });
      if (samples.length > LIMIT) samples.splice(0, samples.length - LIMIT);
    });
  });
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
}
