import crypto from "node:crypto";
import { config } from "./configService";

const CIPHER = "aes-256-gcm";
const ENCRYPTION_VERSION = "v1";
const IV_BYTES = 12;

const getEncryptionKey = () => {
  const secret = config.notion.tokenEncryptionSecret;
  if (!secret) {
    throw new Error("Notion token encryption secret is not configured.");
  }
  return crypto.createHash("sha256").update(secret).digest();
};

export const encryptToken = (value: string): string => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
};

export const decryptToken = (value: string): string => {
  const [version, ivValue, tagValue, encryptedValue] = value.split(":");
  if (
    version !== ENCRYPTION_VERSION ||
    !ivValue ||
    !tagValue ||
    !encryptedValue
  ) {
    throw new Error("Unsupported encrypted token format.");
  }
  const decipher = crypto.createDecipheriv(
    CIPHER,
    getEncryptionKey(),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};
