import type { MeetingData } from "../types/meeting-data";
import { buildModelOverrides } from "./modelFactory";

export const getMeetingModelOverrides = (meeting: MeetingData) =>
  buildModelOverrides(meeting.runtimeConfig?.modelChoices);
