import type { IncrementalRecognitionRequest, IncrementalRecognitionResponse, RecognitionInk } from '../../ipc/types';
import type { RecognitionTiming } from './handwritingMetrics';

export type RecognitionTransport = (
  request: IncrementalRecognitionRequest,
  receive: (response: IncrementalRecognitionResponse) => void,
) => Promise<void>;

export const sameRecognitionInk = (a: RecognitionInk, b: RecognitionInk) => a.id === b.id
  && a.points.length === b.points.length
  && a.points.every((p, i) => p[0] === b.points[i][0] && p[1] === b.points[i][1]);

/** One request in flight. Pending pen-ups coalesce to the latest complete ink
 * snapshot, then only its changed suffix crosses IPC. There is no pause timer. */
export class HandwritingClient {
  private sessionId = crypto.randomUUID();
  private sequence = 0;
  private revision = 0;
  private acknowledged: RecognitionInk[] = [];
  private desired: RecognitionInk[] = [];
  private busy = false;
  private pending = false;
  private desiredPenUpAt: number | null = null;

  constructor(
    private transport: RecognitionTransport,
    private receive: (response: IncrementalRecognitionResponse, ink: RecognitionInk[], timing: RecognitionTiming) => void,
    private failed: (error: unknown) => void,
  ) {}

  update(ink: RecognitionInk[], penUpAt?: number) {
    if (ink.length === this.desired.length && ink.every((s, i) => sameRecognitionInk(s, this.desired[i]))) return false;
    // Own the queued coordinates: subsequent document edits cannot mutate them.
    this.desired = ink.map((s) => ({ id: s.id, points: s.points.map(([x, y]) => [x, y]) }));
    this.desiredPenUpAt = penUpAt ?? null;
    this.revision += 1;
    this.pending = ink.length > 0;
    if (!ink.length) this.cancel();
    else void this.pump();
    return true;
  }

  cancel() {
    this.sessionId = crypto.randomUUID();
    this.sequence = 0;
    this.revision += 1;
    this.acknowledged = [];
    this.desired = [];
    this.pending = false;
  }

  private async pump() {
    if (this.busy || !this.pending) return;
    this.busy = true;
    this.pending = false;
    const ink = this.desired;
    const revision = this.revision;
    const sessionId = this.sessionId;
    const sequence = this.sequence + 1;
    const penUpAt = this.desiredPenUpAt;
    const sentAt = performance.now();
    let from = 0;
    while (from < ink.length && from < this.acknowledged.length && sameRecognitionInk(ink[from], this.acknowledged[from])) from += 1;
    const request = { session_id: sessionId, sequence, from, strokes: ink.slice(from) };
    try {
      let delivered = false;
      await this.transport(request, (response) => {
        if (response.session_id !== sessionId || response.sequence !== sequence) return;
        if (response.stroke_ids.length !== ink.length || !response.stroke_ids.every((id, i) => id === ink[i].id)) return;
        delivered = true;
        if (this.sessionId === sessionId && this.revision === revision) {
          this.receive(response, ink, { penUpAt, sentAt, receivedAt: performance.now() });
        }
      });
      if (!delivered) throw new Error('手写识别结果未送达，已保留笔迹。');
      if (this.sessionId === sessionId) {
        this.acknowledged = ink;
        this.sequence = sequence;
      }
    } catch (error) {
      if (this.sessionId === sessionId) {
        // A failed Channel delivery may have consumed a sequence on the backend.
        // Start a new session for the next snapshot instead of guessing its state.
        this.sessionId = crypto.randomUUID();
        this.sequence = 0;
        this.acknowledged = [];
        if (this.revision === revision) this.failed(error);
      }
    } finally {
      this.busy = false;
      if (this.pending) void this.pump();
    }
  }
}
