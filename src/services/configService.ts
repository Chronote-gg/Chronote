import dotenv from "dotenv";
import path from "node:path";

// Load environment variables once
dotenv.config();

const isMockMode =
  process.env.MOCK_MODE === "true" || process.argv.includes("--mock");

/**
 * Centralized configuration service
 * All environment variable access should go through this service
 */
class ConfigService {
  readonly mock = {
    enabled: isMockMode,
  };

  // Discord Configuration
  readonly discord = {
    botToken: process.env.DISCORD_BOT_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
    clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    callbackUrl: process.env.DISCORD_CALLBACK_URL!,
  };

  // OpenAI Configuration
  readonly openai = {
    apiKey: process.env.OPENAI_API_KEY!,
    organizationId: process.env.OPENAI_ORGANIZATION_ID,
    projectId: process.env.OPENAI_PROJECT_ID,
  };

  // Langfuse Configuration
  readonly langfuse = {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || "",
    secretKey: process.env.LANGFUSE_SECRET_KEY || "",
    baseUrl: process.env.LANGFUSE_BASE_URL || "",
    tracingEnabled: process.env.LANGFUSE_TRACING_ENABLED !== "false",
    tracingEnvironment: process.env.LANGFUSE_TRACING_ENVIRONMENT || "",
    release: process.env.LANGFUSE_RELEASE || "",
    promptLabel: process.env.LANGFUSE_PROMPT_LABEL || "production",
    promptCacheTtlMs:
      parseInt(process.env.LANGFUSE_PROMPT_CACHE_TTL_MS || "60000", 10) ||
      60000,
    meetingSummaryPromptName:
      process.env.LANGFUSE_PROMPT_MEETING_SUMMARY ||
      "chronote-meeting-summary-chat",
    notesPromptName:
      process.env.LANGFUSE_PROMPT_NOTES || "chronote-notes-system-chat",
    notesLongStoryPromptName:
      process.env.LANGFUSE_PROMPT_NOTES_LONG_STORY ||
      "chronote-notes-long-story-chat",
    notesContextTestPromptName:
      process.env.LANGFUSE_PROMPT_NOTES_CONTEXT_TEST ||
      "chronote-notes-context-test-chat",
    transcriptionCleanupPromptName:
      process.env.LANGFUSE_PROMPT_TRANSCRIPTION_CLEANUP ||
      "chronote-transcription-cleanup-chat",
    transcriptionCoalescePromptName:
      process.env.LANGFUSE_PROMPT_TRANSCRIPTION_COALESCE ||
      "chronote-transcription-coalesce-chat",
    transcriptionFinalPassPromptName:
      process.env.LANGFUSE_PROMPT_TRANSCRIPTION_FINAL_PASS ||
      "chronote-transcription-final-pass-chat",
    transcriptionPromptName:
      process.env.LANGFUSE_PROMPT_TRANSCRIPTION ||
      "chronote-transcription-prompt",
    imagePromptName:
      process.env.LANGFUSE_PROMPT_IMAGE || "chronote-image-prompt-chat",
    askPromptName:
      process.env.LANGFUSE_PROMPT_ASK || "chronote-ask-system-chat",
    notesCorrectionPromptName:
      process.env.LANGFUSE_PROMPT_NOTES_CORRECTION ||
      "chronote-notes-correction-chat",
    liveVoiceGatePromptName:
      process.env.LANGFUSE_PROMPT_LIVE_VOICE_GATE ||
      "chronote-live-voice-gate-chat",
    liveVoiceConfirmPromptName:
      process.env.LANGFUSE_PROMPT_LIVE_VOICE_CONFIRM ||
      "chronote-live-voice-confirm-chat",
    liveVoiceResponderPromptName:
      process.env.LANGFUSE_PROMPT_LIVE_VOICE_RESPONDER ||
      "chronote-live-voice-responder-chat",
  };

  // Context and Memory Configuration
  readonly context = {
    enableMemory: process.env.ENABLE_CONTEXT_MEMORY !== "false",
    memoryDepth: parseInt(process.env.MEMORY_DEPTH || "5", 10),
    maxContextLength: parseInt(process.env.MAX_CONTEXT_LENGTH || "30000", 10),
    testMode: process.env.CONTEXT_TEST_MODE === "true",
  };

