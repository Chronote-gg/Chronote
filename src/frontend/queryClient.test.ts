import { queryClient, resetMeetingSessionQueries } from "./queryClient";

test("actor reset removes data and cancels a delayed response while retaining identity", async () => {
  const identityKey = [["auth", "me"], { type: "query" }];
  const meetingsKey = [["meetings", "myList"], { type: "query" }];
  queryClient.setQueryData(identityKey, { id: "new-actor" });
  let finish: (value: string[]) => void = () => {};
  const pending = queryClient
    .fetchQuery({
      queryKey: meetingsKey,
      queryFn: () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    })
    .catch(() => undefined);
  await resetMeetingSessionQueries();
  finish(["old actor private row"]);
  await pending;
  expect(queryClient.getQueryData(meetingsKey)).toBeUndefined();
  expect(queryClient.getQueryData(identityKey)).toEqual({ id: "new-actor" });
  queryClient.clear();
});
