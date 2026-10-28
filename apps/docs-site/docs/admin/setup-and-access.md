---
title: Admin Guide
slug: /admin/setup-and-access
---

This guide covers server configuration, permissions, and operational best practices for Chronote administrators.

## Initial setup

After adding Chronote to your server ([Getting Started](/getting-started/)), configure these settings to improve meeting quality from the start.

### 1. Set server context

Server context is a description of your team, project, or organization that is included in every transcription and notes prompt. It helps the AI understand domain-specific conversations.

```text
/context set-server context: Backend engineering team at Acme Corp.
We build the Rocket API, a REST service for satellite telemetry.
Key projects: Rocket v3 migration, observability rollout.
```

Keep context concise and factual. Update it when your team's focus changes.

### 2. Set channel context

If different voice channels serve different purposes, add channel-specific context:

```text
/context set-channel channel: #design-reviews context: Weekly design review
meetings for the product team. Participants discuss UI mockups, user research
findings, and design system updates.
```

Channel context is combined with server context, so avoid repeating information.

### 3. Build a dictionary

In **Server Settings**, choose **Teach Chronote** and describe the exact names, acronyms, or jargon it should recognize. You can write naturally, for example: "It wrote John Smith, but his name is Jon Smythe. He works with us on Apollo." Chronote proposes structured entries for you to edit and approve. It does not save a proposal automatically.

You can also manage one exact term at a time from Discord:

```text
/dictionary add term: Kubernetes
/dictionary add term: LGTM definition: Looks Good To Me, a code review approval
/dictionary add term: Jira definition: Project management tool used for sprint tracking
/dictionary add term: Priya Patel definition: VP of Engineering
```

Terms are injected into the transcription prompt to help improve spelling accuracy. Definitions are included in the notes prompt to give the AI more context.

Only members with **Manage Server** can use the portal teaching flow. `/dictionary` retains its **Manage Channels** permission for existing Discord workflows. Both paths update the same server dictionary; the portal flow adds AI proposals and a separate human approval step.

### 4. Choose where controls and notes appear

In the portal's **Server settings**, set **Default notes channel** and save. Members with **Manage Server** can edit these saved settings. For a voice-channel exception, choose **Edit** beside that voice channel and select its **Notes channel**. The row shows the effective destination and whether it comes from the server default or a voice-channel override.

The notes picker remains available with auto-recording off. Choosing a notes channel never enables recording. **Reset to server default** removes a voice-channel override. Inherited channels follow later server-default changes; an explicit override stays put even when it currently equals the default.

For manual starts, Chronote uses the one-meeting `notes-channel` choice first, then the voice-channel override, then the server default. With none configured, it uses the text channel where the command was run. Auto-recording has no invocation-channel fallback and requires a configured destination.

The destination must be accessible to the starter, and Chronote must have permission to post there. A deleted or inaccessible destination blocks the start without falling back to another channel. Changing settings during a recording affects the next meeting. Its controls, processing updates and final notes stay in the destination selected at start.

### 5. Configure auto-recording

Set up auto-recording so meetings are captured without anyone running `/startmeeting`:

```text
/autorecord enable voice-channel: #standup-voice text-channel: #standup-notes
  tags: standup, daily
/autorecord enable voice-channel: #all-hands text-channel: #meeting-notes
  tags: all-hands
```

Or enable it for every voice channel:

```text
/autorecord enable-all text-channel: #meeting-notes
```

Auto-record starts when any user joins a configured voice channel. It ends when the channel empties. If the recording produces too little content, it is cancelled automatically instead of generating empty notes.

### 6. Choose which meeting artifacts viewers can access

In **Server Settings** -> **Meetings**, server admins (members with **Manage Server**) can control two independent settings:

- **Transcript access** controls completed transcripts, transcript timelines, shared meeting transcripts, live transcript links, and transcript retrieval through Remote MCP.
- **Audio recording access** controls the current viewer-facing audio delivery surfaces: recording playback and audio URLs in portal exports.

Both settings apply server-wide to past and future server meetings. Turning one off blocks future retrieval of that artifact, but leaves the meeting summary and notes available. It cannot recall downloaded copies, an audio URL remains usable for up to 15 minutes after it was issued, and an already-open live transcript stream stays connected until the meeting ends or the viewer disconnects. The settings do not stop recording, transcription, summary generation, or storage, and a server admin can turn access back on later.

Chronote's automated notes generation and correction workflows can still use the stored transcript. The correction workflow does not return the transcript as an artifact, but its proposed notes change and diff can include details or wording from the transcript.

