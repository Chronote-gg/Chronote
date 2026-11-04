import { existsSync, lstatSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { MeetingData } from "../types/meeting-data";
import type { SessionReservation } from "../types/deploymentControl";
import {
  createArtifactProducerRegistry,
  type ArtifactProducer,
} from "./artifactProducerRegistry";
import { getMeetingTempDir } from "./tempFileService";

export const meetingArtifactProducers = createArtifactProducerRegistry();
const handles = new WeakMap<object, ArtifactProducer>();
type ArtifactMeeting = Pick<MeetingData, "guildId" | "meetingId"> & {
  reservation?: Pick<
    SessionReservation,
    | "guildId"
    | "meetingId"
    | "ownerInstanceId"
    | "executionVersion"
    | "sessionMode"
  >;
};

export function getMeetingArtifactProducer(meeting: ArtifactMeeting) {
  const reservation = meeting.reservation;
  if (!reservation || reservation.sessionMode !== "meeting") return undefined;
  if (
    reservation.guildId !== meeting.guildId ||
    reservation.meetingId !== meeting.meetingId
  )
    throw new Error("Artifact reservation differs from meeting");
  const owner = {
    guildId: meeting.guildId,
    meetingId: meeting.meetingId,
    ownerInstanceId: reservation.ownerInstanceId,
    executionVersion: reservation.executionVersion,
  };
  const previous = handles.get(meeting);
  if (previous) {
    if (!isDeepStrictEqual(previous.owner, owner))
      throw new Error("Artifact reservation changed");
    return previous;
  }
  const directory = getMeetingTempDir(meeting);
  if (!meetingArtifactProducers.get(directory) && existsSync(directory)) {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      readdirSync(directory).length
    )
      throw new Error("Cannot adopt existing local artifacts");
  }
  const producer = meetingArtifactProducers.claim({ directory, owner });
  handles.set(meeting, producer);
  return producer;
}

export function getMeetingTranscriptionWriter(meeting: ArtifactMeeting) {
  const producer = getMeetingArtifactProducer(meeting);
  return producer
    ? (filename: string) =>
        producer.beginWrite(filename, {
          kind: "captured_audio",
          producer: "transcription_scratch",
        })
    : undefined;
}
