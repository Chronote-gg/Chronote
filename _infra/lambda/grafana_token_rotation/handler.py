"""Rotate the AWS Managed Grafana service account token.

Creates a new token, stores it in Secrets Manager, then deletes the old one.
The two-phase approach (create-then-delete) avoids any window where no valid
token exists.
"""

import json
import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

WORKSPACE_ID = os.environ["GRAFANA_WORKSPACE_ID"]
SERVICE_ACCOUNT_ID = os.environ["GRAFANA_SERVICE_ACCOUNT_ID"]
SECRET_ARN = os.environ["GRAFANA_TOKEN_SECRET_ARN"]
TOKEN_TTL_SECONDS = int(
    os.environ.get("GRAFANA_TOKEN_TTL_SECONDS", "2592000")
)  # default 30 days
REGION = os.environ.get("AWS_REGION", "us-east-1")

# Module-level clients are reused across warm Lambda invocations
grafana_client = boto3.client("grafana", region_name=REGION)
secretsmanager_client = boto3.client("secretsmanager", region_name=REGION)


def handler(event, context):
    grafana = grafana_client
    secretsmanager = secretsmanager_client

    # 1. Read current secret to find the old token ID (if any)
    old_token_id = None
    try:
        current = secretsmanager.get_secret_value(SecretId=SECRET_ARN)
        secret_data = json.loads(current["SecretString"])
        old_token_id = secret_data.get("tokenId")
        logger.info("Found existing token ID: %s", old_token_id)
    except secretsmanager.exceptions.ResourceNotFoundException:
        logger.info("No existing secret value; first rotation")
    except (json.JSONDecodeError, KeyError):
        logger.warning("Could not parse existing secret; will create fresh token")

    # 2. Create a new token
    try:
        response = grafana.create_workspace_service_account_token(
            workspaceId=WORKSPACE_ID,
            serviceAccountId=SERVICE_ACCOUNT_ID,
            name=f"auto-rotated-{context.aws_request_id[:8]}",
            secondsToLive=TOKEN_TTL_SECONDS,
        )
    except ClientError as exc:
        logger.error("Failed to create Grafana token: %s", exc)
        raise

    new_token_key = response["serviceAccountToken"]["key"]
    new_token_id = str(response["serviceAccountToken"]["id"])
    logger.info("Created new token ID: %s", new_token_id)

    # 3. Store the new token in Secrets Manager.
    #    If storage fails, delete the new token to avoid a leak.
    secret_value = json.dumps(
        {
            "token": new_token_key,
            "tokenId": new_token_id,
            "workspaceId": WORKSPACE_ID,
            "serviceAccountId": SERVICE_ACCOUNT_ID,
        }
    )
    try:
        secretsmanager.put_secret_value(
            SecretId=SECRET_ARN,
            SecretString=secret_value,
        )
    except ClientError as exc:
        logger.error("Failed to store token in Secrets Manager: %s", exc)
        logger.info("Rolling back: deleting newly created token %s", new_token_id)
        try:
            grafana.delete_workspace_service_account_token(
                workspaceId=WORKSPACE_ID,
                serviceAccountId=SERVICE_ACCOUNT_ID,
                tokenId=new_token_id,
            )
            logger.info("Rollback successful: deleted token %s", new_token_id)
        except ClientError as rollback_exc:
            logger.error(
                "Rollback failed, orphaned token %s: %s", new_token_id, rollback_exc
            )
        raise
    logger.info("Stored new token in Secrets Manager")

    # 4. Delete the old token (if it existed and differs from the new one)
    if old_token_id and old_token_id != new_token_id:
        try:
            grafana.delete_workspace_service_account_token(
                workspaceId=WORKSPACE_ID,
                serviceAccountId=SERVICE_ACCOUNT_ID,
                tokenId=old_token_id,
            )
            logger.info("Deleted old token ID: %s", old_token_id)
        except ClientError:
            logger.info("Old token %s already deleted or not found", old_token_id)

    return {
        "statusCode": 200,
        "body": json.dumps({"message": "Token rotated", "newTokenId": new_token_id}),
    }
