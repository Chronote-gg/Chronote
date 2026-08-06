import type { OnboardingState } from "../types/db";
import { getOnboardingRepository } from "../repositories/onboardingRepository";
import { captureEvent } from "./analyticsService";

export async function fetchOnboardingState(guildId: string, userId: string) {
  return getOnboardingRepository().get(guildId, userId);
}

export async function saveOnboardingState(state: OnboardingState) {
  const result = await getOnboardingRepository().write(state);
  // One event per step rather than started/completed, so a drop-off shows
  // which step lost people instead of only that they never finished.
  captureEvent("onboarding_step_reached", {
    userId: state.userId,
    guildId: state.guildId,
    properties: { step: state.step, autorecord_mode: state.autorecordMode },
  });
  return result;
}

export async function removeOnboardingState(guildId: string, userId: string) {
  return getOnboardingRepository().delete(guildId, userId);
}