  // Notes generation / testing configuration
  readonly notes = {
    model: process.env.NOTES_MODEL || "gpt-5.2",
    longStoryTestMode: process.env.NOTES_LONG_STORY_TEST_MODE === "true",
    longStoryTargetChars:
      parseInt(process.env.NOTES_LONG_STORY_TARGET_CHARS || "20000", 10) ||
      20000,
  };

  // AppConfig configuration
  readonly appConfig = {
    enabled: process.env.APP_CONFIG_ENABLED === "true",
    applicationId: process.env.APP_CONFIG_APPLICATION_ID || "",
    environmentId: process.env.APP_CONFIG_ENVIRONMENT_ID || "",
    profileId: process.env.APP_CONFIG_PROFILE_ID || "",
    deploymentStrategyId: process.env.APP_CONFIG_DEPLOYMENT_STRATEGY_ID || "",
    cacheTtlMs:
      parseInt(process.env.APP_CONFIG_CACHE_TTL_MS || "60000", 10) || 60000,
  };

  // Live voice configuration
  readonly liveVoice = {
    mode: process.env.LIVE_VOICE_MODE || "off",
    gateModel: process.env.LIVE_VOICE_GATE_MODEL || "gpt-5-mini",
    responderModel: process.env.LIVE_VOICE_RESPONDER_MODEL || "gpt-4o-mini",
    ttsModel: process.env.LIVE_VOICE_TTS_MODEL || "gpt-4o-mini-tts",
    ttsVoice: process.env.LIVE_VOICE_TTS_VOICE || "alloy",
    windowSeconds: parseInt(process.env.LIVE_VOICE_WINDOW_SECONDS || "90", 10),
    windowLines: parseInt(process.env.LIVE_VOICE_WINDOW_LINES || "40", 10),
    pastMeetingsMax: parseInt(
      process.env.LIVE_VOICE_PAST_MEETINGS_MAX || "3",
      10,
    ),
    pastMeetingsMaxChars: parseInt(
      process.env.LIVE_VOICE_PAST_MEETINGS_MAX_CHARS || "400",
      10,
    ),
    gateMaxOutputTokens: parseInt(
      process.env.LIVE_VOICE_GATE_MAX_OUTPUT_TOKENS || "256",
      10,
    ),
    thinkingCue: process.env.LIVE_VOICE_THINKING_CUE !== "false", // default on
    thinkingCueIntervalMs: parseInt(
      process.env.LIVE_VOICE_THINKING_CUE_INTERVAL_MS || "500",
      10,
    ),
  };

  // Chat-to-speech configuration
  readonly chatTts = {
    maxChars: parseInt(process.env.CHAT_TTS_MAX_CHARS || "400", 10),
    queueLimit: parseInt(process.env.CHAT_TTS_QUEUE_LIMIT || "10", 10),
    defaultVoice: process.env.CHAT_TTS_DEFAULT_VOICE || "alloy",
  };

  // Ask/Recall configuration
  readonly ask = {
    maxMeetings: parseInt(process.env.ASK_MAX_MEETINGS || "25", 10),
  };

  // Subscription / tier overrides
  readonly subscription = {
    forceTier: process.env.FORCE_TIER || "",
    stripeMode: process.env.STRIPE_MODE || "live",
  };

