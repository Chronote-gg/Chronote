# Recording processing outcomes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give empty recordings one clear explanation, generate notes from incomplete transcripts with the agreed warning, and retain real failure visibility.

**Architecture:** Add an optional typed processing result to the existing meeting and history records. Populate it from terminal transcription results and use it for generation, internal telemetry and existing Discord/portal rendering. Share types and a pure classifier/presentation helper; keep Discord and personal processing owners separate.

**Tech Stack:** Node.js 24.15.0 baseline, TypeScript, Jest, DynamoDB, discord.js, React 19, Mantine, Storybook, Playwright.

**Spec:** [Approved behavior and implementation boundaries](../specs/2026-09-16-recording-processing-outcomes-design.md). Read the spec before execution. The user approved one empty case and partial-note generation; do not revive the earlier two-empty-reason proposal.

## Global constraints

- Exact empty copy: `No usable speech was found, so no notes were generated.`
- Exact partial copy: `Some audio could not be transcribed. These notes may be incomplete.`
- Keep existing meeting lifecycle statuses. Optional processing metadata is separate from lifecycle and delivery.
- Generate notes whenever usable text survives an unrecovered transcription failure, after applicable retries.
- Do not silently convert missing/uninitialized work or known failures into empty success.
- Preserve cancellation, disabled transcription/notes, artifact access checks, existing audio retention, and non-pinging Discord embeds.
- No new dependencies, database tables, production configuration, PostHog events, infrastructure work or automatic re-transcription.
- Keep notices outside stored note content, prompts, transcript text and notes revision history.
- No backfill or inferred empty result for legacy history.
- Scope is local implementation and validation when execution is authorized. Push, PR, merge, deployment and customer contact remain separate.
- Keep `.cache/` investigation artifacts out of commits. Stage named task files only.

## Execution setup

- [ ] Read root and nested `AGENTS.md` files for the touched paths. Confirm HEAD and working-tree state. This plan was prepared at `888ec976f90c02db791c9bef471586f8a2991a28` in an existing isolated worktree. Reconcile any later code changes before applying snippets.
- [ ] Verify Node is in the repository-supported 24.x range and install the locked dependencies using `yarn install --frozen-lockfile` if absent. This worktree had no `node_modules` during planning. Installation is an execution step, not evidence tests have already passed.
- [ ] Use the repository mock environment and test setup. Never point synthetic tests at AWS, Discord, OpenAI or Langfuse production services.
- [ ] Read `test/audio/startProcessingSnippet.test.ts`, `src/services/__tests__/personalMediaUploadProcessingService.test.ts`, `test/embed.test.ts`, and `test/trpc/meetingsRouter.test.ts` to reuse their fixture/mocking conventions.

## Task 1: Define the shared result and notice policy

**Files**

- Create `src/types/meetingProcessing.ts`.
- Create `src/utils/meetingProcessing.ts`.
- Create `test/utils/meetingProcessing.test.ts`.
- Modify `src/types/meeting-data.ts` and `src/types/db.ts` to add `processing?: MeetingProcessingOutcome`.

**Interfaces produced**

```ts
export type TranscriptionOutcome = "ready" | "empty" | "partial" | "failed";
export type GenerationOutcome = "generated" | "skipped" | "failed";
export type MeetingProcessingOutcome = {
  transcription?: TranscriptionOutcome;
  notes?: GenerationOutcome;
  summary?: GenerationOutcome;
};
export type TranscriptionFacts = {
  usableSegments: number;
  failedSegments: number;
  captureIncomplete: boolean;
};
export type ProcessingNotice = {
  tone: "neutral" | "warning" | "error";
  text: string;
};
```

- [ ] Write the pure policy test first:

