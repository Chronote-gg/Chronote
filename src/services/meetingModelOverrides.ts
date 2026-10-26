import type { MeetingNotesInput } from "../types/meeting-data";
import { buildModelOverrides } from "./modelFactory";

export const getMeetingModelOverrides = (meeting: {
  runtimeConfig?: Pick<
    NonNullable<MeetingNotesInput["runtimeConfig"]>,
    "modelChoices"
  >;
}) => buildModelOverrides(meeting.runtimeConfig?.modelChoices);
