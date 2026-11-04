# State address migration.
#
# aws_security_group.api_alb_sg briefly carried a count and has been returned to
# a singleton, so any workspace that applied the counted version holds it at
# [0]. Terraform migrates a singleton to [0] on its own, but not the reverse, and
# without this it would destroy and recreate the group. The destroy would then
# fail with a DependencyViolation, because the ECS service security group holds
# an inline ingress rule referencing it.
#
# A from address absent from state is skipped, so this is a no-op for any
# workspace that never applied the counted version.
#
# Can be deleted once every workspace has applied once past this change.

moved {
  from = aws_security_group.api_alb_sg[0]
  to   = aws_security_group.api_alb_sg
}

# aws_cloudwatch_metric_alarm.alb_unhealthy_hosts moved from a count to a
# for_each over both halves of the blue/green target group pair, so the serving
# group is always covered. The api_tg instance keeps the original alarm name, so
# this migrates the live alarm's state address instead of destroying it and
# recreating it under the same name.

moved {
  from = aws_cloudwatch_metric_alarm.alb_unhealthy_hosts[0]
  to   = aws_cloudwatch_metric_alarm.alb_unhealthy_hosts["api_tg"]
}