```ts
import {
  classifyTranscription,
  getMeetingProcessingNotice,
  EMPTY_RECORDING_NOTICE,
  PARTIAL_TRANSCRIPT_NOTICE,
} from "../../src/utils/meetingProcessing";

test.each([
  [0, 0, false, "empty"],
  [1, 0, false, "ready"],
  [1, 1, false, "partial"],
  [0, 1, false, "failed"],
  [0, 0, true, "failed"],
  [1, 0, true, "partial"],
] as const)(
  "classifies %s/%s/%s",
  (usableSegments, failedSegments, captureIncomplete, expected) => {
    expect(
      classifyTranscription({
        usableSegments,
        failedSegments,
        captureIncomplete,
      }),
    ).toBe(expected);
  },
);

test("uses one empty notice and keeps partial notes readable", () => {
  expect(
    getMeetingProcessingNotice(
      { transcription: "empty", notes: "skipped" },
      false,
    )?.text,
  ).toBe(EMPTY_RECORDING_NOTICE);
  expect(
    getMeetingProcessingNotice(
      { transcription: "partial", notes: "generated" },
      true,
    )?.text,
  ).toBe(PARTIAL_TRANSCRIPT_NOTICE);
  expect(getMeetingProcessingNotice(undefined, false)).toBeUndefined();
  expect(
    getMeetingProcessingNotice(
      { transcription: "empty", notes: "skipped" },
      true,
    ),
  ).toBeUndefined();
});
```

- [ ] Run `yarn test --runInBand --coverage=false --runTestsByPath test/utils/meetingProcessing.test.ts`. Expect a missing-module failure before implementation.
- [ ] Implement the types above and these functions in the new pure utility:

```ts
export const EMPTY_RECORDING_NOTICE =
  "No usable speech was found, so no notes were generated.";
export const PARTIAL_TRANSCRIPT_NOTICE =
  "Some audio could not be transcribed. These notes may be incomplete.";

export function classifyTranscription(
  facts: TranscriptionFacts,
): TranscriptionOutcome {
  const incomplete = facts.failedSegments > 0 || facts.captureIncomplete;
  if (facts.usableSegments > 0) return incomplete ? "partial" : "ready";
  return incomplete ? "failed" : "empty";
}

export function getMeetingProcessingNotice(
  processing: MeetingProcessingOutcome | undefined,
  hasNotes: boolean,
): ProcessingNotice | undefined {
  if (hasNotes) {
    return processing?.transcription === "partial"
      ? { tone: "warning", text: PARTIAL_TRANSCRIPT_NOTICE }
      : undefined;
  }
  if (processing?.transcription === "failed") {
    return {
      tone: "error",
      text: "Audio could not be transcribed, so no notes were generated.",
    };
  }
  if (processing?.notes === "failed") {
    return {
      tone: "error",
      text: "Notes could not be generated for this recording.",
    };
  }
  if (processing?.transcription === "empty" && processing.notes === "skipped") {
    return { tone: "neutral", text: EMPTY_RECORDING_NOTICE };
  }
  return undefined;
}
```

Import the types using `import type`. Keep public copy in this one browser-safe module. Add tests for failure precedence, disabled generation, and imported notes suppressing an obsolete empty notice. No database writer change is needed for storage itself: `writeMeetingHistory` marshals the history object with `removeUndefinedValues`.

- [ ] Run the policy test and `yarn build`. Stage the five named files and commit with `feat: define recording processing outcomes`.

## Task 2: Preserve terminal Discord transcription results

**Files**

- Modify `src/services/transcriptionService.ts`, `src/types/audio.ts`, `src/audio.ts`.
- Modify `src/services/transcriptionFinalPassService.ts` only to reuse safe segment-text selection and avoid placeholder text.
- Create `src/utils/audioTranscript.ts` and `test/utils/audioTranscript.test.ts`.
- Modify `test/audio/startProcessingSnippet.test.ts`, `test/audio/voiceSubscriptions.test.ts`, and `test/services/transcriptionService.test.ts`.
- Create `test/services/transcriptionSnippetResult.test.ts` for the actual retry/conversion boundary if the existing service suite's mocks bypass it.