These controls do not apply to personal meetings and uploads, which remain controlled by the account owner. To request removal of stored audio or transcript data instead of limiting access, follow the meeting deletion process in the [privacy policy](/legal/privacy#how-long-we-keep-things).

## Permissions model

### Bot permissions

Chronote needs these Discord permissions:

| Permission           | Scope          | Purpose                                    |
| -------------------- | -------------- | ------------------------------------------ |
| View Channel         | Text channels  | Access the notes channel                   |
| Send Messages        | Text channels  | Post embeds, notes, and status updates     |
| Read Message History | Text channels  | Update meeting status and summary messages |
| Connect              | Voice channels | Join voice channels to record              |
| Speak                | Voice channels | Required by Discord for voice bot presence |

### Command permissions

| Command         | Required permission | Notes                           |
| --------------- | ------------------- | ------------------------------- |
| `/startmeeting` | None                | User must be in a voice channel |
| `/autorecord`   | Manage Channels     |                                 |
| `/context`      | Manage Channels     |                                 |
| `/dictionary`   | Manage Channels     |                                 |
| `/ask`          | None                |                                 |
| `/tts`          | None                | Per-user preference             |
| `/say`          | None                | Must be in an active meeting    |
| `/billing`      | None                | Shows subscription status       |

The portal's **Teach Chronote** workflow requires **Manage Server**. It can propose terms from natural-language guidance and, when explicitly opened after a web notes correction, from up to 2,000 characters of the notes diff plus up to 2,000 characters from lexically matching transcript segments. Every entry requires human approval.

### Notes correction permissions

- **Manual meetings**: Only the meeting creator can accept corrections.
- **Auto-recorded meetings**: Anyone with Manage Channels can accept corrections.
- Both the original requester and authorized approvers can reject corrections.

### Web portal access

The web portal uses Discord OAuth. Users land on **My Meetings** first, then can open direct meeting links or use **View servers** to browse Server Library for one server at a time. Users see meetings from channels they have access to in Discord. Attendees of a meeting can always view it regardless of current channel permissions.

Server artifact settings are checked after meeting access. A user may be allowed to open a meeting while its transcript, audio recording, or both are unavailable.

## Operational recommendations

### Channel organization

Use dedicated voice and text channel pairs for different meeting types. This keeps notes organized, makes auto-record rules cleaner, and improves the AI's context awareness through meeting history.

For example:

- `#standup-voice` + `#standup-notes`
- `#design-review-voice` + `#design-review-notes`
- `#all-hands-voice` + `#all-hands-notes`

### Context maintenance

Review and update context when:

- Your team's focus or projects change.
- New team members join (add their names to the dictionary).
- You notice the AI consistently misunderstanding a topic.

### Tag strategy

Tags help organize meeting history and power the `/ask` command's filtering. Establish a consistent tagging convention:

- Use lowercase, short tags: `standup`, `retro`, `design-review`, `1-on-1`.
- Set default tags on auto-record rules so they are applied automatically.
- Edit tags after the meeting if you forgot to set them.

### Meeting minutes management

Each plan tier includes a weekly meeting minutes allowance. Monitor usage by watching for warning messages that appear when you approach the limit. Chronote warns when the server is near its cap and blocks new meetings when the limit is reached.

## Billing

Open your server's Billing page in the portal to review its plan and usage. The
original payer must also have Manage Server permission to manage an existing
Stripe subscription. Other server managers cannot open the payer's Stripe account.

When your Billing page offers plan changes, choose a plan and review its exact
total before confirming. Upgrades to Pro take effect after payment. Switching
from monthly to annual starts a full new year, with credit for unused paid time.
A failed or incomplete payment leaves your current plan active. Use **Continue
payment** to resume the same change, or cancel it before choosing again.

Downgrades to Basic or Free and a change from annual to monthly within the same plan take effect at
your next renewal. You keep the plan you already paid for until that date.
Cancel a scheduled change before choosing a different plan.

Only one initial checkout can be in progress for a server. Choosing the same
plan again resumes it. Choosing a different plan, billing period or discount, or
starting a purchase as a different server manager, ends the earlier checkout and
opens a new one. If the earlier checkout was already paid, billing shows that
subscription instead. A checkout that was closed without paying no longer blocks
the billing page once it expires. If billing says the purchase needs review,
contact support before trying to purchase again.

Use billing management to update payment methods or view invoice history. If a
subscription has an unpaid invoice or a payment is still being settled,
resolve that payment before changing plans. Contact support if the original payer
cannot access billing or the server's billing information needs repair.

Plan tiers affect weekly meeting minutes, the number of meetings searchable by `/ask`, and access to features like image generation.

Chronote may also grant a server a complimentary Basic or Pro plan. Comped servers see the granted plan and any public note on the billing page, but they do not see Stripe billing management until a paid subscription exists. Server admins can still start paying or upgrade from the billing page when they are ready.
