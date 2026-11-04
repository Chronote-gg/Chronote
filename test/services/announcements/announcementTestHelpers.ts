import { AnnouncementInputError } from "../../../src/services/announcements/announcementTypes";

/** Runs a parse that must fail and returns its problem list. */
export const problemsOf = (run: () => unknown): string[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof AnnouncementInputError) return error.problems;
    throw error;
  }
  throw new Error("expected an AnnouncementInputError");
};
