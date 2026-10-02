import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { writePaymentTransaction } from "../src/db";

test("persists invoice payments when optional discount and customer fields are undefined", async () => {
  const send = jest.spyOn(DynamoDBClient.prototype, "send");
  send.mockResolvedValueOnce({} as never);
  const transaction = {
    transactionID: "invoice-1",
    userID: "guild-1",
    amount: 10,
    currency: "usd",
    status: "paid",
    paymentDate: "2026-10-01T20:22:35.000Z",
    paymentMethod: "card",
    subscriptionID: "subscription-1",
    discountCode: undefined,
    customerId: undefined,
  };
  try {
    await writePaymentTransaction(transaction);
    expect(send).toHaveBeenCalledWith(expect.any(PutItemCommand));
    const command = send.mock.calls[0][0] as PutItemCommand;
    const saved = unmarshall(command.input.Item!);
    expect(saved).toEqual({ ...transaction, TransactionID: "invoice-1" });
    expect(saved).not.toHaveProperty("discountCode");
    expect(saved).not.toHaveProperty("customerId");
  } finally {
    send.mockRestore();
  }
});