  // Admin configuration
  readonly admin = {
    superAdminUserIds: (process.env.SUPER_ADMIN_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  };

  // Contact feedback configuration
  readonly contactFeedback = {
    notificationChannelId: process.env.FEEDBACK_NOTIFICATION_CHANNEL_ID || "",
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || "",
    recaptchaSecretKey: process.env.RECAPTCHA_SECRET_KEY || "",
  };

  // Database Configuration
  readonly database = {
    useLocalDynamoDB:
      process.env.NODE_ENV === "development" &&
      process.env.USE_LOCAL_DYNAMODB === "true",
    tablePrefix: process.env.DDB_TABLE_PREFIX || "",
  };

  readonly paths = {
    meetingTempDir:
      process.env.MEETING_TEMP_DIR?.trim() ||
      path.resolve(process.cwd(), "tmp", "meetings"),
  };

  // Storage Configuration
  readonly storage = {
    transcriptBucket: process.env.TRANSCRIPTS_BUCKET,
    transcriptPrefix: process.env.TRANSCRIPTS_PREFIX || "",
    awsRegion: process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.STORAGE_ENDPOINT,
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || "",
  };

  // Bedrock Data Automation configuration (evals)
  readonly bedrock = {
    dataAutomationProfileArn:
      process.env.BEDROCK_DATA_AUTOMATION_PROFILE_ARN || "",
    dataAutomationProjectArn:
      process.env.BEDROCK_DATA_AUTOMATION_PROJECT_ARN || "",
    dataAutomationInputBucket:
      process.env.BEDROCK_DATA_AUTOMATION_INPUT_BUCKET ||
      process.env.TRANSCRIPTS_BUCKET ||
      "",
    dataAutomationOutputBucket:
      process.env.BEDROCK_DATA_AUTOMATION_OUTPUT_BUCKET ||
      process.env.TRANSCRIPTS_BUCKET ||
      "",
    dataAutomationInputPrefix:
      process.env.BEDROCK_DATA_AUTOMATION_INPUT_PREFIX ||
      "bedrock-evals/inputs",
    dataAutomationOutputPrefix:
      process.env.BEDROCK_DATA_AUTOMATION_OUTPUT_PREFIX ||
      "bedrock-evals/outputs",
    dataAutomationPollIntervalMs:
      parseInt(
        process.env.BEDROCK_DATA_AUTOMATION_POLL_INTERVAL_MS || "2000",
        10,
      ) || 2000,
    dataAutomationTimeoutMs:
      parseInt(
        process.env.BEDROCK_DATA_AUTOMATION_TIMEOUT_MS || "300000",
        10,
      ) || 300000,
  };

  // Server Configuration
  readonly server = {
    port: parseInt(process.env.PORT || "3001", 10),
    nodeEnv: process.env.NODE_ENV || "development",
    oauthSecret: process.env.OAUTH_SECRET || "",
    oauthEnabled: process.env.ENABLE_OAUTH !== "false" && !this.mock.enabled,
    onboardingEnabled: process.env.ENABLE_ONBOARDING === "true",
    npmPackageVersion: process.env.npm_package_version || "unknown",
    sessionTtlSeconds: parseInt(
      process.env.SESSION_TTL_SECONDS || `${60 * 60 * 24 * 7}`,
      10,
    ),
    // future: rate limit/budget configs per API route can live here
  };

  // Cache configuration
  readonly cache = {
    enabled: process.env.CACHE_ENABLED !== "false",
    redisUrl: process.env.REDIS_URL || process.env.CACHE_REDIS_URL || "",
    keyPrefix:
      process.env.CACHE_KEY_PREFIX ||
      process.env.DDB_TABLE_PREFIX ||
      process.env.NODE_ENV ||
      "development",
    memorySize: parseInt(process.env.CACHE_MEMORY_SIZE || "2000", 10) || 2000,
    invalidationEnabled: process.env.CACHE_INVALIDATION_ENABLED !== "false",
    referencesTtlSeconds:
      parseInt(process.env.CACHE_REFERENCES_TTL_SECONDS || "86400", 10) ||
      86400,
    defaultTtlSeconds:
      parseInt(process.env.CACHE_DEFAULT_TTL_SECONDS || "60", 10) || 60,
    discord: {
      userGuildsTtlSeconds:
        parseInt(
          process.env.CACHE_DISCORD_USER_GUILDS_TTL_SECONDS || "60",
          10,
        ) || 60,
      botGuildsTtlSeconds:
        parseInt(
          process.env.CACHE_DISCORD_BOT_GUILDS_TTL_SECONDS || "300",
          10,
        ) || 300,
      channelsTtlSeconds:
        parseInt(process.env.CACHE_DISCORD_CHANNELS_TTL_SECONDS || "60", 10) ||
        60,
      rolesTtlSeconds:
        parseInt(process.env.CACHE_DISCORD_ROLES_TTL_SECONDS || "60", 10) || 60,
      membersTtlSeconds:
        parseInt(process.env.CACHE_DISCORD_MEMBERS_TTL_SECONDS || "30", 10) ||
        30,
    },
  };

  readonly stripe = {
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    priceBasic: process.env.STRIPE_PRICE_BASIC || "",
    lookupKeys: {
      basicMonthly:
        process.env.STRIPE_PRICE_LOOKUP_BASIC_MONTHLY ||
        "chronote_basic_monthly",
      basicAnnual:
        process.env.STRIPE_PRICE_LOOKUP_BASIC_ANNUAL || "chronote_basic_annual",
      proMonthly:
        process.env.STRIPE_PRICE_LOOKUP_PRO_MONTHLY || "chronote_pro_monthly",
      proAnnual:
        process.env.STRIPE_PRICE_LOOKUP_PRO_ANNUAL || "chronote_pro_annual",
    },
    successUrl: process.env.STRIPE_SUCCESS_URL || "",
    cancelUrl: process.env.STRIPE_CANCEL_URL || "",
    portalReturnUrl: process.env.STRIPE_PORTAL_RETURN_URL || "",
    billingLandingUrl:
      process.env.BILLING_LANDING_URL ||
      process.env.STRIPE_SUCCESS_URL ||
      process.env.STRIPE_CANCEL_URL ||
      "",
  };

  // Frontend / CORS
  readonly frontend = {
    allowedOrigins: (process.env.FRONTEND_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
      .map((origin) => origin.replace(/\/$/, "")),
    siteUrl: process.env.FRONTEND_SITE_URL || "",
  };

  constructor() {
    // Validate required configuration
    this.validateConfig();
  }

  private validateConfig() {
    const required = this.mock.enabled
      ? []
      : [
          { name: "DISCORD_BOT_TOKEN", value: this.discord.botToken },
          { name: "DISCORD_CLIENT_ID", value: this.discord.clientId },
          { name: "OPENAI_API_KEY", value: this.openai.apiKey },
        ];
    required.push({
      name: "FRONTEND_SITE_URL",
      value: this.frontend.siteUrl,
    });

    const hasLangfuseConfig =
      this.langfuse.publicKey.length > 0 || this.langfuse.secretKey.length > 0;
    if (hasLangfuseConfig) {
      required.push(
        { name: "LANGFUSE_PUBLIC_KEY", value: this.langfuse.publicKey },
        { name: "LANGFUSE_SECRET_KEY", value: this.langfuse.secretKey },
      );
    }

    // Only require OAuth-related secrets if OAuth is enabled (default true)
    if (this.server.oauthEnabled) {
      required.push(
        { name: "DISCORD_CLIENT_SECRET", value: this.discord.clientSecret },
        { name: "DISCORD_CALLBACK_URL", value: this.discord.callbackUrl },
        { name: "OAUTH_SECRET", value: this.server.oauthSecret },
      );
    }

    // Stripe validation (optional unless key provided)
    if (this.stripe.secretKey) {
      required.push(
        { name: "STRIPE_SUCCESS_URL", value: this.stripe.successUrl },
        { name: "STRIPE_CANCEL_URL", value: this.stripe.cancelUrl },
      );
    }

    if (this.appConfig.enabled) {
      required.push(
        {
          name: "APP_CONFIG_APPLICATION_ID",
          value: this.appConfig.applicationId,
        },
        {
          name: "APP_CONFIG_ENVIRONMENT_ID",
          value: this.appConfig.environmentId,
        },
        { name: "APP_CONFIG_PROFILE_ID", value: this.appConfig.profileId },
        {
          name: "APP_CONFIG_DEPLOYMENT_STRATEGY_ID",
          value: this.appConfig.deploymentStrategyId,
        },
      );
    }

    const missing = required.filter((item) => !item.value);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing
          .map((item) => item.name)
          .join(", ")}`,
      );
    }
  }
}

// Export a singleton instance
export const config = new ConfigService();
