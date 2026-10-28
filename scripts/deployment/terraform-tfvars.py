import json
import os
from pathlib import Path

path = Path("_infra/terraform.auto.tfvars.json")
data = json.loads(os.environ["TERRAFORM_TFVARS_JSON"])
aws_access_key_id = os.environ.get("AWS_ACCESS_KEY_ID", "").strip()
if aws_access_key_id:
    data["AWS_TOKEN_KEY"] = aws_access_key_id

for name in ["REDIS_AUTH_TOKEN", "REDIS_URL"]:
    value = os.environ.get(name, "").strip()
    if value:
        data[name] = value

# Terraform inputs that are not credentials belong in GitHub Actions
# variables rather than in the write-only tfvars secret. A variable can
# be read, diffed and changed on its own, where editing one key in the
# secret means rewriting a blob that also carries credentials, so in
# practice non-secret flags there are unreadable and never get changed.
# Any variable named TFVAR_<KEY> overrides <KEY>.
credential_tfvars = {
    "GITHUB_TOKEN",
    "AWS_TOKEN_KEY",
    "LANGFUSE_SECRET_KEY",
    "DOCS_ALGOLIA_API_KEY",
    "REDIS_AUTH_TOKEN",
    "REDIS_URL",
    "grafana_api_key",
}
collection_keys = {
    "production_introduction_task_definitions",
    "production_introduction_standalone_tasks",
    "production_acceptance_fixtures",
}
canonical_keys = collection_keys | {
    "frontend_distribution_id",
    "docs_distribution_id",
    "enable_production_introduction_roles",
    "enable_production_acceptance_collector",
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def decode_json(value):
    try:
        return json.loads(value, object_pairs_hook=unique_object)
    except (ValueError, TypeError):
        raise SystemExit("Invalid Terraform variable JSON; values are not logged.") from None


def collection_value(key, value):
    parsed = decode_json(value)
    valid = isinstance(parsed, list)
    if valid and key == "production_acceptance_fixtures":
        fields = {"guild_id", "voice_channel_id", "meeting_id"}
        valid = all(
            isinstance(item, dict)
            and set(item) == fields
            and all(isinstance(member, str) for member in item.values())
            for item in parsed
        )
    elif valid:
        valid = all(isinstance(item, str) for item in parsed)
    if not valid:
        raise SystemExit("Invalid declared Terraform collection shape; values are not logged.")
    return parsed


github_vars = decode_json(os.environ.get("GITHUB_VARS_JSON") or "{}")
if not isinstance(github_vars, dict):
    raise SystemExit("GitHub Terraform variables must be a JSON object.")
# Refuse credential overrides before decoding any collection payload.
for name in github_vars:
    if name.startswith("TFVAR_") and name[len("TFVAR_") :] in credential_tfvars:
        raise SystemExit("TFVAR would override a credential. Credentials belong in TERRAFORM_TFVARS_JSON.")

seen = set()
for name, value in github_vars.items():
    if not name.startswith("TFVAR_"):
        continue
    key = name[len("TFVAR_") :]
    if key.lower() in canonical_keys:
        key = key.lower()
        if key in seen:
            raise SystemExit("Ambiguous declared Terraform variable aliases.")
        seen.add(key)
    if key in collection_keys:
        data[key] = collection_value(key, value)
    elif str(value).strip():
        data[key] = str(value).strip()

required = ["GITHUB_TOKEN", "AWS_TOKEN_KEY", "DISCORD_CLIENT_ID"]
string_fields = required + [
    "SUPER_ADMIN_USER_IDS",
    "grafana_api_key",
    "grafana_url",
    "grafana_service_account_id",
]
for name in string_fields:
    value = data.get(name)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        non_empty_items = [item for item in value if item.strip()]
        if len(non_empty_items) == 1:
            data[name] = non_empty_items[0]

def describe_type(value):
    if isinstance(value, list):
        item_types = sorted({type(item).__name__ for item in value})
        return f"list length {len(value)} with item types {item_types}"
    return type(value).__name__

wrong_type = [
    f"{name} ({describe_type(data[name])})"
    for name in string_fields
    if name in data and data[name] is not None and not isinstance(data[name], str)
]
if wrong_type:
    raise SystemExit(
        "Terraform variables must be JSON strings: " + ", ".join(wrong_type)
    )

path.write_text(json.dumps(data, separators=(",", ":")))

missing = [name for name in required if not data.get(name)]
if missing:
    raise SystemExit(
        "Missing required Terraform variables in TERRAFORM_TFVARS_JSON: "
        + ", ".join(missing)
    )

if data.get("grafana_api_key"):
    raise SystemExit(
        "grafana_api_key must be empty after Grafana token rotation is active. "
        "Use grafana_service_account_id plus the Secrets Manager token instead."
    )

if data.get("grafana_url") and not data.get("grafana_service_account_id"):
    raise SystemExit(
        "grafana_service_account_id is required when grafana_url is configured."
    )