**Interfaces**

Consumes Task 1 types. Add to `src/types/audio.ts`:

```ts
export type SnippetTranscriptionResult =
  | { status: "succeeded"; text: string }
  | { status: "failed"; reason: "transcription_error" | "conversion_error" };
// Add to AudioFileData:
// transcriptionFailed?: boolean;
// Add to AudioData:
// captureIncomplete?: boolean;
```

Change the existing `transcribeSnippet` return type to `Promise<SnippetTranscriptionResult>`; retain its current arguments/options. Its only production callers are the fast and slow paths in `src/audio.ts`.

`src/utils/audioTranscript.ts` exports `resolveAudioFileText(file: AudioFileData): string` and `getAudioTranscriptionFacts(audio: AudioData): TranscriptionFacts`. Move the existing final-pass text-selection helper into this module if present, preserving selection order.

- [ ] Update caller tests to mock `{ status: "succeeded", text: "hello" }` instead of a string. Add a failure assertion at the real slow-processing seam:

```ts
jest
  .mocked(transcribeSnippet)
  .mockResolvedValue({ status: "failed", reason: "transcription_error" });
startProcessingSnippet(meeting, snippet.userId);
await fileData.processingPromise;
expect(fileData.transcriptionFailed).toBe(true);
expect(fileData.transcript ?? "").not.toContain("[Transcription failed]");
expect(fileData.processing).toBe(false);
```

Use the existing `buildMeeting(snippet, fileData)` fixture with audio above the configured minimum and noise gating disabled. Add the paired success and successful-empty cases, and fast coverage/revision races. Assert one terminal failed flag, not one failure per provider attempt.

- [ ] Run `yarn test --runInBand --coverage=false --runTestsByPath test/audio/startProcessingSnippet.test.ts test/audio/voiceSubscriptions.test.ts test/services/transcriptionService.test.ts test/services/transcriptionSnippetResult.test.ts test/utils/audioTranscript.test.ts`. New tests must fail for the specific result/placeholder behavior.
- [ ] In `transcribeSnippet`, enclose conversion in the cleanup-protected region, retain the existing retry policy around provider work, and return typed terminal results:

```ts
// After PCM-to-WAV conversion, using the existing transcription context:
const text = await transcribe(meeting, tempFiles.wavFile, traceContext);
return { status: "succeeded", text };
// Conversion failure returns { status: "failed", reason: "conversion_error" }.
// Exhausted provider work returns { status: "failed", reason: "transcription_error" }.
// finally cleans only files that were created, without replacing the result.
```

Construct `traceContext` from the current inline context fields; do not drop noise metrics, byte counts, user/snippet linkage or suppression overrides. Conversion failure detection uses a local stage variable or a separate narrow conversion catch, not exception-text matching. Keep error logging and numeric status/code sanitization; never print raw provider request content.

- [ ] Adapt both callers. Ignore stale fast revisions before changing text or flags. A successful fast pass is not final until it covers the full snippet; a partial fast prefix does not clear a failed slow pass. Slow success, including successful empty text, resolves required transcription failure. Do not invoke coalescing/live responders with a failed result. Do not replace accepted usable fallback text with a failure placeholder.
- [ ] Implement selected-text and fact extraction:

```ts
export function resolveAudioFileText(file: AudioFileData): string {
  const text =
    file.finalPassTranscript !== undefined
      ? file.finalPassTranscript
      : file.coalescedTranscript ||
        file.slowTranscript ||
        file.transcript ||
        file.fastTranscripts?.at(-1)?.text ||
        "";
  return isTrivialTranscriptionText(text) ? "" : text.trim();
}

export function getAudioTranscriptionFacts(
  audio: AudioData,
): TranscriptionFacts {
  const files = audio.audioFiles.filter(
    (file) => !file.source || file.source === "voice",
  );
  return {
    usableSegments: files.filter((file) => Boolean(resolveAudioFileText(file)))
      .length,
    failedSegments: files.filter((file) => file.transcriptionFailed).length,
    captureIncomplete: audio.captureIncomplete ?? false,
  };
}
```

