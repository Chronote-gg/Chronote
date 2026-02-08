# System Patterns: Meeting Notes Discord Bot

## 1. System Architecture Overview

The Meeting Notes Discord Bot is a Node.js application built with TypeScript. It interacts with several external services and has distinct components for its operation:

- **Discord Bot Core (`src/bot.ts`):**
  - Uses `discord.js` library for interacting with the Discord API.
  - Handles slash commands (e.g., `/startmeeting`) and button interactions.
  - Manages voice state updates (users joining/leaving channels).
  - Orchestrates the meeting lifecycle.
- **Meeting Management (`src/meetings.ts`):**
  - In-memory storage (`Map`) for active `MeetingData` objects, keyed by guild ID.
  - Tracks meeting state: chat logs, attendance, voice/text channels, audio data, start/end times.
- **Audio Handling (`src/audio.ts`):**
  - Uses `@discordjs/voice` for receiving audio streams from users.
  - Employs `prism-media` for Opus decoding.
  - Collects audio into snippets per user, managing silence and maximum snippet length.
  - Uses `fluent-ffmpeg` to process raw PCM audio data from snippets and combine them into a single MP3 file per meeting.
  - Splits the final MP3 into smaller chunks if it exceeds Discord's upload limit.
- **Transcription & AI Processing (`src/services/transcriptionService.ts`, `src/services/notesService.ts`, `src/services/imageService.ts`):**
  - Interfaces with OpenAI API (`openai` library) for:
    - Audio transcription (gpt-4o-transcribe model).
    - Generating summaries, to-do lists, meeting notes, and image prompts (GPT-5.1, gpt-5-mini, DALL-E 3 models).
  - Manages temporary files for audio snippets (PCM to WAV conversion for transcription).
  - Includes policies for retries, circuit breaking, and rate limiting (using `cockatiel` and `bottleneck`) for OpenAI API calls.
  - Constructs dynamic prompts for AI models based on meeting context (server name, attendees, etc.).
- **Command Handling (various files in `src/commands/`):**
  - Modularized logic for specific bot commands/actions:
    - `startMeeting.ts`: Handles the `/startmeeting` command flow and follow-up button interactions.
    - `endMeeting.ts`: Manages the logic for ending a meeting, processing data, and sending results.
    - `generateNotes.ts`, `generateSummary.ts`, `generateTodoList.ts`, `generateImage.ts`: Handle button interactions for AI-powered post-processing.
- **Embed Generation (`src/embed.ts`):**
  - Creates rich embed messages for Discord (e.g., meeting start confirmation, meeting summary).
  - Handles file attachments (chat logs, audio files, transcriptions).
- **Web Server (`src/webserver.ts`):**
  - An Express.js server.
  - Provides a `/health` check endpoint.
  - Includes Passport.js setup with `passport-discord` for OAuth, though its current usage within the bot's core flow isn't fully detailed in the provided code. Likely for future web dashboard or extended features.
- **Database Interaction (`src/db.ts`):**
  - Uses AWS SDK (`@aws-sdk/client-dynamodb`, `@aws-sdk/util-dynamodb`) to interact with DynamoDB.
- Defines functions to read/write data for `GuildSubscriptionTable`, `PaymentTransactionTable`, `AccessLogsTable`, and `RecordingTranscriptTable`.
  - The current bot logic in `repomix-output.xml` does not show active usage of these database functions in the core meeting recording/processing flow. This suggests they are for planned or auxiliary features (e.g., premium tiers, usage tracking).
- **Configuration (`src/constants.ts`, `.env`):**
  - Manages constants like sample rates, API keys, and thresholds.
  - Uses `dotenv` to load environment variables.
- **Utilities (`src/util.ts`):**
  - Helper functions for file system operations (checking existence, deleting files/directories).
- **Infrastructure (`_infra/`, `_infra_state_mgmt/`):**
  - Terraform configurations for AWS resources (ECR, ECS, VPC, S3 for state, DynamoDB for state locks).
  - Defines the deployment environment for the bot.
- **CI/CD (`.github/workflows/deploy.yml`):**
  - GitHub Actions workflow for building the Docker image, pushing to ECR, and updating the ECS service.

## 2. Key Technical Decisions & Patterns

- **State Management:** Primarily in-memory for active meetings (`meetings.ts`). This is simple but means meeting data is lost on bot restart if not persisted elsewhere (though `db.ts` suggests plans for persistence).
- **Asynchronous Operations:** Extensive use of `async/await` for handling I/O operations (Discord API, file system, OpenAI API).
- **Event-Driven:** Relies on events from `discord.js` (e.g., `interactionCreate`, `voiceStateUpdate`, `speaking`) to trigger actions.
- **Modular Design:** Code is broken down into modules based on functionality (e.g., `audio`, `transcription`, `commands`).
- **Error Handling:** Basic `try/catch` blocks are present, and `cockatiel` provides robust error handling for API calls.
- **Caching and Retries:** Uses short-lived session caches for Discord guild eligibility checks and in-memory caches for Discord channels, roles, and members to reduce API calls. Discord API calls are wrapped with `cockatiel` retries (max 3 attempts, exponential backoff) for 429, 5xx, and transient network errors. When rate limits still occur, API routes return 429 responses with retry guidance.
- **Stream Processing:** Audio data is processed using streams (`PassThrough`, `prism.opus.Decoder`, `fluent-ffmpeg` input).
- **Dependency Management:** Uses Yarn for package management.
- **TypeScript:** Provides static typing for better code quality and maintainability.
- **Dockerization (`Dockerfile`):** The application is containerized for consistent deployment.
- **Infrastructure as Code (Terraform):** AWS infrastructure is managed declaratively.
- **Graceful Shutdown:** The bot includes signal listeners (`SIGTERM`) to attempt graceful shutdown, waiting for ongoing meetings to complete.

