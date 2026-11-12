/** @jest-environment node */
import {
  ENDED_REPLY,
  GUILD,
  MEETING,
  USER,
  eventsOf,
  interaction,
  listener,
  liveLease,
  liveMeeting,
  mockWorld,
  useRoutingWorkers,
  workerA,
  workerB,
} from "./bot.interactionRouting.harness";

useRoutingWorkers();

describe("interaction routing", () => {
  test.each([true, false])(
    "owner control is handled by the recording worker, eligible or not (eligible: %s)",
    async (eligible) => {
      workerA.eligible = eligible;
      workerA.live = liveMeeting();
      mockWorld.lease = async () => liveLease();
      await listener(workerA, "interactionCreate")(interaction(workerA, "end"));
      expect(eventsOf(workerA)).toEqual(["receipt", "handle-end", "reply"]);
    },
  );

  test("owner control for a start in progress in this process is applied to that start", async () => {
    workerA.eligible = false;
    workerA.starting = MEETING;
    mockWorld.lease = async () => liveLease();
    const leave = interaction(workerA, "leave");
    await listener(workerA, "interactionCreate")(leave);
    expect(eventsOf(workerA)).toEqual(["receipt", "defer", "lease", "edit"]);
    expect(mockWorld.endRequests).toEqual([
      [GUILD, MEETING, USER, expect.any(String), "leave_command"],
    ]);
    expect(leave.editReply).toHaveBeenCalledWith(
      "Chronote is still joining. The meeting will end as soon as it has started.",
    );
  });

  test("a non-eligible worker with no live session ignores a start and writes no receipt", async () => {
    workerA.eligible = false;
    const start = interaction(workerA, "start");
    await listener(workerA, "interactionCreate")(start);
    expect(eventsOf(workerA)).toEqual([]);
    expect(mockWorld.receipts.size).toBe(0);
  });

  test("an eligible worker that does not hold the session stays silent while another worker's lease is live", async () => {
    mockWorld.lease = async () => liveLease();
    for (const kind of ["end", "leave", "say", "dismiss"] as const)
      await listener(workerA, "interactionCreate")(interaction(workerA, kind));
    expect(eventsOf(workerA)).toEqual(["lease", "lease", "lease", "lease"]);
    expect(mockWorld.receipts.size).toBe(0);
  });

  test("ended recording reply when no lease is live", async () => {
    const end = interaction(workerA, "end");
    await listener(workerA, "interactionCreate")(end);
    expect(end.reply).toHaveBeenCalledTimes(1);
    expect(end.reply).toHaveBeenCalledWith({
      content: ENDED_REPLY,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  });

  test.each([
    {
      name: "an expired lease counts as no live recording",
      lease: () => ({ ...liveLease(), leaseExpiresAt: 1 }),
    },
    {
      name: "an owner control on this worker's own leftover lease gets the ended reply",
      lease: () => ({
        ...liveLease(),
        ownerInstanceId: "synthetic-instance-A",
      }),
    },
  ])("$name", async ({ lease }) => {
    mockWorld.lease = async () => lease();
    const end = interaction(workerA, "end");
    await listener(workerA, "interactionCreate")(end);
    expect(end.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: ENDED_REPLY }),
    );
  });

  test("with nothing live, /say goes to its handler instead of the ended reply", async () => {
    await listener(workerA, "interactionCreate")(interaction(workerA, "say"));
    expect(eventsOf(workerA)).toEqual([
      "lease",
      "receipt",
      "handle-say",
      "reply",
    ]);
  });

  test("two eligible workers receive the same command: exactly one responds", async () => {
    const id = "synthetic-shared-interaction";
    await Promise.all([
      listener(workerA, "interactionCreate")(interaction(workerA, "ask", id)),
      listener(workerB, "interactionCreate")(interaction(workerB, "ask", id)),
    ]);
    const responses = mockWorld.events.filter((event) =>
      event.startsWith("reply:"),
    );
    expect(responses).toHaveLength(1);
    expect(
      mockWorld.events.filter((event) => event.startsWith("handle-ask:")),
    ).toHaveLength(1);
  });

  test("two workers receiving one ended control: exactly one replies", async () => {
    const id = "synthetic-shared-control";
    await Promise.all([
      listener(workerA, "interactionCreate")(interaction(workerA, "end", id)),
      listener(workerB, "interactionCreate")(interaction(workerB, "end", id)),
    ]);
    expect(
      mockWorld.events.filter((event) => event.startsWith("reply:")),
    ).toHaveLength(1);
  });

  test("the first response follows only the receipt write", async () => {
    await listener(workerA, "interactionCreate")(interaction(workerA, "end"));
    expect(eventsOf(workerA)).toEqual(["lease", "receipt", "reply"]);

    mockWorld.events = [];
    workerA.starting = MEETING;
    mockWorld.lease = async () => liveLease();
    await listener(
      workerA,
      "interactionCreate",
    )(interaction(workerA, "dismiss", "synthetic-starting-dismiss"));
    expect(eventsOf(workerA).slice(0, 2)).toEqual(["receipt", "defer"]);

    mockWorld.events = [];
    workerA.starting = undefined;
    await listener(
      workerA,
      "interactionCreate",
    )(interaction(workerA, "ask", "synthetic-general"));
    expect(eventsOf(workerA)).toEqual(["receipt", "handle-ask", "reply"]);
  });

  test.each(["general", "ended"] as const)(
    "a claim that throws sends no reply (%s)",
    async (branch) => {
      mockWorld.receiptFailure = "throw";
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const pressed = interaction(
        workerA,
        branch === "general" ? "ask" : "end",
      );
      await listener(workerA, "interactionCreate")(pressed);
      expect(pressed.reply).not.toHaveBeenCalled();
      expect(pressed.followUp).not.toHaveBeenCalled();
      expect(pressed.editReply).not.toHaveBeenCalled();
      expect(eventsOf(workerA)).not.toContain("handle-ask");
      expect(warn).toHaveBeenCalledWith(
        "Interaction receipt claim failed; not responding",
        expect.objectContaining({ interactionId: pressed.id }),
      );
      expect(console.log).not.toHaveBeenCalledWith(
        "Skipping duplicate interaction",
        expect.anything(),
      );
      error.mockRestore();
      warn.mockRestore();
    },
  );

  test("a claim that times out sends no reply", async () => {
    mockWorld.receiptFailure = "hang";
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const pressed = interaction(workerA, "ask");
    await listener(workerA, "interactionCreate")(pressed);
    expect(pressed.reply).not.toHaveBeenCalled();
    expect(pressed.followUp).not.toHaveBeenCalled();
    expect(eventsOf(workerA)).toEqual(["receipt"]);
    expect(warn).toHaveBeenCalledWith(
      "Interaction receipt claim timed out; not responding",
      expect.objectContaining({ interactionId: pressed.id }),
    );
    error.mockRestore();
    warn.mockRestore();
  }, 5_000);

  test("a duplicate is logged as held by another worker", async () => {
    mockWorld.receipts.add("synthetic-interaction-ask");
    await listener(workerA, "interactionCreate")(interaction(workerA, "ask"));
    expect(console.log).toHaveBeenCalledWith(
      "Skipping duplicate interaction",
      expect.objectContaining({ interactionId: "synthetic-interaction-ask" }),
    );
  });

  test("edit tags during another worker's live recording is handled by the recording worker", async () => {
    workerA.eligible = false;
    workerA.live = liveMeeting();
    mockWorld.lease = async () => ({
      ...liveLease(),
      ownerInstanceId: "synthetic-instance-A",
    });
    for (const kind of ["edit-tags", "edit-tags-modal"] as const) {
      const id = `synthetic-shared-${kind}`;
      await Promise.all([
        listener(workerA, "interactionCreate")(interaction(workerA, kind, id)),
        listener(workerB, "interactionCreate")(interaction(workerB, kind, id)),
      ]);
    }
    expect(eventsOf(workerA)).toEqual([
      "receipt",
      "handle-edit-tags",
      "reply",
      "receipt",
      "handle-edit-tags-modal",
      "reply",
    ]);
    expect(eventsOf(workerB)).toEqual(["lease", "lease"]);
  });

  test("/tts stop on a draining worker's session reaches that worker", async () => {
    workerA.eligible = false;
    workerA.live = liveMeeting();
    mockWorld.lease = async () => ({
      ...liveLease(),
      ownerInstanceId: "synthetic-instance-A",
    });
    await Promise.all([
      listener(workerA, "interactionCreate")(interaction(workerA, "tts")),
      listener(workerB, "interactionCreate")(interaction(workerB, "tts")),
    ]);
    expect(eventsOf(workerA)).toEqual(["receipt", "handle-tts", "reply"]);
    expect(eventsOf(workerB)).toEqual(["lease"]);
  });

  test("generate image with no live session runs the normal handler", async () => {
    const pressed = interaction(workerA, "generate-image");
    await listener(workerA, "interactionCreate")(pressed);
    expect(eventsOf(workerA)).toEqual([
      "lease",
      "receipt",
      "handle-generate-image",
      "reply",
    ]);
    expect(pressed.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: ENDED_REPLY }),
    );
  });

  test("Stop recording aimed at another user is not a control and gets its handler", async () => {
    const dismiss = interaction(workerA, "dismiss", undefined, {
      target: "synthetic-someone-else",
    });
    await listener(workerA, "interactionCreate")(dismiss);
    expect(eventsOf(workerA)).toEqual(["receipt", "handle-dismiss", "reply"]);
    expect(dismiss.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: ENDED_REPLY }),
    );
  });

  test("Stop recording during a start applies the auto-record dismiss policy", async () => {
    workerA.starting = MEETING;
    mockWorld.lease = async () => ({ ...liveLease(), isAutoRecording: true });
    mockWorld.dismissRefusal = "synthetic policy refusal";
    const dismiss = interaction(workerA, "dismiss");
    await listener(workerA, "interactionCreate")(dismiss);
    expect(dismiss.editReply).toHaveBeenCalledWith("synthetic policy refusal");
    expect(mockWorld.endRequests).toEqual([]);

    mockWorld.dismissRefusal = undefined;
    await listener(
      workerA,
      "interactionCreate",
    )(interaction(workerA, "dismiss", "synthetic-allowed-dismiss"));
    expect(mockWorld.endRequests).toEqual([
      [GUILD, MEETING, USER, expect.any(String), "dismissed"],
    ]);
  });

  test("a failed lease read answers nothing", async () => {
    mockWorld.lease = async () => {
      throw new Error("synthetic lease read failure");
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const end = interaction(workerA, "end");
    await listener(workerA, "interactionCreate")(end);
    expect(eventsOf(workerA)).toEqual(["lease"]);
    expect(end.reply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Lease read for a meeting control failed",
      expect.objectContaining({ interactionId: end.id }),
    );
    warn.mockRestore();
  });
});

describe("retired onboarding controls", () => {
  test.each([
    ["onboard", "handle-onboard"],
    ["onboard-button", "handle-onboard-button"],
    ["onboard-modal", "handle-onboard-modal"],
    ["onboard-select", "handle-onboard-select"],
  ] as const)(
    "a cached %s control reaches its retirement handler with installer DMs disabled",
    async (kind, handled) => {
      workerA.config!.server.onboardingEnabled = false;
      try {
        await listener(
          workerA,
          "interactionCreate",
        )(interaction(workerA, kind));
      } finally {
        workerA.config!.server.onboardingEnabled = true;
      }
      expect(eventsOf(workerA)).toEqual(["receipt", handled, "reply"]);
    },
  );
});
