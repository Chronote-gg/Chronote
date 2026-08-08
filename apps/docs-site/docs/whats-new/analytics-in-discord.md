---
title: Analytics now cover what you do in Discord
slug: /whats-new/analytics-in-discord
---

Chronote already used PostHog for product analytics on the website and web portal. It now also records what you do with Chronote inside Discord. Our [privacy policy](/legal/privacy) says we will tell you before a change like this takes effect, so this is that notice.

## What changed

- Actions you take through Chronote in Discord are recorded: starting and ending a meeting, changing a server setting, adding a dictionary term, asking a question, and similar.
- These record that the action happened and its shape, for example how long a meeting ran or how many people attended. They never carry the content: not notes, not transcripts, not the text of your questions, your dictionary terms, or your context prompts.
- While you are signed in to the portal, analytics are tied to your Discord account instead of an anonymous browser identifier, so activity on the website and in Discord is understood as one person rather than two strangers. Signing out unlinks the browser again.
- Your IP address is now discarded on arrival, so we no longer derive an approximate location from it.
- Session replay is enabled for the web portal. Browser console output is not captured.

## Turning it off

Do Not Track still works for the website and the web portal, and switching it on means we send nothing to PostHog from your browser.

It cannot cover the Discord side. Do Not Track is a browser signal and the bot never sees your browser, so actions you take through Chronote in Discord are recorded whether or not you have it enabled, including if you have never opened the portal. To opt out of that, email [basic@basicbit.net](mailto:basic@basicbit.net) and we will exclude your account. There is no self-service switch for it yet.