Use `isTrivialTranscriptionText` from `src/utils/transcriptionText.ts`. Both compilation and final-pass baseline selection use this helper. Count speech before adding labels/header/cues. Preserve intentional empty `finalPassTranscript` even if earlier text was nonempty. Do not silently discard legitimate one-word speech as low-information input.

- [ ] At active receiver decoder/stream error and sufficiently long no-PCM events, record `captureIncomplete=true`. Reuse the existing no-PCM duration threshold; do not mark every benign stream close or short speaking event as missing audio. Guard finishing/destroyed subscriptions as today. Resubscription cannot prove lost audio was recovered, so it must not clear a known capture gap. A transient provider retry does not set this capture flag.
- [ ] Add these exact policy cases to tests: authoritative empty final pass suppresses an old nonempty snippet; optional refinement failure retains valid baseline; one good segment plus failed slow segment yields partial; failure-placeholder-only input yields no usable segment; recovered provider retry has no terminal failed flag. Use fake timers/mocked provider responses, never a paid model call.
- [ ] Run the named tests and `yarn build`; commit named files with `fix: retain terminal transcription failures separately from text`.

## Task 3: Resolve generation once and persist accurate outcomes

**Files**

- Modify `src/commands/endMeeting.ts`, `src/commands/saveMeetingHistory.ts`, `src/services/meetingNotesService.ts`, `src/observability/meetingTrace.ts`.
- Create `test/services/meetingNotesService.test.ts` and `test/observability/meetingProcessing.test.ts`.
- Modify `test/commands/endMeeting.test.ts`, `test/commands/saveMeetingDelivery.test.ts`.

**Interfaces**

Keep `ensureMeetingNotes(meeting): Promise<string | undefined>` and `ensureMeetingSummaries(meeting, notes): Promise<MeetingSummaries>`. Their result metadata lives on `meeting.processing`. Consume `classifyTranscription` and `getAudioTranscriptionFacts` after required work and final-pass completion.

- [ ] Write the double-call regression using a minimal typed fixture and mocked generation functions:

```ts
meeting.finalTranscript = "";
meeting.processing = { transcription: "empty" };
await ensureMeetingNotes(meeting);
await ensureMeetingNotes(meeting);
expect(getNotes).not.toHaveBeenCalled();
expect(meeting.processing.notes).toBe("skipped");
expect(warnSpy).not.toHaveBeenCalled();
```

Also assert `getNotes` runs once for partial text and its result does not contain the warning. When `getNotes` rejects, assert notes=`failed`, a second ensure call does not implicitly retry, and no empty notice is selected. An uninitialized transcript with no resolved outcome must record an invariant failure, not `empty`.

- [ ] Run `yarn test --runInBand --coverage=false --runTestsByPath test/services/meetingNotesService.test.ts test/commands/endMeeting.test.ts test/commands/saveMeetingDelivery.test.ts test/observability/meetingProcessing.test.ts` and observe the new regression fail.
- [ ] Immediately after compiling the ordinary final transcript, set the outcome:

```ts
meeting.processing = {
  ...meeting.processing,
  transcription: classifyTranscription(
    getAudioTranscriptionFacts(meeting.audioData),
  ),
};
```

Do not add this normal-generation branch to cancellation. Skip outcome classification when transcription is disabled. If required processing is still pending, report an invariant failure instead of classifying as empty.

- [ ] Make ensure helpers honor terminal states. Use these branch rules in order:

