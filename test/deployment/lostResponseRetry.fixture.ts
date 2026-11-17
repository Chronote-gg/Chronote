import {
  type DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

/** Lets the first update commit, then re-sends it as an SDK retry would after a lost response. */
export async function retriedAfterLostResponse<T>(
  client: DynamoDBClient,
  operation: () => Promise<T>,
) {
  const send = client.send.bind(client);
  let retried = false;
  const spy = jest
    .spyOn(client, "send")
    .mockImplementation(async (command, options) => {
      if (retried || !(command instanceof UpdateItemCommand))
        return send(command, options);
      retried = true;
      await send(command, options);
      return send(command, options);
    });
  try {
    return await operation();
  } finally {
    spy.mockRestore();
  }
}
