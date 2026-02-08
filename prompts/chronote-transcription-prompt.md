---
variables:
  - serverName
  - channelName
  - serverDescriptionLine
  - attendeesLine
  - botNamesLine
  - dictionaryBlock
  - meetingContextLine
name: chronote-transcription-prompt
type: text
version: 1
labels:
  - production
tags: []
config: {}
commitMessage: Sync prompts from repo
---

<glossary>(do not include in transcript):
Server Name: {{serverName}}
Channel: {{channelName}}
{{serverDescriptionLine}}
{{attendeesLine}}
{{botNamesLine}}
{{dictionaryBlock}}
{{meetingContextLine}}
Transcript instruction: Do not include any glossary text in the transcript.
</glossary>
