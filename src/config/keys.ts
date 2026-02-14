export const CONFIG_KEYS = {
  features: {
    experimental: "features.experimental",
  },
  transcription: {
    premiumEnabled: "transcription.premium.enabled",
    premiumCleanupEnabled: "transcription.premium.cleanup.enabled",
    suppressionEnabled: "transcription.suppression.enabled",
    suppressionHardSilenceDbfs: "transcription.suppression.hardSilenceDbfs",
    suppressionRateMaxSeconds: "transcription.suppression.rateMaxSeconds",
    suppressionRateMinWords: "transcription.suppression.minWords",
    suppressionRateMinSyllables: "transcription.suppression.minSyllables",
    suppressionRateMaxSyllablesPerSecond:
      "transcription.suppression.maxSyllablesPerSecond",
    promptEchoEnabled: "transcription.promptEcho.enabled",
    fastSilenceMs: "transcription.fastSilenceMs",
    slowSilenceMs: "transcription.slowSilenceMs",
    minSnippetSeconds: "transcription.minSnippetSeconds",
    maxSnippetMs: "transcription.maxSnippetMs",
    fastFinalizationEnabled: "transcription.fastFinalization.enabled",
    interjectionEnabled: "transcription.interjection.enabled",
    interjectionMinSpeakerSeconds:
      "transcription.interjection.minSpeakerSeconds",
    noiseGateEnabled: "transcription.noiseGate.enabled",
    noiseGateWindowMs: "transcription.noiseGate.windowMs",
    noiseGatePeakDbfs: "transcription.noiseGate.peakDbfs",
    noiseGateMinActiveWindows: "transcription.noiseGate.minActiveWindows",
    noiseGateMinPeakAboveNoiseDb: "transcription.noiseGate.minPeakAboveNoiseDb",
    noiseGateApplyToFast: "transcription.noiseGate.applyToFast",
    noiseGateApplyToSlow: "transcription.noiseGate.applyToSlow",
  },
  models: {
    notes: "models.notes",
    meetingSummary: "models.meetingSummary",
    notesCorrection: "models.notesCorrection",
    transcription: "models.transcription",
    transcriptionCleanup: "models.transcriptionCleanup",
    transcriptionCoalesce: "models.transcriptionCoalesce",
    image: "models.image",
    imagePrompt: "models.imagePrompt",
    ask: "models.ask",
    liveVoiceGate: "models.liveVoiceGate",
    liveVoiceResponder: "models.liveVoiceResponder",
    liveVoiceTts: "models.liveVoiceTts",
    autoRecordCancel: "models.autoRecordCancel",
  },
  context: {
    instructions: "context.instructions",
  },
  notes: {
    channelId: "notes.channelId",
    tags: "notes.tags",
  },
  meetings: {
    attendeeAccessEnabled: "meetings.attendeeAccess.enabled",
  },
  visionCaptions: {
    enabled: "visionCaptions.enabled",
    maxImages: "visionCaptions.maxImages",
    maxTotalChars: "visionCaptions.maxTotalChars",
  },
  autorecord: {
    enabled: "autorecord.enabled",
    cancelEnabled: "autorecord.cancel.enabled",
    dismissPolicy: "autorecord.dismiss.policy",
  },
  liveVoice: {
    enabled: "liveVoice.enabled",
    commandsEnabled: "liveVoice.commands.enabled",
    ttsVoice: "liveVoice.ttsVoice",
  },
  chatTts: {
    enabled: "chatTts.enabled",
    voice: "chatTts.voice",
  },
  dictionary: {
    maxEntries: "dictionary.maxEntries",
    maxEntriesPro: "dictionary.maxEntries.pro",
    maxEntriesCap: "dictionary.maxEntries.cap",
    maxCharsTranscription: "dictionary.maxChars.transcription",
    maxCharsTranscriptionPro: "dictionary.maxChars.transcription.pro",
    maxCharsTranscriptionCap: "dictionary.maxChars.transcription.cap",
    maxCharsContext: "dictionary.maxChars.context",
    maxCharsContextPro: "dictionary.maxChars.context.pro",
    maxCharsContextCap: "dictionary.maxChars.context.cap",
  },
  ask: {
    membersEnabled: "ask.members.enabled",
    sharingPolicy: "ask.sharing.policy",
  },
} as const;

export const SERVER_CONTEXT_KEYS = {
  context: CONFIG_KEYS.context.instructions,
  defaultNotesChannelId: CONFIG_KEYS.notes.channelId,
  defaultTags: CONFIG_KEYS.notes.tags,
  liveVoiceEnabled: CONFIG_KEYS.liveVoice.enabled,
  liveVoiceCommandsEnabled: CONFIG_KEYS.liveVoice.commandsEnabled,
  liveVoiceTtsVoice: CONFIG_KEYS.liveVoice.ttsVoice,
  chatTtsEnabled: CONFIG_KEYS.chatTts.enabled,
  chatTtsVoice: CONFIG_KEYS.chatTts.voice,
  askMembersEnabled: CONFIG_KEYS.ask.membersEnabled,
  askSharingPolicy: CONFIG_KEYS.ask.sharingPolicy,
} as const;

export const SERVER_CONTEXT_KEY_LIST = Object.values(SERVER_CONTEXT_KEYS);
