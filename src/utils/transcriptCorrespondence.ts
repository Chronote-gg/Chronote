import type {
  PcmSpan,
  TranscriptCorrespondence,
} from "../types/transcriptCorrespondence";
export function appendPcmSpan(spans: PcmSpan[], span: PcmSpan): void {
  const previous = spans.at(-1);
  if (
    previous &&
    previous.sourceId === span.sourceId &&
    previous.sequence === span.sequence &&
    previous.endByte === span.startByte
  )
    previous.endByte = span.endByte;
  else spans.push({ ...span });
}
export function normalizePcmSpans(input: readonly PcmSpan[]): PcmSpan[] {
  const sorted = input
    .map((span) => ({ ...span }))
    .sort((a, b) =>
      a.sourceId < b.sourceId
        ? -1
        : a.sourceId > b.sourceId
          ? 1
          : a.sequence - b.sequence || a.startByte - b.startByte,
    );
  const spans: PcmSpan[] = [];
  for (const span of sorted) {
    const previous = spans.at(-1);
    if (
      previous &&
      previous.sourceId === span.sourceId &&
      previous.sequence === span.sequence &&
      span.startByte <= previous.endByte
    )
      previous.endByte = Math.max(previous.endByte, span.endByte);
    else spans.push(span);
  }
  return spans;
}
export function copyCorrespondence(
  value: TranscriptCorrespondence | undefined,
): TranscriptCorrespondence | undefined {
  return value?.kind === "pcm"
    ? { kind: "pcm", spans: value.spans.map((span) => ({ ...span })) }
    : value;
}
export function combineCorrespondence(
  values: readonly (TranscriptCorrespondence | undefined)[],
): TranscriptCorrespondence | undefined {
  if (values.some((value) => value === undefined)) return undefined;
  const pcm = values.flatMap((value) =>
    value?.kind === "pcm" ? value.spans : [],
  );
  return values.some((value) => value?.kind === "pcm") || !values.length
    ? { kind: "pcm", spans: normalizePcmSpans(pcm) }
    : { kind: "text_only" };
}
export function containsPcmSpans(
  outer: readonly PcmSpan[],
  inner: readonly PcmSpan[],
): boolean {
  return inner.every((span) =>
    outer.some(
      (parent) =>
        parent.sourceId === span.sourceId &&
        parent.sequence === span.sequence &&
        parent.startByte <= span.startByte &&
        parent.endByte >= span.endByte,
    ),
  );
}
