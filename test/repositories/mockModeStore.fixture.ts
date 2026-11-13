import { resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";

/** Runs each test of the enclosing describe in mock mode against an empty mock store. */
export function useMockModeStore() {
  const enabled = config.mock.enabled;
  beforeEach(() => {
    config.mock.enabled = true;
    resetMockStore();
  });
  afterEach(() => {
    config.mock.enabled = enabled;
    resetMockStore();
  });
}
