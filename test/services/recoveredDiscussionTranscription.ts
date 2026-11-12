/**
 * The transcription service with every content snippet transcribed as
 * "Recovered discussion.". Test files pass it to their own `jest.mock` factory.
 */
export function transcriptionServiceMock() {
  return {
    ...jest.requireActual("../../src/services/transcriptionService"),
    transcribeContentSnippet: jest.fn(async () => ({
      status: "succeeded",
      text: "Recovered discussion.",
    })),
  };
}
