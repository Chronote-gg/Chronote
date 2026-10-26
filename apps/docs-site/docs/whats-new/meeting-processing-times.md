---
title: Measuring notes delivery wait
slug: /whats-new/meeting-processing-times
---

October 16, 2026

We are adding product analytics to measure the wait from recording stop to notes delivery in Discord. This notice and the updated [Privacy Policy](/legal/privacy) must be published before the new measurements take effect.

## What we measure

- Elapsed milliseconds until Discord acknowledges the first notes message and all initial notes messages. A summary message does not count as notes.
- Whether timing is measured, limited to the first message, unavailable or inapplicable because notes were disabled or the recording was cancelled.
- Whether the first observed notes acknowledgement came from live processing or recovery, when known. Recovery keeps the original recording stop when it is known. Missing stop times stay unknown.

The records use the existing server and acting Discord account identities. They add no meeting, channel, message, provider or trace identifier, meeting content or per-server financial amounts.

These measurements do not show whether anyone saw or read the notes, promise a response time or change how Chronote generates notes. Recording duration remains a separate measurement. Later notes corrections do not restart the delivery clock.

## Analytics choices

Browser Do Not Track applies to the website and portal. The Discord bot cannot see that browser setting. To opt out of account-linked Discord analytics, email [basic@basicbit.net](mailto:basic@basicbit.net). See the [Privacy Policy](/legal/privacy#analytics) for details.
