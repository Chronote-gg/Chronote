/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { fixture } from "../deployment/fixtures/coordinatorFixture";
import { routingFixture } from "../deployment/fixtures/routingFixture";
import {
  createCoordinator,
  candidateDefinition,
  configuration,
} from "../../scripts/deployment/coordinator.cjs";
import { bindingHash } from "../../scripts/deployment/continue-sandbox.cjs";

function pinnedFixture() {
  const f = fixture();
  const template = structuredClone(f.definition);
  template.taskDefinitionArn = "definition:reviewed";
  const prepared = candidateDefinition(template, configuration(f.options.env));
  const taskTemplate = {
    arn: template.taskDefinitionArn,
    preparedSha256: bindingHash(prepared),
  };
  const original = f.aws.getMockImplementation();
  const state = { template, registered: undefined };
  f.aws.mockImplementation(async (service, operation, input) => {
    if (
      operation === "describe-task-definition" &&
      input.taskDefinition === "definition:reviewed"
    )
      return { taskDefinition: state.template };
    if (
      operation === "describe-task-definition" &&
      input.taskDefinition === "definition:new"
    )
      return { taskDefinition: state.registered };
    const result = await original(service, operation, input);
    if (operation === "register-task-definition")
      state.registered = structuredClone(result.taskDefinition);
    return result;
  });
  return {
    ...f,
    pinned: state,
    coordinator: createCoordinator({ ...f.options, taskTemplate }),
  };
}
test("serving inspection shares native source and routing guards without writing", async () => {
  const f = routingFixture();
  const result = await f.coordinator.inspectServing();
  expect(result.source).toEqual(f.oldIdentity);
  expect(result.routing.state).toBe("source");
  expect(result.runtimeMode).toBe("all");
  expect(
    f.calls.some((call) =>
      [
        "put-item",
        "update-item",
        "register-task-definition",
        "update-service",
        "modify-listener",
      ].includes(call.operation),
    ),
  ).toBe(false);
});
test("pinned preparation reads the reviewed template and verifies the actual immutable registration", async () => {
  const f = pinnedFixture();
  expect(await f.coordinator.prepare()).toEqual({ kind: "warming" });
  expect(
    f.aws.mock.calls
      .filter((call) => call[1] === "describe-task-definition")
      .map((call) => call[2].taskDefinition),
  ).toContain("definition:reviewed");
  expect(f.svc.taskDefinition).toBe("definition:new");
});
test("changed reviewed template refuses before task registration or service update", async () => {
  const f = pinnedFixture();
  f.pinned.template.containerDefinitions[0].environment.push({
    name: "UNREVIEWED",
    value: "true",
  });
  await expect(f.coordinator.prepare()).rejects.toThrow();
  expect(
    f.calls.some((call) =>
      ["register-task-definition", "update-service"].includes(call.operation),
    ),
  ).toBe(false);
});
test("actual registered image drift cannot be normalized away by candidateDefinition", async () => {
  const f = pinnedFixture();
  const original = f.aws.getMockImplementation();
  f.aws.mockImplementation(async (service, operation, input) => {
    const result = await original(service, operation, input);
    if (
      operation === "describe-task-definition" &&
      input.taskDefinition === "definition:new"
    )
      result.taskDefinition.containerDefinitions[0].image = "foreign-image";
    return result;
  });
  await expect(f.coordinator.prepare()).rejects.toThrow();
  expect(f.calls.some((call) => call.operation === "update-service")).toBe(
    false,
  );
});
