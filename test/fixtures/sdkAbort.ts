export async function expectSdkAbort({
  task,
  started,
  controller,
}: {
  task: Promise<unknown>;
  started: Promise<void>;
  controller: AbortController;
}) {
  const rejected = expect(task).rejects.toHaveProperty("name", "AbortError");
  await started;
  controller.abort();
  await rejected;
}
