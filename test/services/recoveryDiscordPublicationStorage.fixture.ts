import type {
  PublicationDependencies,
  PublicationReceipt,
  PublicationClaim,
} from "../../src/services/recoveryDiscordPublication";
export function publicationStorageFixture() {
  let revision = 0;
  const receipts = new Map<
    string,
    { value: PublicationReceipt; etag: string }
  >();
  const claims = new Map<string, { value: PublicationClaim; etag: string }>();
  const events: string[] = [];
  const storage = {
    savePreview: jest.fn(async () => {}),
    readReceipt: jest.fn(async (key: string) =>
      structuredClone(receipts.get(key) ?? null),
    ),
    readClaim: jest.fn(async (key: string) =>
      structuredClone(claims.get(key) ?? null),
    ),
    saveReceipt: jest.fn(
      async ({
        key,
        receipt,
        condition,
      }: Parameters<PublicationDependencies["storage"]["saveReceipt"]>[0]) => {
        const old = receipts.get(key);
        if (condition.kind === "absent" ? old : old?.etag !== condition.etag)
          throw new Error("precondition");
        const etag = String(++revision);
        receipts.set(key, { value: structuredClone(receipt), etag });
        events.push(
          `receipt:${receipt.messages.map((m) => m.state).join(",")}`,
        );
        return etag;
      },
    ),
    writeClaim: jest.fn(
      async ({
        key,
        claim,
        condition,
      }: Parameters<PublicationDependencies["storage"]["writeClaim"]>[0]) => {
        const old = claims.get(key);
        if (condition.kind === "absent" ? old : old?.etag !== condition.etag)
          throw new Error("precondition");
        const etag = String(++revision);
        claims.set(key, { value: structuredClone(claim), etag });
        events.push(`claim:${claim.state}`);
        return etag;
      },
    ),
  } satisfies PublicationDependencies["storage"];

  return { storage, receipts, claims, events };
}
