import { createLeaseTables } from "../../repositories/meetingLeaseDynamo.fixture";
import { localDynamoClient } from "../../repositories/workerRegistryDynamo.fixture";

export type LeaseTables = Awaited<ReturnType<typeof createLeaseTables>>;
export type LocalDynamoClient = ReturnType<typeof localDynamoClient>;

/** A local Dynamo client for the enclosing describe block, destroyed after it, with console warnings quiet in each test. */
export function quietLocalDynamoClient(): LocalDynamoClient {
  const client = localDynamoClient();
  afterAll(() => client.destroy());
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());
  return client;
}

/** Runs `scenario` against fresh lease tables and disposes them whether it passes or throws. */
export async function withLeaseTables(
  client: LocalDynamoClient,
  scenario: (tables: LeaseTables) => Promise<void>,
): Promise<void> {
  const tables = await createLeaseTables(client);
  try {
    await scenario(tables);
  } finally {
    await tables.dispose();
  }
}