## 3. Component Relationships & Data Flow

1.  **Meeting Start:**
    - User issues `/startmeeting`.
    - `bot.ts` routes to `handleRequestStartMeeting` (`startMeeting.ts`).
    - User selects transcription options via buttons.
    - `bot.ts` routes to `handleStartMeeting` (`startMeeting.ts`).
    - A `MeetingData` object is created and stored in `meetings.ts`.
    - Bot joins voice channel, sets up audio receivers (`audio.ts`), and starts chat collector.
    - Initial attendance is recorded.
2.  **During Meeting:**
    - `audio.ts` collects audio chunks from users, creating/updating `AudioSnippet` objects. Silence detection and max snippet length trigger processing.
    - `transcriptionService.ts` (if enabled) converts snippets to WAV and sends to OpenAI for transcription.
    - Raw audio chunks are written to a `PassThrough` stream, which `fluent-ffmpeg` consumes to create a single MP3 file.
    - Chat messages are collected into `MeetingData.chatLog`.
    - Voice state updates (join/leave) update `MeetingData.attendance` and `chatLog`.
3.  **Meeting End (Button or Auto):**
    - `bot.ts` routes to `handleEndMeetingButton` or `handleEndMeetingOther` (`endMeeting.ts`).
    - Meeting status is set to `finishing`.
    - Voice connection is closed.
    - Any remaining audio snippets are processed.
    - The main MP3 audio file is finalized by `fluent-ffmpeg` (`closeOutputFile` in `audio.ts`).
    - The MP3 is split into chunks if it's too large (`splitAudioIntoChunks` in `audio.ts`).
    - Chat log is written to a file.
    - `embed.ts` generates and sends the summary embed and file attachments.
    - If transcription is enabled:
      - `waitForFinishProcessing` ensures all snippet transcriptions are done.
      - `compileTranscriptions` assembles the full transcript.
      - Transcript is sent as a file.
      - If notes are enabled, `generateAndSendNotes` calls OpenAI via `notesService.ts`.
    - Temporary files and directories are cleaned up.
    - Meeting data is removed from the in-memory store in `meetings.ts`.

## 4. Critical Implementation Paths

- **Audio Recording and Processing:** The reliability of capturing, decoding, and encoding audio is crucial. Errors here can lead to incomplete or corrupted recordings.
- **OpenAI API Interaction:** Handling API rate limits, errors, and retries effectively is vital for transcription and AI features. The `cockatiel` and `bottleneck` setup addresses this.
- **State Management for Meetings:** Ensuring `MeetingData` is correctly updated and cleaned up is important to prevent memory leaks or incorrect behavior.
- **Asynchronous Flow Control:** Managing numerous promises and asynchronous operations correctly, especially during the meeting end process, is critical to ensure all data is processed and sent before cleanup.
- **File System Operations:** Correctly handling temporary files (creation, deletion) is important to avoid disk space issues and data leaks.
- **Graceful Shutdown Logic:** Ensuring that active meetings can complete their processing before the bot exits is important for data integrity during deployments or restarts.

## 5. Potential Bottlenecks/Areas for Improvement

- **In-Memory State:** Large numbers of concurrent meetings or very long meetings could strain memory. Persisting meeting data more robustly (e.g., using the existing `db.ts` infrastructure) would improve scalability and resilience.
- **FFmpeg Processing:** FFmpeg operations can be CPU-intensive. For a high volume of meetings, this could become a bottleneck.
- **OpenAI API Costs/Limits:** Heavy usage of transcription and GPT models can incur significant costs and hit API limits.
- **Single Point of Failure:** If the bot instance crashes, all in-progress meeting data (not yet written to files or external services) is lost.
- **File Handling:** Managing many temporary audio files could be complex; ensuring robust cleanup is essential.
- **Cache Scaling and Request Coalescing:** Current caches are per-process or per-session. Consider Redis for shared caching with namespaces for user-scoped vs global data, plus a unified cache layer that supports TTLs and in-flight request de-duplication to avoid parallel requests for the same Discord data.
- **Cache Size Limits:** In-memory and session caches should add max sizes or eviction policies to avoid unbounded growth.
- **Permissions and Timeline Tests:** Add unit tests for Discord permission resolution and timeline event building to lock in edge cases.
