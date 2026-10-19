import type {
  IntroductionHold,
  MaintenanceHold,
} from "../../src/types/productionIntroduction";
export function introductionFixture(
  maintenance: MaintenanceHold,
): IntroductionHold {
  return {
    pk: "ENV",
    sk: "INTRODUCTION",
    recordType: "production_introduction",
    protocolVersion: 1,
    ...maintenance,
    manifestHash: "manifest",
    admission: { state: "held" },
    deployment: { state: "held" },
  };
}
