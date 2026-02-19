"""Rotate the AWS Managed Grafana service account token.

Creates a new token, stores it in Secrets Manager, then deletes the old one.
The two-phase approach (create-then-delete) avoids any window where no valid
token exists.
"""

import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

WORKSPACE_ID = os.environ["GRAFANA_WORKSPACE_ID"]
SERVICE_ACCOUNT_ID = os.environ["GRAFANA_SERVICE_ACCOUNT_ID"]
SECRET_ARN = os.environ["GRAFANA_TOKEN_SECRET_ARN"]
TOKEN_TTL_SECONDS = int(
    os.environ.get("GRAFANA_TOKEN_TTL_SECONDS", "2592000")
)  # 30 days
REGION = os.environ.get("AWS_REGION", "us-east-1")


def handler(event, context):
    grafana = boto3.client("grafana", region_name=REGION)
    secretsmanager = boto3.client("secretsmanager", region_name=REGION)

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
    response = grafana.create_workspace_service_account_token(
        workspaceId=WORKSPACE_ID,
        serviceAccountId=SERVICE_ACCOUNT_ID,
        name=f"auto-rotated-{context.aws_request_id[:8]}",
        secondsToLive=TOKEN_TTL_SECONDS,
    )
    new_token_key = response["serviceAccountToken"]["key"]
    new_token_id = str(response["serviceAccountToken"]["id"])
    logger.info("Created new token ID: %s", new_token_id)

    # 3. Store the new token in Secrets Manager
    secret_value = json.dumps(
        {
            "token": new_token_key,
            "tokenId": new_token_id,
            "workspaceId": WORKSPACE_ID,
            "serviceAccountId": SERVICE_ACCOUNT_ID,
        }
    )
    secretsmanager.put_secret_value(
        SecretId=SECRET_ARN,
        SecretString=secret_value,
    )
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
        except grafana.exceptions.ResourceNotFoundException:
            logger.info("Old token %s already deleted", old_token_id)

    return {
        "statusCode": 200,
        "body": json.dumps({"message": "Token rotated", "newTokenId": new_token_id}),
    }
