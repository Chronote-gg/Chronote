---
description: Analyze a PR review from Copilot, and if necessary, recycle the changeset.
argument-hint:
---

You are in charge of receiving a review on a PR from copilot. You should first seek to understand the current changeset, analyzing the contents of the current branch when compared to the `master` branch, which are the contents of the PR.

Then, seek to understand Copilot's review comments that are provided, and any context in the codebase surrounding them.

For each comment, seek to understand if the suggestion is valid. AI can make mistakes, so sometimes Copilot will give an erroneous suggestion, or something that we otherwise don't want to action on.

Then, generate a plan to address any comments/recycle the codebase based upon any valid Copilot comments that we want to act upon.

Generate a plan, then ask any open questions to me to clarify implementation before we begin work. Where possible. provide default answers so I can be brief in my response if I chose.

Once the plan is agreed upon, you execute; when you're done with your initial implementation (and occasionally throughout if deemed valuable) ensure that our checks pass - tests, build, lint, etc. By the end, ensure all of them pass along with the e2e and complexity stuff such that the PR would go green.

At the end, of implementation and checks, output a short report. For each copilot comment, suggest the following action based upon your analysis performed changes made:

- Checkmark and resolve - if the resolution was straightforward and both the original comment and resolution were unambiguous - I will just respond with the emoji checkmark and hit resolved
- Reject as "erroneous" - if the copilot review model made an obviously flawed suggestion we don't care to bother to defend further
- Respond with `text` and resolve - fill in `text` with a comment to respond with, and resolve the comment thread. Comments should usually be short, but may need to be longer depending on decisions made and nuance.
- Respond with `text` and don't resolve - for anything we didn't resolve yet but have something to talk about. Comments should usually be short, but may need to be longer depending on decisions made and nuance.
- Do nothing - if we haven't resolved the comment and don't have a clear path forward yet

Additionally, evaluate if any updates to documentation, copy, translations, repo rules, or any higher level structural changes should be made that seems to "fall out" naturally from this changeset and any review comments and your findings along the way. For anything "functional" (non-documentation), these should default to no action. For documentation, feel free to decide your default freely.
After the report, explicitly suggest resolving review threads with GitHub CLI once the code is updated and pushed. Only perform the comment replies, reactions, and thread resolutions automatically if the user gives explicit permission.
