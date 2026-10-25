import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { ControlTableNames } from "../types/deploymentControl";
import { config } from "../services/configService";
import {
  createDynamoDeploymentControlRepository,
  createMockDeploymentControlRepository,
  mockWorkAdmissionAllowed,
} from "./deploymentControlRepository";
import { createDynamoMeetingUpdateDeliveryRepository } from "./meetingUpdateDeliveryRepository";
import { createMockMeetingUpdateDeliveryRepository } from "./mockMeetingUpdateDeliveryRepository";
import { getMockStore } from "./mockStore";

export function bindDeploymentControlRepository(
  client: DynamoDBClient,
  tables: ControlTableNames,
) {
  if (!config.mock.enabled)
    return createDynamoDeploymentControlRepository(client, tables, {
      localBootstrap: config.database.useLocalDynamoDB && !config.runtime.ecs,
    });
  const store = getMockStore();
  return createMockDeploymentControlRepository(
    store.deploymentControlRecords,
    store.meetingHistoryByGuild,
    store.activeMeetingLeases,
  );
}
export function bindMeetingUpdateDeliveryRepository(
  client: DynamoDBClient,
  tables: ControlTableNames,
) {
  if (!config.mock.enabled)
    return createDynamoMeetingUpdateDeliveryRepository(client, tables);
  const store = getMockStore();
  return createMockMeetingUpdateDeliveryRepository(
    store.meetingHistoryByGuild,
    (authority) =>
      mockWorkAdmissionAllowed(
        authority,
        store.deploymentControlRecords,
        store.activeMeetingLeases,
      ),
    store.personalMediaUploadsById,
    store.deploymentControlRecords,
  );
}
