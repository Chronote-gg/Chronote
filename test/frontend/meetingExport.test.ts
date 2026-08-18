import { MEETING_STATUS } from "../../src/types/meetingLifecycle";
import type {
  MeetingDetailInput,
  MeetingDetails,
} from "../../src/frontend/utils/meetingLibrary";
import {
  buildMeetingExport,
  downloadMeetingExport,
} from "../../src/frontend/pages/library/components/meetingExport";

const baseDetail: MeetingDetailInput = {
  id: "detail-1",
  meetingId: "meeting-1",
  channelId: "channel-1",
  timestamp: "2026-01-13T00:00:00.000Z",
  duration: 3600,
  tags: ["planning"],
  notes: "Summary notes.",
  transcript: "Transcript text.",
  attendees: ["Participant A"],
  events: [],
};

const baseMeeting: MeetingDetails = {
  id: "detail-1",
  meetingId: "meeting-1",
  title: "Weekly Sync / Alpha",
  summary: "Summary sentence.",
  notes: "Summary notes.",
  dateLabel: "Jan 13, 2026",
  durationLabel: "1h 00m",
  tags: ["planning"],
  channel: "#general",
  audioUrl: null,
  audioAccessEnabled: true,
  transcriptAccessEnabled: true,
  archivedAt: null,
  attendees: ["Participant A"],
  decisions: [],
  actions: [],
  events: [],
  status: MEETING_STATUS.COMPLETE,
};

describe("downloadMeetingExport", () => {
  it("omits disabled artifacts from exported meeting data", () => {
    const payload = buildMeetingExport(
      {
        ...baseDetail,
        transcriptAccessEnabled: false,
        audioAccessEnabled: false,
        audioUrl: "https://example.com/recording.mp3",
        events: [
          {
            id: "voice-1",
            type: "voice",
            time: "0:01",
            text: "Transcript-derived event",
          },
        ],
      },
      baseMeeting,
    );

    expect(payload.meeting).not.toHaveProperty("transcript");
    expect(payload.meeting).not.toHaveProperty("audioUrl");
    expect(payload.meeting.events).toEqual([]);
    expect(payload.meeting.notes).toBe("Summary notes.");
  });

  it("creates a downloadable JSON file with a safe filename", () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURLSpy = jest.fn().mockReturnValue("blob:mock");
    const revokeObjectURLSpy = jest.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURLSpy,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURLSpy,
      writable: true,
    });
    const originalCreateElement = document.createElement.bind(document);
    const clickSpy = jest.fn();
    let anchor: HTMLAnchorElement | null = null;

    const createElementSpy = jest
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        const element = originalCreateElement(tagName);
        if (tagName.toLowerCase() === "a") {
          anchor = element as HTMLAnchorElement;
          jest.spyOn(anchor, "click").mockImplementation(clickSpy);
        }
        return element;
      });

    downloadMeetingExport(baseDetail, baseMeeting);

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("blob:mock");
    expect(anchor?.download).toBe("Weekly_Sync_Alpha-Jan_13_2026.json");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock");

    createElementSpy.mockRestore();
    Object.defineProperty(URL, "createObjectURL", {
      value: originalCreateObjectURL,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: originalRevokeObjectURL,
      writable: true,
    });
  });
});
