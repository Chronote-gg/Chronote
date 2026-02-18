import { Participant } from "./participants";
import type {
  AutoRecordRule,
  MeetingEndReason,
  MeetingStartReason,
  MeetingStatus,
} from "./meetingLifecycle";

export interface GuildSubscription {
  guildId: string;
  status: string;
  tier: string;
  startDate: string;
  endDate?: string;
  nextBillingDate?: string;
  paymentMethod?: string;
  subscriptionType: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  priceId?: string;
  updatedAt?: string;
  updatedBy?: string;
  mode?: "live" | "test";
}

// Payment Transaction Type
export interface PaymentTransaction {
  transactionID: string;
  userID: string;
  amount: number;
  currency: string;
  status: string;
  paymentDate: string;
  paymentMethod: string;
  discountCode?: string;
  subscriptionID: string;
  customerId?: string;
}

export interface StripeWebhookEvent {
  eventId: string;
  receivedAt: string;
  expiresAt: number;
}

export interface InteractionReceipt {
  interactionId: string;
  createdAt: string;
  expiresAt: number;
  guildId?: string;
  interactionKind: string;
}

export interface ActiveMeetingLease {
  guildId: string;
  meetingId: string;
  ownerInstanceId: string;
  voiceChannelId: string;
  voiceChannelName?: string;
  textChannelId: string;
  isAutoRecording: boolean;
  status?: MeetingStatus;
  startReason?: MeetingStartReason;
  startTriggeredByUserId?: string;
  autoRecordRule?: AutoRecordRule;
  endReason?: MeetingEndReason;
  endTriggeredByUserId?: string;
  cancellationReason?: string;
  endedAt?: string;
  leaseExpiresAt: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  endRequestedAt?: string;
  endRequestedByUserId?: string;
}

// Access Logs Type
export interface AccessLog {
  accessLogID: string;
  userID: string;
  meetingID: string;
  accessTime: string;
  fileType: string;
  ipAddress?: string;
}

// Recording/Transcript Type
export interface RecordingTranscript {
  meetingID: string;
  fileType: string;
  fileLocation: string;
  fileSize: number;
  expirationDate?: string;
}

export interface SuggestionHistoryEntry {
  userId: string;
  userTag?: string;
  displayName?: string;
  text: string;
  createdAt: string; // ISO timestamp
}

export interface NotesHistoryEntry {
  version: number;
  notes: string;
  editedBy: string;
  editedAt: string; // ISO timestamp
}

export type FeedbackRating = "up" | "down";
export type FeedbackTargetType = "meeting_summary" | "ask_answer";
export type FeedbackSource = "discord" | "web";

export interface FeedbackRecord {
  pk: string; // TARGET#<targetType>#<targetId>
  sk: string; // USER#<userId>
  type: "feedback";
  targetType: FeedbackTargetType;
  targetId: string;
  guildId: string;
  channelId?: string;
  meetingId?: string;
  // For ask_answer, channelId or conversationId is required.
  conversationId?: string;
  messageId?: string;
  notesVersion?: number;
  summarySentence?: string;
  summaryLabel?: string;
  rating: FeedbackRating;
  comment?: string;
  source: FeedbackSource;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  userId: string;
  userTag?: string;
  displayName?: string;
}

// Auto Record Settings Type
export interface AutoRecordSettings {
  guildId: string; // Partition key
  channelId: string; // Sort key - use "ALL" for record all channels
  textChannelId?: string; // Where to send meeting notifications (optional if using defaults)
  enabled: boolean; // Whether auto-recording is active
  recordAll: boolean; // True if this is a guild-wide setting
  createdBy: string; // User ID who created this setting
  createdAt: string; // ISO timestamp
  tags?: string[]; // Default tags to apply to meetings started by this rule
}

// Server Context Type
export interface ServerContext {
  guildId: string; // Partition key
  context: string; // The context/instructions for the server
  defaultNotesChannelId?: string;
  defaultTags?: string[];
  liveVoiceEnabled?: boolean;
  liveVoiceCommandsEnabled?: boolean;
  liveVoiceTtsVoice?: string;
  chatTtsEnabled?: boolean;
  chatTtsVoice?: string;
  askMembersEnabled?: boolean;
  askSharingPolicy?: "off" | "server" | "public";
  updatedAt: string; // ISO timestamp
  updatedBy: string; // User ID who last updated
}

// Channel Context Type
export interface ChannelContext {
  guildId: string; // Partition key
  channelId: string; // Sort key
  context?: string; // The context/instructions for the channel
  liveVoiceEnabled?: boolean;
  liveVoiceCommandsEnabled?: boolean;
  chatTtsEnabled?: boolean;
  updatedAt: string; // ISO timestamp
  updatedBy: string; // User ID who last updated
}

export interface UserSpeechSettings {
  guildId: string; // Partition key
  userId: string; // Sort key
  chatTtsDisabled?: boolean;
  chatTtsVoice?: string;
  updatedAt: string; // ISO timestamp
  updatedBy: string; // User ID who last updated
}

export interface DictionaryEntry {
  guildId: string; // Partition key
  termKey: string; // Sort key, normalized term
  term: string; // Display term
  definition?: string;
  createdAt: string; // ISO timestamp
  createdBy: string; // User ID who created
  updatedAt: string; // ISO timestamp
  updatedBy: string; // User ID who last updated
}

