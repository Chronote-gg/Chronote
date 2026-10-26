import { sameEcsTaskArn } from "../../src/utils/ecsTaskArn";

const long = "arn:aws:ecs:us-east-1:123456789012:task/cluster/abc";
const short = "arn:aws:ecs:us-east-1:123456789012:task/abc";

test.each([
  [long, long],
  [short, short],
  [long, short],
  [short, long],
])("recognizes equivalent task identities %s %s", (left, right) => {
  expect(sameEcsTaskArn(left, right)).toBe(true);
});
test.each([
  long.replace("123456789012", "123456789013"),
  long.replace("us-east-1", "us-west-2"),
  long.replace("arn:aws:", "arn:aws-cn:"),
  long.replace("/cluster/", "/other/"),
  short.replace("/abc", "/different"),
  short + "/extra/path",
  "not-an-arn",
])("rejects a different or malformed identity %s", (other) => {
  expect(sameEcsTaskArn(long, other)).toBe(false);
});
