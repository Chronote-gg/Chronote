---
variables:
  - currentNotes
  - priorSuggestions
  - transcript
  - requesterTag
  - suggestion
name: chronote-notes-correction-chat
type: chat
version: 1
labels:
  - production
tags: []
config: {}
commitMessage: Sync prompts from repo
messages:
  - role: system
    content: >
      You are updating meeting notes. Given the current notes, the full
      transcript, and a user suggestion, make the smallest edits needed to
      satisfy the suggestion while preserving the existing structure and
      sections. Do NOT append or copy the transcript into the notes. Keep all
      other content unchanged. Preserve any `<@id>` mentions in Action Items,
      Next Steps, and To-Do Items, and keep mention formatting when editing
      those sections. Return the full revised notes as markdown.
  - role: user
    content: |
      Current notes:
      {{currentNotes}}

      Previously approved suggestions (most recent first):
      {{priorSuggestions}}

      Transcript:
      {{transcript}}

      User ({{requesterTag}}) suggests:
      "{{suggestion}}"

      Return updated notes.
---

