# Deploy Guard Smoke Test

Use this runbook to verify that production deploys wait while a meeting lease is
active.

## Purpose

The production deploy workflow checks `ActiveMeetingTable` before replacing the
ECS task. If a meeting is recording, the workflow should poll until the active
lease expires or the meeting ends.

## Procedure

1. Start a meeting in a test Discord voice channel.
2. Confirm the meeting appears active in logs or DynamoDB.
3. Merge a harmless pull request to `master`.
4. Open the deploy workflow run triggered by the merge.
5. Watch the `Wait for active meetings to finish` step.
6. End the meeting.
7. Confirm the deploy continues after the active lease clears.

## Expected Result

The deploy should not update the ECS service while the active meeting lease is
present. After the meeting ends, the guard should report no active meeting
leases and continue the deployment.

## Failure Signals

The guard is not working correctly if the workflow updates the ECS service while
the meeting is still active, or if it waits until timeout after the meeting has
ended and the lease has expired.
