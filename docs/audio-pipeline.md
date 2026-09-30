# Audio Pipeline

This document summarizes how audio flows through the bot, which files we create,
and how we recover when mixing fails.

## Audio flow overview

1. Discord voice receiver yields Opus packets for each user.
2. We decode Opus to PCM and write it to:
   - The live combined MP3 stream.
   - Per-speaker PCM tracks built at snippet boundaries.
3. At meeting end we attempt to produce a mixed MP3 from the speaker tracks.
4. If mixing fails or no usable speaker tracks exist, we fall back to the combined MP3.

## DAVE decryption during voice resume

We patch `@discordjs/voice` 0.19.2 with the existing `patch-package` postinstall.
During a voice WebSocket resume, its connection becomes `Connecting` while the
networking state is `Resuming` and retains the UDP socket and DAVE session. The
unpatched receiver only invokes DAVE decryption when the connection is `Ready`,
so encrypted media can reach the Opus decoder during this interval.

The patch permits decryption in `Connecting` as well as `Ready`, still requiring
the networking state to be `Ready` or `Resuming`. It covers both CommonJS and ESM
entry points. The synthetic regression in `test/audio/daveResume.test.js` exercises
the installed receiver and state machine with fake sockets and a stub DAVE
decryptor, then checks that plaintext reaches a real Opus decoder before, during,
and after resume. It does not test DAVE cryptography or establish the cause of
production incidents. Keep the failure-only probe until production evidence can
confirm the effect, and remove this patch when a verified upstream release fixes
the same path.

Run the focused regression with
`yarn test --runInBand --runTestsByPath test/audio/daveResume.test.js --coverage=false`.

## File types and naming

All files live under `tmp/meetings/m/<meetingId>/`.

### Live combined MP3

- Path: `recording.mp3`
- Produced continuously during the meeting by piping decoded PCM into ffmpeg.
- Used when mixing is unavailable.

### Per-speaker PCM tracks

- Path: `t/t_<userId>.pcm`
- Each track is a time aligned PCM stream for a single speaker.
- Used for meeting end mixing.

### Mixed MP3 (preferred)

- Path: `recording_mixed.mp3`
- Built at meeting end with a single ffmpeg `amix` across speaker tracks.
- Preferred output when at least one speaker track is present.

### Split chunks for uploads

- Path: `c/c_<index>.mp3`
- Created only when an output MP3 exceeds the Discord upload limit.

## Cleanup

- We delete temporary files after uploads and when the meeting finishes.
- The meeting temp directory is removed at the end of the flow.