```ts
// ensureMeetingNotes, after disabled and existing-notes guards:
if (meeting.processing?.notes) return meeting.notesText;
const outcome = meeting.processing?.transcription;
if (outcome === "empty" || outcome === "failed") {
  meeting.processing = { ...meeting.processing, notes: "skipped" };
  return undefined;
}
// Require finalTranscript !== undefined before model work.
// Set notes="generated" only for a nonblank model result.
// A throw or blank model response sets notes="failed" and logs an error.
```

Ready/partial outcomes require usable transcript text. Summary generation similarly memoizes its terminal outcome, marks no-notes as skipped and marks a thrown/empty model result failed. Catch summary failure at this service boundary so history and valid notes can still be delivered; retain an error-level trace outcome. For disabled generation, leave the optional notes/summary outcomes unset, so a disabled feature cannot satisfy the empty-notice condition. Reuse already-generated notes/summaries. Explicit future retry commands would reset the stage outcome; this plan adds none.

- [ ] Add `processing: meeting.processing` to the ordinary completed history record. Keep history persistence's fallback ensure calls for other callers, but make them no-ops for resolved outcomes. Test stored processing metadata independently from `generateNotes`, `transcribeMeeting` and delivery fields.
- [ ] Attach terminal stage results to existing Langfuse spans. In `withMeetingEndStep`, after the named generate step returns, inspect its outcome and set metadata `stageOutcome`; use ERROR for `failed`, DEFAULT for expected skipped. In the root trace `finally`, attach `processing` and counts; mark failed stages ERROR and partial transcript WARNING only if there is no existing finalization/delivery ERROR. Emit one content-free terminal log from the owner:

```ts
console.info("Meeting processing completed", {
  meetingId: meeting.meetingId,
  processing: meeting.processing,
  ...getAudioTranscriptionFacts(meeting.audioData),
});
```

Do not emit that log from each ensure call or label the existing `notes_generated` PostHog flag as success. This is per-finalization idempotence, not a new distributed exactly-once guarantee.

- [ ] Run the named tests and `yarn build`; commit named files with `fix: resolve meeting generation outcomes once`.

## Task 4: Apply the same policy to personal uploads without losing retries

**Files**

- Modify `src/services/personalMediaUploadProcessingService.ts`.
- Modify `src/services/__tests__/personalMediaUploadProcessingService.test.ts`.
- Modify `src/services/personalMediaUploadService.ts` only if a narrow outcome-preserving segment write helper is needed; do not change claim, authorization or retry-limit policy.

**Interfaces**

Within the processing module define:

```ts
type PersonalTranscriptionResult = {
  text: string;
  failedChunks: number;
};
// transcribeAudioFiles(filePaths: string[], acceptPartial: boolean)
//   -> Promise<PersonalTranscriptionResult>
// Add processing: MeetingProcessingOutcome to PersonalUploadProcessingResult.
// Carry failedChunks through ProcessedPersonalRecordingSource and per-segment results.
```

`acceptPartial` is `(job.attempts ?? 1) >= PERSONAL_MEDIA_UPLOAD_MAX_PROCESSING_ATTEMPTS`. It changes provider transcription failure handling only. All successful text is trimmed and aggregated before the shared classifier is called.

- [ ] Extend existing mocks and add the empty desktop case:

```ts
mockTranscribe.mockResolvedValue({ text: "   " });
recordingSegments = [buildSegment(0)];
await processPersonalMediaUpload(buildDesktopJob(), "instance-1");
expect(mockChatComplete).not.toHaveBeenCalled();
expect(writeMeetingHistoryService).toHaveBeenLastCalledWith(
  expect.objectContaining({
    notes: "",
    processing: {
      transcription: "empty",
      notes: "skipped",
      summary: "skipped",
    },
  }),
);
```

Add an ordinary-upload fixture using the existing job type with uploadOrigin/sourceManifest removed and valid media metadata. Assert the same empty behavior. Add final-attempt segmented failure with one cached successful segment and one failing provider input; assert generated notes, transcription=`partial`, failed segment remains failed, and cached segment is not transcribed again.

