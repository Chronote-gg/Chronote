---
title: Admin Guide
slug: /admin/setup-and-access
---

This guide covers server configuration, permissions, and operational best practices for Chronote administrators.

## Initial setup

After adding Chronote to your server ([Getting Started](/getting-started/)), configure these settings to improve meeting quality from the start.

### 1. Set server context

Server context is a description of your team, project, or organization that is included in every transcription and notes prompt. It helps the AI understand domain-specific conversations.

```
/context set-server context: Backend engineering team at Acme Corp.
We build the Rocket API, a REST service for satellite telemetry.
Key projects: Rocket v3 migration, observability rollout.
```

Keep context concise and factual. Update it when your team's focus changes.

### 2. Set channel context

If different voice channels serve different purposes, add channel-specific context:

```
/context set-channel channel: #design-reviews context: Weekly design review
meetings for the product team. Participants discuss UI mockups, user research
findings, and design system updates.
```

Channel context is combined with server context, so avoid repeating information.

### 3. Build a dictionary

Add terms that the AI might misspell or misunderstand:

```
/dictionary add term: Kubernetes
/dictionary add term: LGTM definition: Looks Good To Me, a code review approval
/dictionary add term: Jira definition: Project management tool used for sprint tracking
/dictionary add term: Priya Patel definition: VP of Engineering
```

Terms are injected into the transcription prompt to improve spelling accuracy. Definitions are included in the notes prompt to give the AI more context.

### 4. Configure auto-recording

Set up auto-recording so meetings are captured without anyone running `/startmeeting`:

```
/autorecord enable voice-channel: #standup-voice text-channel: #standup-notes
  tags: standup, daily
/autorecord enable voice-channel: #all-hands text-channel: #meeting-notes
  tags: all-hands
```

Or enable it for every voice channel:

```
/autorecord enable-all text-channel: #meeting-notes
```

Auto-record starts when any user joins a configured voice channel. It ends when the channel empties. If the recording produces too little content, it is cancelled automatically instead of generating empty notes.

## Permissions model

### Bot permissions

Chronote needs these Discord permissions:

| Permission    | Scope          | Purpose                                    |
| ------------- | -------------- | ------------------------------------------ |
| View Channel  | Text channels  | Read messages and post meeting notes       |
| Send Messages | Text channels  | Post embeds, notes, and status updates     |
| Connect       | Voice channels | Join voice channels to record              |
| Speak         | Voice channels | Required by Discord for voice bot presence |

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
| `/billing`      | Manage Server       |                                 |
| `/onboard`      | Manage Server       | Can be disabled server-wide     |

### Notes correction permissions

- **Manual meetings**: Only the meeting creator can accept corrections.
- **Auto-recorded meetings**: Anyone with Manage Channels can accept corrections.
- Both the original requester and authorized approvers can reject corrections.

### Web portal access

The web portal uses Discord OAuth. Users see meetings from channels they have access to in Discord. Attendees of a meeting can always view it regardless of current channel permissions.

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

Use `/billing` to manage your server's subscription. This opens the Stripe billing portal where you can:

- View your current plan and usage.
- Upgrade or downgrade your plan.
- Update payment methods.
- View invoice history.

Plan tiers affect weekly meeting minutes, the number of meetings searchable by `/ask`, and access to features like image generation.
