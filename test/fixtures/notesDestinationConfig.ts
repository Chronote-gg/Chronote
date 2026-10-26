import { CONFIG_KEYS } from "../../src/config/keys";
import { getGlobalConfigValues } from "../../src/services/appConfigService";
import { listConfigOverridesForScope } from "../../src/services/configOverridesService";

jest.mock("../../src/services/appConfigService", () => ({
  getGlobalConfigValues: jest.fn(),
}));
jest.mock("../../src/services/configOverridesService", () => ({
  listConfigOverridesForScope: jest.fn(),
}));

export function mockNotesDestinations(
  select: (scope: string) => string | undefined,
) {
  jest.mocked(getGlobalConfigValues).mockResolvedValue({});
  jest
    .mocked(listConfigOverridesForScope)
    .mockImplementation(async (context) => {
      const value = select(context.scope);
      return value === undefined
        ? []
        : [
            {
              scopeId: `${context.scope}#guild-1`,
              configKey: CONFIG_KEYS.notes.channelId,
              value,
              updatedAt: "2026-10-16T00:00:00Z",
              updatedBy: "user-1",
            },
          ];
    });
}