- [ ] Run `yarn test --runInBand --coverage=false --runTestsByPath src/services/__tests__/personalMediaUploadProcessingService.test.ts` and confirm new assertions fail.
- [ ] Change the per-file transcription loop to collect terminal provider results on the last job attempt:

```ts
const chunks: string[] = [];
let failedChunks = 0;
for (const filePath of filePaths) {
  let transcript: string;
  try {
    transcript = await transcribeAudioFile(filePath);
  } catch (error) {
    if (!acceptPartial) throw error;
    failedChunks += 1;
    continue;
  }
  if (transcript.trim()) chunks.push(transcript.trim());
}
return { text: chunks.join("\n\n"), failedChunks };
```

Keep a sanitized error observation for each caught provider failure. Do not put download, FFmpeg, S3 writes or database writes inside this catch. Empty successful chunks increment no failure count. Retryable earlier attempts still throw to existing job retry handling.

- [ ] Propagate `failedChunks` across sources and segments. For a final-attempt transcription failure, retain the normalized audio path/duration and any successful segment text in the in-memory assembly result. Mark the segment failed instead of processed. Do not write a partial transcript cache that a later retry would misread as complete. Successful cached segment artifacts remain unchanged and contribute zero failures. Keep failed-segment audio in concatenation/mixing so transcript loss does not truncate the recording.
- [ ] Classify the assembled unformatted segment text with `captureIncomplete: false` unless this path has positive capture-gap metadata. On empty, return empty notes and skipped generation states. On ready/partial, call notes and summary generation and record their states. All-failed final transcription goes through terminal failure handling, not the successful empty path. A later notes-model failure must preserve a ready/partial transcript classification and retain existing job retry behavior.
- [ ] On a terminal job failure, update the existing processing history record with terminal processing outcomes and lifecycle complete, while preserving identity, available artifact keys and existing notes. Use the existing `getMeetingHistoryService`/`writeMeetingHistoryService` functions and keep job status failed. Preserve processing state during a requeue. Guard a previously completed valid history from being downgraded due to a subsequent job-metadata write failure. Add a regression for this boundary.
- [ ] Add a single internal terminal processing log for complete, empty, partial or terminal-failed outcomes. Requeued attempts remain retry telemetry, not a completed processing result.
- [ ] Test recovery before the last attempt, partial success only after the retry budget, all-failed processing, mixed empty and failed chunks, cached-success reuse, S3 failure propagation, failed segment counts, and ordinary-upload failure. Use current mocks for storage and models. Run the suite and `yarn build`; commit with `fix: classify personal upload transcription outcomes`.

## Task 5: Present notices without changing note content

**Files**

- Modify `src/embed.ts`, `src/utils/meetingNotes.ts`, `src/commands/notesCorrections.ts`, `src/trpc/routers/meetings.ts`.
- Modify `src/frontend/utils/meetingLibrary.ts`, `src/frontend/pages/library/components/MeetingDetailDrawer.tsx`, `src/frontend/pages/library/components/MeetingSummaryPanel.tsx`.
- Modify `src/frontend/pages/library/components/MeetingSummaryPanel.stories.tsx` and its `.test.tsx` file.
- Modify `test/embed.test.ts`, `test/utils/meetingNotes.test.ts`, `test/trpc/meetingsRouter.test.ts`, `src/frontend/utils/__tests__/meetingLibrary.test.ts`, and relevant `MeetingDetailDrawer.test.tsx` assertions.

**Interfaces**

The authenticated detail response and `MeetingDetailInput`/`MeetingDetails` get `processing?: MeetingProcessingOutcome`. `MeetingSummaryPanelProps` gets the same optional field. `buildMeetingNotesEmbeds` gets `processing?: MeetingProcessingOutcome`. All use the Task 1 notice helper, not duplicate strings.

