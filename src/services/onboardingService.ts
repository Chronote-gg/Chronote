import type { OnboardingState } from "../types/db";
import { getOnboardingRepository } from "../repositories/onboardingRepository";
import { captureEvent } from "./analyticsService";

export async function fetchOnboardingState(guildId: string, userId: string) {
  return getOnboardingRepository().get(guildId, userId);
}

export async function saveOnboardingState(state: OnboardingState) {
  // Only a step change is an event. Reopening /onboard at the current step, or
  // picking channels within the autorecord step, saves repeatedly without
  // advancing, and counting those would inflate each step and make the
  // drop-off ratios meaningless.
  const previous = await getOnboardingRepository().get(
    state.guildId,
    state.userId,
  );
  const result = await getOnboardingRepository().write(state);
  if (previous?.step !== state.step) {
    captureEvent("onboarding_step_reached", {
      userId: state.userId,
      guildId: state.guildId,
      properties: { step: state.step, autorecord_mode: state.autorecordMode },
    });
  }
  return result;
}

export async function removeOnboardingState(guildId: string, userId: string) {
  return getOnboardingRepository().delete(guildId, userId);
}
