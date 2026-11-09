import { describe, expect, it, vi } from 'vitest';
import type { IncrementalRecognitionRequest, IncrementalRecognitionResponse, RecognitionInk } from '../../ipc/types';
import { HandwritingClient } from './handwritingClient';

const ink = (id: string, x = 0): RecognitionInk => ({ id, points: [[x, 0], [x, 60]] });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function harness() {
  const calls: { request: IncrementalRecognitionRequest; receive: (r: IncrementalRecognitionResponse) => void; resolve: () => void; reject: (e: unknown) => void }[] = [];
  const receive = vi.fn();
  const failed = vi.fn();
  const client = new HandwritingClient((request, receive) => new Promise<void>((resolve, reject) => {
    calls.push({ request, receive, resolve, reject });
  }), receive, failed);
  const deliver = (index: number, ids: string[]) => {
    const call = calls[index];
    call.receive({ session_id: call.request.session_id, sequence: call.request.sequence, stroke_ids: ids, candidates: [{ text: ids.join(''), score: 0 }], stable_stroke_ids: [], stable_text: '', elapsed_ms: 1, classifier_calls: 1, cache_hits: 0 });
    call.resolve();
  };
  return { client, calls, receive, failed, deliver };
}

describe('incremental handwriting client', () => {
  it('coalesces rapid pen-ups and sends only the unacknowledged suffix', async () => {
    const h = harness();
    h.client.update([ink('a')]);
    h.client.update([ink('a'), ink('b')]);
    h.client.update([ink('a'), ink('b'), ink('c')]);
    expect(h.calls).toHaveLength(1);
    h.deliver(0, ['a']); await flush();
    expect(h.receive).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].request).toMatchObject({ sequence: 2, from: 1, strokes: [ink('b'), ink('c')] });
    h.deliver(1, ['a', 'b', 'c']); await flush();
    expect(h.receive).toHaveBeenCalledTimes(1);
  });

  it('measures the latest pen-up across queueing and rejects superseded timings', async () => {
    const h = harness();
    h.client.update([ink('a')], 10);
    h.client.update([ink('a'), ink('b')], 20);
    h.client.update([ink('a'), ink('b'), ink('c')], 30);
    h.deliver(0, ['a']); await flush();
    expect(h.receive).not.toHaveBeenCalled();
    h.deliver(1, ['a', 'b', 'c']); await flush();
    const timing = h.receive.mock.calls[0][2];
    expect(timing.penUpAt).toBe(30);
    expect(timing.receivedAt).toBeGreaterThanOrEqual(timing.sentAt);
  });

  it('rejects old session results after cancel, then resumes from a fresh session', async () => {
    const h = harness(); h.client.update([ink('a')]);
    const oldId = h.calls[0].request.session_id;
    h.client.cancel(); h.client.update([ink('new')]);
    h.deliver(0, ['a']); await flush();
    expect(h.receive).not.toHaveBeenCalled();
    expect(h.calls[1].request.session_id).not.toBe(oldId);
    expect(h.calls[1].request).toMatchObject({ sequence: 1, from: 0 });
    h.deliver(1, ['new']); await flush();
    expect(h.receive).toHaveBeenCalledTimes(1);
  });

  it('invalidates on move or partial undo and owns queued coordinates', async () => {
    const h = harness(); const first = ink('a');
    h.client.update([first, ink('b')]);
    first.points[0][0] = 100;
    expect(h.calls[0].request.strokes[0].points[0][0]).toBe(0);
    h.deliver(0, ['a', 'b']); await flush();
    h.client.update([ink('a'), ink('b', 200)]);
    expect(h.calls[1].request).toMatchObject({ from: 1, strokes: [ink('b', 200)] });
    h.client.update([ink('a')]);
    h.deliver(1, ['a', 'b']); await flush();
    expect(h.receive).toHaveBeenCalledTimes(1);
    expect(h.calls[2].request).toMatchObject({ from: 1, strokes: [] });
    h.deliver(2, ['a']); await flush();
    expect(h.receive).toHaveBeenCalledTimes(2);
  });

  it('recovers after failure without losing pending ink or assuming a backend sequence', async () => {
    const h = harness(); h.client.update([ink('a')]);
    h.client.update([ink('a'), ink('b')]);
    h.calls[0].reject(new Error('offline model')); await flush();
    expect(h.failed).not.toHaveBeenCalled();
    expect(h.calls[1].request).toMatchObject({ sequence: 1, from: 0, strokes: [ink('a'), ink('b')] });
    h.deliver(1, ['a', 'b']); await flush();
    expect(h.receive).toHaveBeenCalledTimes(1);
  });

  it('never accepts a response for a different stroke set or sequence', async () => {
    const h = harness(); h.client.update([ink('a')]);
    h.deliver(0, ['wrong']); await flush();
    expect(h.receive).not.toHaveBeenCalled();
    expect(h.failed).toHaveBeenCalledTimes(1);
  });
});