export interface ConfigOverrideRecord {
  scopeId: string; // Partition key, formatted as scope#id
  configKey: string; // Sort key
  value: unknown;
  updatedAt: string; // ISO timestamp
  updatedBy: string; // User ID who last updated
}

export interface GuildInstaller {
  guildId: string; // Partition key
  installerId: string;
  installedAt: string; // ISO timestamp
}

export type OnboardingStep =
  | "context"
  | "autorecord"
  | "tour"
  | "upgrade"
  | "complete";

export interface OnboardingState {
  guildId: string; // Partition key
  userId: string; // Sort key
  step: OnboardingStep;
  contextDescription?: string;
  toneNotes?: string;
  autorecordMode?: "off" | "one" | "all";
  autorecordVoiceChannelId?: string;
  autorecordTextChannelId?: string;
  updatedAt: string; // ISO timestamp
  ttl: number; // epoch seconds for Dynamo TTL
}

// Meeting History Type
export interface MeetingHistory {
  guildId: string; // Partition key
  channelId_timestamp: string; // Sort key (channelId#ISO-timestamp)
  meetingId: string; // Unique meeting identifier
  channelId: string; // Denormalized for easier queries
  textChannelId?: string; // Channel id where the summary was posted
  timestamp: string; // ISO timestamp (denormalized)
  tags?: string[]; // Freeform tags for filtering / search
  notes?: string; // AI-generated notes (comprehensive, includes everything)
  notesDelta?: unknown; // Optional rich-text source for notes (Quill Delta)
  meetingName?: string; // User-facing meeting name (editable)
  summarySentence?: string; // One-sentence summary for UI
  summaryLabel?: string; // Short label (5 words or fewer)
  context?: string; // Meeting-specific context if provided
  participants: Participant[]; // Snapshot of participant identities
  attendees?: string[]; // Legacy list of attendee user tags
  duration: number; // Meeting duration in seconds
  transcribeMeeting: boolean; // Whether transcription was enabled
  generateNotes: boolean; // Whether notes were generated
  meetingCreatorId?: string; // User ID that started the meeting
  isAutoRecording?: boolean; // Whether this meeting was auto-started
  status?: MeetingStatus; // Live meeting status
  startReason?: MeetingStartReason;
  startTriggeredByUserId?: string;
  autoRecordRule?: AutoRecordRule;
  endReason?: MeetingEndReason;
  endTriggeredByUserId?: string;
  cancellationReason?: string;
  summaryMessageId?: string; // Message id for the summary embed
  notesMessageIds?: string[]; // All message ids when notes span multiple messages
  notesChannelId?: string; // Channel id where notes were posted
  notesVersion?: number; // Incremented on corrections
  updatedAt?: string; // Last time notes were edited
  notesLastEditedBy?: string; // User ID who last edited notes
  notesLastEditedAt?: string; // Timestamp of last notes edit
  archivedAt?: string; // Timestamp when archived
  archivedByUserId?: string; // User ID who archived
  transcript?: string; // Deprecated: transcript now stored in S3 JSON; kept only for legacy records
  transcriptS3Key?: string; // S3 object key where transcript JSON is stored
  suggestionsHistory?: SuggestionHistoryEntry[]; // Chronological list of suggestions applied
  notesHistory?: NotesHistoryEntry[]; // Versions of notes as they change
  audioS3Key?: string; // S3 key for combined audio
  chatS3Key?: string; // S3 key for chat log/json
}

export interface AskConversationRecord {
  pk: string;
  sk: string;
  type: "conversation";
  conversationId: string;
  guildId: string;
  userId: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  visibility?: "private" | "server" | "public";
  sharedAt?: string;
  sharedByUserId?: string;
  sharedByTag?: string;
  archivedAt?: string;
  archivedByUserId?: string;
}

export interface AskMessageRecord {
  pk: string;
  sk: string;
  type: "message";
  conversationId: string;
  messageId: string;
  role: "user" | "chronote";
  text: string;
  createdAt: string;
  sourceMeetingIds?: string[];
  citations?: AskCitationRecord[];
}

export interface AskCitationRecord {
  index: number;
  meetingId: string;
  eventId?: string;
}

export interface AskConversationShareRecord {
  pk: string;
  sk: string;
  type: "share";
  conversationId: string;
  guildId: string;
  ownerUserId: string;
  ownerTag?: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  sharedAt: string;
  sharedByUserId: string;
  sharedByTag?: string;
  archivedAt?: string;
  archivedByUserId?: string;
}

export type MeetingShareVisibility = "server" | "public";

export interface MeetingShareRecord {
  pk: string;
  sk: string;
  type: "meetingShare";
  guildId: string;
  meetingId: string;
  shareId: string;
  visibility: MeetingShareVisibility;
  sharedAt: string;
  sharedByUserId: string;
  sharedByTag?: string;
  rotatedAt?: string;
}

export interface MeetingShareByMeetingRecord {
  pk: string;
  sk: string;
  type: "meetingShareByMeeting";
  guildId: string;
  meetingId: string;
  shareId: string;
  visibility: MeetingShareVisibility;
  updatedAt: string;
}
