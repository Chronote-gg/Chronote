import type {
  SpeechWorkerReply,
  SpeechWorkerRequest,
  SpeechWorkerTransport,
  SpeechUnavailableReason,
} from "../../src/services/speechDetectionTypes";
export class ControlledSpeechWorker implements SpeechWorkerTransport {
  readonly requests: SpeechWorkerRequest[] = [];
  terminated = false;
  private readonly replies = new Set<(reply: SpeechWorkerReply) => void>();
  private readonly failures = new Set<
    (reason: SpeechUnavailableReason) => void
  >();
  post(request: SpeechWorkerRequest): void {
    this.requests.push(request);
  }
  onReply(listener: (reply: SpeechWorkerReply) => void): () => void {
    this.replies.add(listener);
    return () => {
      this.replies.delete(listener);
    };
  }
  onFailure(listener: (reason: SpeechUnavailableReason) => void): () => void {
    this.failures.add(listener);
    return () => {
      this.failures.delete(listener);
    };
  }
  reply(reply: SpeechWorkerReply): void {
    for (const listener of this.replies) listener(reply);
  }
  captureReplies(): (reply: SpeechWorkerReply) => void {
    const captured = [...this.replies];
    return (reply) => {
      for (const listener of captured) listener(reply);
    };
  }
  fail(reason: SpeechUnavailableReason): void {
    for (const listener of this.failures) listener(reason);
  }
  async terminate(): Promise<void> {
    this.terminated = true;
  }
}
export class FakeSpeechClock {
  private time = 0;
  private timers = new Set<{ at: number; callback: () => void }>();
  now = (): number => this.time;
  schedule = (callback: () => void, delayMs: number): { cancel(): void } => {
    const timer = { at: this.time + delayMs, callback };
    this.timers.add(timer);
    return {
      cancel: () => {
        this.timers.delete(timer);
      },
    };
  };
  elapseWithoutTimers(ms: number): void {
    this.time += ms;
  }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers]
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.time = next.at;
      this.timers.delete(next);
      next.callback();
    }
    this.time = end;
  }
  get pendingTimers(): number {
    return this.timers.size;
  }
}
