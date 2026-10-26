---
title: What's New
slug: /whats-new
---

Notable product changes for Chronote users. For the full changelog, see the [GitHub releases](https://github.com/Chronote-gg/Chronote/releases).

## 2026

### Get your first meeting notes (October 19)

- The installer DM and an empty server library explain how to join voice, run `/startmeeting` and end the recording. **Open portal** goes directly to that server's library.
- The first-meeting guide links to the permitted recording or saved meeting and distinguishes preparing notes, missing delivery evidence and delivery problems. Interrupted recordings keep their warnings.
- Context and auto-recording remain optional. `/onboard` is retired; old wizard controls safely link to the portal. See [Getting started](/getting-started/).

### Choose where recording controls and notes appear (October 16)

- Use `notes-channel` on `/startmeeting` for a one-meeting text destination. Otherwise, manual starts use the voice-channel override, then the server default, then the command channel if nothing is configured. The private **View recording** link opens the published recording message.
- Server settings show inherited destinations and voice-channel overrides. Configure or reset a destination with auto-recording off; changing routing never enables recording. Explicit overrides survive server-default changes, even if they previously matched the default.
- An unavailable destination blocks a start without fallback. Controls, processing updates and final notes keep the destination selected at start. See [Choose where controls and notes appear](/admin/setup-and-access/#4-choose-where-controls-and-notes-appear).

### Notes delivery timing notice (October 16)

- We are adding content-free measurements of the wait from recording stop until Discord acknowledges the first notes message and all initial notes messages. Partial delivery and missing timing remain separate from complete delivery.
- These records use the existing server and acting account identities, with no additional identifiers, meeting content or per-server financial amounts. They measure delivery acknowledgement, not readership, and do not promise a response time. See [Measuring notes delivery wait](/whats-new/meeting-processing-times) and the updated [Privacy Policy](/legal/privacy).

### Time to resolve a failed renewal

- When renewal payment fails for an existing paid Basic or Pro subscription, the server keeps its previous paid plan for 48 hours from invoice finalization, including scheduled plan changes. Billing shows the local deadline and lets the original payer retry the same invoice, update their payment method, or cancel the unpaid renewal.
- Cancellation preserves the remaining grace time. A new purchase becomes available after cleanup. Without payment, the server moves to Free at the original deadline, with any valid complimentary access preserved. See [Billing or plan issues](/troubleshooting/common-issues/#a-renewal-payment-failed).

### Plan-change reviews and independent Basic offers

- Where plan changes are available in Billing, the original payer reviews an exact total before payment. Pro upgrades and monthly to annual changes take effect after payment; downgrades and annual to monthly changes within the same plan wait until renewal.
- Each server can use the monthly and annual Basic introductory offers once, in either order. Leaving an offer ends it, and future changes do not restart it. Discounts on other servers do not block plan changes. See [Server plans](/features/#basic-introductory-pricing).

### Recording continuity during service handoffs

- A ready replacement can accept new recordings while the previous runtime finishes its existing work. A start caught at the handoff can ask you to retry; active recordings keep their original owner.
- Interrupted results retain their saved-coverage warnings. Unconfirmed recording or delivery state stays unavailable or needs review instead of appearing complete. See [Discord meeting notes](/discord-meeting-notes/#updates-and-interrupted-recordings).

### Clearer interrupted recording outcomes

- Chronote can recover saved conversation after an interrupted recording while respecting the original transcription and notes settings. It does not rejoin the voice channel or fill missing conversation with invented content.
- Partial notes retain an **Interrupted** status and a coverage warning across Discord, the library, shared meetings, copies, downloads, Remote MCP, and Notion exports. Editing or correcting the notes keeps the warning.
- Live pages distinguish known interruption from unavailable recording status. The library shows recovery progress and outcomes that need review. Unknown recording end times remain unknown. See [Meeting lifecycle](/core-concepts/meeting-lifecycle#interrupted-recordings).

### Renewal status and lifecycle analytics notice (October 14)

- Billing separates the current renewal date and rate from payment history. For supported subscriptions, the original payer can turn renewal back on at the displayed terms. A pending result stays visible while Chronote checks it. Subscriptions that need review link to Stripe; a subscription that has ended can be purchased again.
- We are adding content-free renewal-off views, restoration clicks and outcomes, subscription endings, same-invoice payment recovery and settled-renewal categories. Turning renewal off is separate from the end of paid service. A later settled renewal is separate from a new purchase or cash payment.
- These events use server identity and the acting account when known, fixed categories and a bounded interval until a scheduled end. They exclude provider IDs, prices, payment amounts, cancellation text and meeting content. Browser Do Not Track also suppresses analytics about an existing subscription’s restoration request and associated result, without changing its original purchase attribution or later automatic billing opt-out. See the [Privacy Policy](/legal/privacy/).

### Basic introductory terms and analytics notice (October 12)

- When Basic introductory pricing is available for an eligible server's first paid subscription, monthly billing is $6/month for three months, then $10/month. Annual billing is $60 for the first year, then $100/year. The offer applies automatically when shown, cannot be combined with another promotion and does not change Pro pricing. See [Server plans](/features/#basic-introductory-pricing) for eligibility and billing management.
- We are adding fixed introductory-offer categories to purchase events and recording when complete offer terms are visible in the browser. Each displayed offer counts once per page visit and server choice. These counts do not establish unique people, whether someone read the terms or an offer caused a purchase.
- Paid invoices are categorized as introductory discount, regular price, other discount or unknown from billing evidence. Original offer categories and entered-code presence remain separate from actual invoice discounts. The new categories contain no additional identifiers, prices, provider IDs, raw codes or meeting content. Browser Do Not Track and new-subscription billing opt-outs remain supported. See the [Privacy Policy](/legal/privacy/).

### Recording limits and plan links (October 12)

- Recording-limit messages explain when recording can resume and link to the plan options for that server. Servers with existing billing get **Manage plan**. No plan removes the two-hour maximum per meeting.
- Auto-record refusals share a 15-minute notice cooldown. Explicit recording requests still receive a reply. When a recording reaches both limits, Chronote combines the duration and weekly explanation into one notice.
- We are adding content-free recording-limit encounters, allowance and used minutes, notice delivery outcomes and billing-page entries to product analytics. Fixed limit categories can follow a purchase through sign-in and checkout. We compare later purchases for the same server, including when the organizer and purchaser differ. This measures association, not proof that a notice caused a purchase.
- Browser Do Not Track continues to suppress browser and synchronous checkout analytics. It also suppresses later billing outcomes for new subscriptions started with it. It cannot reach the bot. See the updated [Privacy Policy](/legal/privacy/).

### A clearer upgrade and first-recording flow

- Compare Free, Basic and Pro on the upgrade page. **Continue with Basic** or **Continue with Pro** takes the chosen plan directly to billing confirmation for the named server.
- Monthly and annual prices show the selected billing period. Optional promotion codes are checked at checkout.
- The first-recording guide starts with **Open Discord**, includes how to end the meeting and shows an example of the notes. Auto-record setup and the meeting library remain available below the first steps.

### Recording and purchase analytics notice (October 6)

- We are adding content-free delivery and purchase outcomes to understand first use, buying difficulties and repeat use across Discord and the website. A delivered upgrade offer, a checkout and confirmed paid server access are recorded separately.
- These events use server/account identifiers, approved source categories, plans, billing periods, fixed blocking reasons and outcome flags. They exclude meeting content, channel/message/meeting and payment-provider identifiers, raw errors and promotion-code values. Promotion values in analytics page URLs are redacted.
- Browser Do Not Track suppresses website and synchronous checkout analytics. New subscriptions started with it also suppress later billing-outcome events; existing subscriptions do not inherit the setting retroactively. It cannot reach the bot; email us to request account exclusion. See the updated [Privacy Policy](/legal/privacy/).

### Installation source reporting

- Add to Discord links on the Chronote website now preserve a limited acquisition source through Discord authorization, so we can understand which public pages and referrals lead to a real server installation.
- The record contains source, medium, campaign, a coarse landing-page category, an approved referring-domain category, and button location. It does not contain the full referring URL or query, a browser or session identifier, or a share-link id.
- Adding Chronote does not sign you into the portal or request your email or server list. A later installation can record its new installer and source. Chronote attempts to clear the installer record when it observes the bot being removed. If that event is missed while Chronote is offline, the old record can remain until a later installation replaces it; it no longer grants installer access after the bot rejoins.
- Do Not Track disables this attribution as well as our other website analytics. Installs started directly in Discord or another directory remain unattributed.

### Teach Chronote in natural language

- Members with **Manage Server** can describe names, acronyms, and specialized vocabulary in Server Settings instead of formatting each term first.
- Chronote uses AI to propose exact spellings and concise descriptions, but each entry remains an editable draft until the member reviews the batch and approves it.
- After applying a notes correction in the web portal, a member with **Manage Server** can optionally review proposals based on a short-lived excerpt limited to 2,000 characters of the notes diff and 2,000 characters from matching transcript segments. Applying the correction itself never teaches the dictionary.
- PostHog usage analytics contain counts and categories, never the instruction, terms, notes, or transcript content. Separate engineering traces can include content as described in the updated [privacy policy](/legal/privacy).

### Server controls for transcript and recording access

- Server admins with **Manage Server** can independently block new transcript and audio recording access while keeping meeting summaries and notes visible.
- The controls apply to existing and future server meetings, including transcript sharing, live transcript access, portal exports, and Remote MCP.
- These settings control access only. Chronote still records, transcribes, summarizes, and stores meeting artifacts unless the meeting is deleted.

### Chronote Desktop is open to every account

- Chronote Desktop no longer requires desktop access to be enabled on your account. Any Chronote account can sign in and upload a recording.
- Desktop sign-in now asks you to approve the connection in your browser and lists what the app will be able to do. Approve it only when you started the sign-in yourself.
- It remains a Windows-only beta, and beta builds may be unsigned.

### Analytics now cover what you do in Discord

- Product analytics now record actions taken through Chronote in Discord, not only on the website and web portal. They capture that an action happened and its shape, never its content.
- While you are signed in, analytics are tied to your Discord account rather than an anonymous browser identifier. Signing out unlinks the browser again.
- IP addresses are discarded on arrival, so we no longer derive an approximate location from them.
- Do Not Track still covers the website and portal, but cannot cover Discord, because the bot never sees your browser. Email us to opt out of that side.
- See [Analytics now cover what you do in Discord](/whats-new/analytics-in-discord) and the updated [privacy policy](/legal/privacy).

### Role mentions in meeting notes

- Notes now mention server roles when work is assigned to a group rather than to one person.
- Member and role mentions can appear anywhere in the notes.
- Role mentions resolve to readable role names in the web portal, shared links, Notion exports, and Markdown exports.
- Mentions in notes stay display-only, so posting notes still does not ping anyone.

### Personal media uploads

- Upload existing audio or video files from the web portal to create personal Chronote meetings.
- Uploaded media is transcribed, summarized, and saved in My Meetings under your personal workspace.
- Optional titles and tags can be added before processing starts.
- Personal Notion automation can export uploaded and personal meetings to your Notion destination after processing completes.
- Personal Notion automation is managed from Personal Settings, keeping My Meetings focused on finding and opening meetings.
- The web portal sidebar now separates Personal flows from Server flows so account-owned meetings, uploads, and integrations are visually distinct from server Library, Ask, Billing, and Server Settings.

### Remote MCP live controls

- AI assistants can now start Chronote recordings from your current Discord voice channel through Remote MCP.
- Remote MCP can stop active meetings, check live meeting status, and fetch available live transcript events using existing meeting/transcript scopes plus separate start/stop OAuth consent scopes.
- Meeting control requests are queued so Chronote can route work to the bot runtime that owns the live recording.

### Transcription reliability guardrails

- Low-confidence transcription retries now reject punctuation-only outputs before they can replace a real transcript.
- Finalized meeting audio gets an extra verification pass to clean up repeated short hallucinations before notes are generated.

### Public documentation launch

- Product documentation is now available at [docs.chronote.gg](https://docs.chronote.gg).
- Docs cover getting started, features, admin setup, and troubleshooting.
- Documentation updates ship alongside product changes.

### Meeting sharing

- Share meeting notes via a public link from the web portal.
- Recipients can view the meeting summary, notes, and transcript without joining your server.

### Notes correction flow

- Suggest corrections to meeting notes directly from Discord or the web portal.
- Corrections use the original transcript as ground truth, so the AI cannot add content that was not discussed.
- Versioned notes track every edit with author attribution.

### Text-to-speech

- Use `/tts enable` to have your chat messages spoken aloud in the meeting voice channel.
- Choose from multiple voice options with `/tts voice`.
- Set your spoken name, speaker prefix mode, and volume from `/tts`.
- Use `/say` for one-off messages without enabling ongoing TTS.
- Enable TTS-only channel startup so Chronote can speak chat messages without recording, transcription, notes, chat logs, or meeting artifacts.
- TTS-only sessions now clean themselves up after inactivity, and servers may see a monthly chat-to-speech cap notice when plan limits are reached.
- Use `/leave` to make Chronote leave a TTS-only session immediately, or require explicit confirmation before ending a recorded meeting.

### Ask past meetings

- Use `/ask` to query your meeting history with natural-language questions.
- Answers include citations linking to specific meetings.
- Filter by tags or scope to a single channel.
