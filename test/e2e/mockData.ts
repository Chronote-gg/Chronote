import { getMockStore } from "../../src/repositories/mockStore";

type MockGuild = { id: string; name: string };

const store = getMockStore();

const findGuild = (name: string): MockGuild | undefined =>
  store.userGuilds.find((guild) => guild.name === name);

const ddmGuild = findGuild("DDM") ?? store.userGuilds[0];
const chronoteGuild =
  findGuild("Chronote Crew") ?? store.userGuilds[1] ?? ddmGuild;

const ddmMeetings = store.meetingHistoryByGuild.get(ddmGuild.id) ?? [];
const activeMeetings = ddmMeetings.filter((meeting) => !meeting.archivedAt);
const firstMeetingNotes = activeMeetings[0]?.notes ?? "";
const meetingTitle = firstMeetingNotes.split("\n")[0]?.trim() || "Meeting";

const conversationKey = `USER#${store.user.id}#GUILD#${ddmGuild.id}`;
const conversations = store.askConversationsByKey.get(conversationKey) ?? [];
const activeConversations = conversations.filter((conv) => !conv.archivedAt);
const firstConversation = activeConversations[0];
const conversationSummary = firstConversation?.summary ?? "";
const conversationSummarySnippet = conversationSummary
  ? conversationSummary.split(" ").slice(0, 6).join(" ")
  : "";

const voiceChannels = store.channelsByGuild.get(ddmGuild.id) ?? [];
const firstRule = store.autoRecordByGuild.get(ddmGuild.id)?.[0];
const overrideChannelName =
  voiceChannels.find((channel) => channel.id === firstRule?.channelId)?.name ??
  "";
const overrideTag = firstRule?.tags?.[0] ?? "";

const subscription = store.subscriptions.get(ddmGuild.id);
const forcedTier = process.env.FORCE_TIER;
const forcedTierLabel =
  forcedTier === "pro"
    ? "Pro"
    : forcedTier === "basic"
      ? "Basic"
      : forcedTier === "free"
        ? "Free plan"
        : null;
const subscriptionTierLabel =
  subscription?.tier === "pro"
    ? "Pro"
    : subscription?.tier === "basic"
      ? "Basic"
      : "Free";
const paidTierLabel = forcedTierLabel ?? subscriptionTierLabel;
const freeTierLabel = forcedTierLabel ?? "Free plan";

export const mockGuilds = {
  ddm: ddmGuild,
  chronote: chronoteGuild,
};

export const mockLibrary = {
  meetingCount: activeMeetings.length,
  meetingTitle,
};

export const mockAsk = {
  conversationTitle: firstConversation?.title ?? "",
  conversationSummarySnippet,
};

export const mockSettings = {
  overrideChannelName,
  overrideTag,
};

export const mockBilling = {
  paidTierLabel,
  freeTierLabel,
};