- [ ] Write mapping/presentation regressions first. Empty-input notes must stay empty in the display model:

```ts
const result = buildMeetingDetails(
  {
    id: "channel#2026-09-16T00:00:00Z",
    meetingId: "meeting-1",
    channelId: "channel",
    timestamp: "2026-09-16T00:00:00Z",
    duration: 60,
    notes: "",
    processing: { transcription: "empty", notes: "skipped" },
  },
  new Map(),
);
expect(result.notes).toBe("");
expect(result.processing?.transcription).toBe("empty");
```

Render `MeetingSummaryPanel` with empty/partial/failed/legacy props using the existing Mantine test wrapper. Assert exact notice text, actual partial notes still rendered, empty copy disabled, and a manual note import hides the empty explanation. Assert legacy fallback still appears. In Discord tests assert stored notes remain byte-for-byte unchanged and the notice is outside description text for partial notes.

- [ ] Run `yarn test --runInBand --coverage=false --runTestsByPath test/embed.test.ts test/utils/meetingNotes.test.ts test/trpc/meetingsRouter.test.ts src/frontend/utils/__tests__/meetingLibrary.test.ts src/frontend/pages/library/components/MeetingSummaryPanel.test.tsx src/frontend/pages/library/components/MeetingDetailDrawer.test.tsx`. Confirm the new assertions fail.
- [ ] Pass `history.processing` through the authenticated detail response after existing access checks. `buildMeetingDetails` passes it through and keeps raw notes empty for new classified records. For legacy unclassified records, retain the current fallback behavior unless it is moved to rendering with matching tests. Do not derive decisions/actions/summary from notice text.
- [ ] In `MeetingSummaryPanel`, derive and render the notice separately:

```tsx
const hasNotes = Boolean(notes.trim());
const notice = getMeetingProcessingNotice(processing, hasNotes);
// Put this inside the existing summary content above Markdown, not in notes:
{
  notice && (
    <Text
      role={notice.tone === "neutral" ? "status" : "alert"}
      c={
        notice.tone === "error"
          ? "red"
          : notice.tone === "warning"
            ? "yellow"
            : "dimmed"
      }
    >
      {notice.text}
    </Text>
  );
}
```

Keep summary/notes content visible for partial results. When a classified result has no notes, disable copy, feedback, correction and notes-only export actions using existing callbacks/props; preserve edit/import and authorized audio access. Do not show both the new empty notice and the old `No notes recorded.` paragraph. Pass processing from the drawer. Keep scroll-container styles unchanged.

- [ ] For initial Discord delivery, the empty/failure explanation replaces the fallback embed description. For partial notes, add the exact warning in an embed footer, respecting Discord footer/embed limits; it is not part of stored notes or the model prompt. For multi-part notes show the warning consistently without adding extra message-count expectations. Preserve the warning in `buildMeetingNotesEmbeds` when correction/import/edit rebuilds embeds: pass persisted processing through those callers and combine existing footer text with the notice. Rename-only updates already spread the existing embed, so verify they preserve it.
- [ ] Add stories `EmptyRecording`, `PartialTranscript`, `TranscriptionFailed`, `NotesGenerationFailed` and `LegacyUnavailable` to the existing summary-panel story. Example:

```tsx
export const EmptyRecording: Story = {
  args: {
    summary: "",
    notes: "",
    copyDisabled: true,
    processing: {
      transcription: "empty",
      notes: "skipped",
      summary: "skipped",
    },
  },
};
export const PartialTranscript: Story = {
  args: {
    processing: {
      transcription: "partial",
      notes: "generated",
      summary: "generated",
    },
  },
};
```

- [ ] Run the named tests, `yarn build`, and `yarn build:web`. Commit named files with `feat: explain empty and incomplete meeting notes`.

## Task 6: Document and verify the complete flow

**Files**

