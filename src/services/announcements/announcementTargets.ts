// Imported from the pure module, not discordPermissionsService, so resolving
// targets never loads the app config or the Discord client.
import { computeChannelPermissions } from "../discordPermissionsCompute";
import type { DiscordChannel } from "../../repositories/types";
import type {
  CandidateRejection,
  ChannelSource,
  GuildSnapshot,
  RequiredPermissionName,
  TargetDecision,
} from "./announcementTypes";

type PostSource = Exclude<ChannelSource, "owner_dm">;
type Candidate = { source: PostSource; channelId: string };

const GUILD_TEXT_CHANNEL = 0;
const GUILD_ANNOUNCEMENT_CHANNEL = 5;
const POSTABLE_CHANNEL_TYPES = new Set([
  GUILD_TEXT_CHANNEL,
  GUILD_ANNOUNCEMENT_CHANNEL,
]);

// Listed in the order missing permissions are reported.
const REQUIRED_PERMISSIONS: { name: RequiredPermissionName; bit: bigint }[] = [
  { name: "ViewChannel", bit: 1n << 10n },
  { name: "SendMessages", bit: 1n << 11n },
  { name: "EmbedLinks", bit: 1n << 14n },
];

type CandidateResult =
  | { postable: true; channelId: string }
  | { postable: false; rejection: CandidateRejection };

const missingPermissions = (
  snapshot: GuildSnapshot,
  botUserId: string,
  channel: DiscordChannel,
): RequiredPermissionName[] => {
  const permissions = computeChannelPermissions({
    guildId: snapshot.guildId,
    memberId: botUserId,
    roles: snapshot.roles,
    memberRoleIds: snapshot.botRoleIds,
    overwrites: channel.permission_overwrites ?? [],
  });
  return REQUIRED_PERMISSIONS.filter(
    ({ bit }) => (permissions & bit) === 0n,
  ).map(({ name }) => name);
};

const evaluateCandidate = (
  snapshot: GuildSnapshot,
  botUserId: string,
  candidate: Candidate,
  seenChannelIds: Set<string>,
): CandidateResult => {
  const { source, channelId } = candidate;
  const reject = (
    problem: CandidateRejection["problem"],
    missing?: RequiredPermissionName[],
  ): CandidateResult => ({
    postable: false,
    rejection: { source, channelId, problem, ...(missing ? { missing } : {}) },
  });

  if (seenChannelIds.has(channelId)) return reject("duplicate");
  seenChannelIds.add(channelId);

  const channel = snapshot.channels.find((entry) => entry.id === channelId);
  if (!channel) return reject("missing");
  if (!POSTABLE_CHANNEL_TYPES.has(channel.type)) return reject("not_text");

  const missing = missingPermissions(snapshot, botUserId, channel);
  if (missing.length > 0) return reject("missing_permissions", missing);
  return { postable: true, channelId };
};

const fallbackCandidates = (snapshot: GuildSnapshot): Candidate[] => {
  const ordered: { source: PostSource; channelId: string | null }[] = [
    { source: "notes", channelId: snapshot.notesChannelId },
    { source: "system", channelId: snapshot.systemChannelId },
  ];
  return ordered.flatMap(({ source, channelId }) =>
    channelId === null ? [] : [{ source, channelId }],
  );
};

/**
 * Picks where one server's announcement goes. A usable community updates
 * channel is the only candidate when it exists: if the bot cannot post there,
 * the owner is told by DM rather than the notice landing somewhere members
 * did not choose. Otherwise the notes channel, then the system channel.
 */
export const resolveAnnouncementTarget = (
  snapshot: GuildSnapshot,
  botUserId: string,
  optedOut: boolean,
): TargetDecision => {
  if (optedOut) return { kind: "skip", reason: "opted_out", rejected: [] };

  const rejected: CandidateRejection[] = [];
  const seenChannelIds = new Set<string>();

  if (snapshot.publicUpdatesChannelId !== null) {
    const updates = evaluateCandidate(
      snapshot,
      botUserId,
      { source: "public_updates", channelId: snapshot.publicUpdatesChannelId },
      seenChannelIds,
    );
    if (updates.postable) {
      return {
        kind: "target",
        channelId: updates.channelId,
        channelSource: "public_updates",
        rejected,
      };
    }
    rejected.push(updates.rejection);
    if (updates.rejection.problem === "missing_permissions") {
      return {
        kind: "owner_dm",
        ownerId: snapshot.ownerId,
        guildName: snapshot.guildName,
        updatesChannelId: updates.rejection.channelId,
        missing: updates.rejection.missing ?? [],
        rejected,
      };
    }
  }

  for (const candidate of fallbackCandidates(snapshot)) {
    const result = evaluateCandidate(
      snapshot,
      botUserId,
      candidate,
      seenChannelIds,
    );
    if (result.postable) {
      return {
        kind: "target",
        channelId: result.channelId,
        channelSource: candidate.source,
        rejected,
      };
    }
    rejected.push(result.rejection);
  }

  const permissionBlocked = rejected.some(
    (rejection) => rejection.problem === "missing_permissions",
  );
  return {
    kind: "skip",
    reason: permissionBlocked ? "missing_permissions" : "no_channel",
    rejected,
  };
};
