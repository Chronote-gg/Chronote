---
title: Troubleshooting
slug: /troubleshooting/common-issues
---

Use this page to diagnose and fix common Chronote issues. Each section describes the symptom, likely causes, and steps to resolve.

## Chronote does not join the voice channel

**Symptoms**: You run `/startmeeting` but the bot does not appear in voice, or you get an error message.

**Causes and fixes**:

1. **Missing permissions.** Chronote needs **Connect** and **Speak** permissions in the voice channel. Check the channel's permission overrides and make sure the Chronote bot role is not denied these permissions.
2. **Another meeting is active.** Only one meeting can run per server at a time. End the current meeting first.
3. **Weekly minutes exhausted.** Your plan's weekly meeting minutes are used up. Wait for the next billing cycle or upgrade your plan.
4. **You are not in a voice channel.** You must be in the voice channel you want to record before running `/startmeeting`.

## Auto-record does not start

**Symptoms**: Someone joins a voice channel with auto-record enabled, but Chronote does not begin recording.

**Causes and fixes**:

1. **Another meeting is active.** Auto-record waits for the current meeting to finish.
2. **Auto-record is suppressed.** After a meeting is explicitly ended, auto-record is suppressed for that channel until it fully empties. Make sure everyone leaves the channel, then rejoin.
3. **Missing bot permissions.** The bot needs Connect and Speak in the voice channel, and View Channel and Send Messages in the configured text channel.
4. **Auto-record is not configured for this channel.** Run `/autorecord list` to check the current rules.
5. **Weekly minutes exhausted.** Same as above.

## Notes quality is poor

**Symptoms**: Notes miss key points, misspell names, or include inaccurate information.

**Causes and fixes**:

1. **Missing dictionary terms.** Add frequently used names, acronyms, and jargon with `/dictionary add`. This is the single most effective way to improve transcription accuracy.
2. **No context set.** Run `/context set-server` and `/context set-channel` to give the AI background on your team and meeting purpose.
3. **Poor audio quality.** Ask participants to use headsets, reduce background noise, and speak clearly. Very quiet audio may be filtered by Chronote's noise gate before it reaches transcription.
4. **Low speaking volume.** The noise gate suppresses audio below a threshold. Participants who are very quiet may have their speech skipped.
5. **Overlapping speakers.** The transcription model handles overlapping speech with limited accuracy. Encouraging turn-taking improves results.

**After improving settings**, use the **Suggest correction** button to fix notes on past meetings. Future meetings will benefit from the updated dictionary and context.

## Transcription shows "[Transcription failed]"

**Symptoms**: Parts of the transcript contain "[Transcription failed]" instead of text.

**Causes**: This happens when the transcription API returns an error for a specific audio segment. Common reasons include network issues, API rate limits, or corrupted audio data.

**What to do**: This is usually transient. If it happens consistently, check that participants have stable connections and functioning microphones. The rest of the transcript and notes are generated from the segments that succeeded.

## Notes correction was rejected with "version conflict"

**Symptoms**: You accept a correction, but it fails with a message about a version conflict.

**Cause**: Someone else updated the notes between when you generated the correction and when you accepted it.

**Fix**: Click **Suggest correction** again to generate a new correction based on the latest version.

## Bot commands are not showing up

**Symptoms**: Slash commands like `/startmeeting` do not appear in the Discord command picker.

**Causes and fixes**:

1. **Bot was recently added.** Command registration can take up to an hour to propagate globally. Wait and try again.
2. **Missing bot scope.** The bot invitation must include the `applications.commands` scope. Re-invite the bot if this scope was missing.
3. **Channel permissions.** Discord hides slash commands in channels where the bot cannot send messages. Check that Chronote has View Channel and Send Messages in the channel you are using.

## Meeting notes are not posted

**Symptoms**: The meeting ends and the embed shows "processing", but notes never appear.

**Causes and fixes**:

1. **Still processing.** Long meetings (over 30 minutes) can take several minutes to process. Wait for the processing indicator to clear.
2. **Missing text channel permissions.** The bot needs Send Messages permission in the text channel. If permissions were changed during the meeting, the bot may not be able to post results.
3. **Meeting was cancelled.** For auto-recorded meetings with too little content, the meeting is cancelled instead of generating notes. Look for an "Auto-Recording Cancelled" embed.

## Web portal shows no meetings

**Symptoms**: The portal loads but shows an empty meeting list.

**Causes and fixes**:

1. **Wrong server selected.** The portal scopes to a specific server. Check the server selector.
2. **Channel permissions.** The portal respects Discord channel permissions. You only see meetings from channels you have access to.
3. **No meetings recorded yet.** Meetings appear after at least one meeting has been completed successfully.

## Billing or plan issues

**Symptoms**: Features are unavailable or you see upgrade prompts.

**Fixes**:

1. Run `/billing` to check your current plan status.
2. Verify the payment method is valid in the Stripe portal.
3. Some features (image generation, extended `/ask` history) require specific plan tiers.