- Modify `apps/docs-site/docs/troubleshooting/common-issues.md` and `apps/docs-site/docs/core-concepts/meeting-lifecycle.md`.
- Review `test/e2e/visual.spec.ts-snapshots` and `test/e2e/meetingDetailScroll.spec.ts`.
- Update only visual snapshots changed by the approved notice UI after VLM review.

- [ ] Apply the repository `docs-authoring` skill. Add concise user documentation:

```md
### Recording finished without notes

"No usable speech was found, so no notes were generated" means Chronote
finished processing but had no usable speech to summarize. Check that the
intended audio source was available and that participants were audible.

If you see "Some audio could not be transcribed. These notes may be incomplete,"
Chronote generated notes from the text it could recover. Review them for
missing discussion before relying on them.

A processing-failure message is different from an empty recording. Any existing
upload retries run before Chronote reports a terminal upload failure.
```

In the lifecycle page explain that completed means processing ended; it does not guarantee generated notes or a complete transcript. Describe the same distinction for Discord and personal recordings without exposing internal enum names. Do not publish release claims or operational evidence about customer meetings.

- [ ] Run all focused tests from Tasks 1-5, followed by `yarn test --runInBand`, `yarn build:all`, `yarn lint:check`, and `yarn docs:check`. Run targeted Prettier checks on changed files and the repository Markdown lint check. Fix actual failures; do not repeatedly rerun green suites without a new change.
- [ ] Read existing Playwright snapshots with the VLM before approving UI changes. Start Storybook with `yarn storybook`, then run `yarn test-storybook`. Review the resulting images under `test/storybook/screenshots` with the VLM. Capture and inspect empty, partial, failure and legacy cases, including a long partial transcript.
- [ ] Run `yarn test:visual` and `yarn test:e2e test/e2e/meetingDetailScroll.spec.ts`. If notice insertion changes scrolling, add/assert actual `scrollHeight > clientHeight` and a changing `scrollTop` in the intended container before updating snapshots. Use `yarn test:visual:update` only for reviewed expected differences. Preserve `.storybook`'s `react-docgen-typescript` setting. If restarting Storybook, identify and stop the existing process on port 6006 rather than accepting a silently changed port.
- [ ] Verify the end-to-end acceptance matrix with mocks: empty Discord meeting logs one terminal result and delivers its explanation; partial Discord meeting produces notes plus the exact notice; recovered retry shows no partial notice; personal empty completion skips models; final-attempt personal partial completion preserves audio and failed-segment accounting; full failure remains failed; cancelled/disabled/legacy cases keep existing semantics.
- [ ] Check source diffs for accidental prompt content, raw errors or new identifiers in analytics. Verify no outcome text was inserted into persisted notes, correction input, generated summary input, transcript artifacts or notes revision history. Inspect permissions and mention behavior at changed delivery call sites.
- [ ] Stage only documentation and deliberately updated tests/snapshots. Commit with `docs: explain recording processing outcomes`. Record test commands and results in the execution handoff. Do not claim production behavior changed.

## Self-review performed during planning

- One user-facing empty case and exact approved messages are carried into policy, rendering, tests and docs.
- Partial notes are generated after the relevant retry budget; recovered attempts do not cause false partial results.
- Required transcription/capture failures, optional refinement failure, notes-model failure and delivery are separate.
- Personal source/segment aggregation, cached segments, retries and terminal-history behavior are explicitly covered.
- Portal copy/edit separation and Discord correction/rename persistence are covered.
- Existing share/MCP/Notion/export content contracts remain outside the presentation scope; notices are not injected into their note text.
- No application edits or validation runs were performed to create this plan. Code blocks are planned interfaces and changes, not claims that code exists or tests pass.

## Completion boundary

Execution is complete when the acceptance matrix and required local checks pass and the implementation is reviewable. Push/PR, merge-ready review windows, merge and deployment are separate authorized phases. Do not retrieve production content or rerun the operational investigation to validate synthetic behavior.
