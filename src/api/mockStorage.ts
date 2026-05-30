import type { Express, Request } from "express";
import {
  CONTACT_FEEDBACK_S3_PREFIX,
  MOCK_STORAGE_UPLOAD_MAX_FORM_BYTES,
  MOCK_STORAGE_UPLOAD_PATH,
  PERSONAL_MEDIA_UPLOAD_S3_PREFIX,
} from "../constants";
import { getMockStore } from "../repositories/mockStore";
import { config } from "../services/configService";

type MultipartPart = {
  name: string;
  filename?: string;
  contentType?: string;
  body: Buffer;
};

class MockStorageUploadError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

const CRLF = Buffer.from("\r\n");
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
const ALLOWED_PREFIXES = [
  CONTACT_FEEDBACK_S3_PREFIX,
  PERSONAL_MEDIA_UPLOAD_S3_PREFIX,
];

const headerValue = (req: Request, name: string) => {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const getMultipartBoundary = (req: Request) => {
  const contentType = headerValue(req, "content-type");
  const match = contentType?.match(
    /^multipart\/form-data(?:;|$).*?boundary=(?:"([^"]+)"|([^;]+))/i,
  );
  return match?.[1] ?? match?.[2]?.trim();
};

const readRequestBody = (req: Request) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MOCK_STORAGE_UPLOAD_MAX_FORM_BYTES) {
        reject(new MockStorageUploadError("Upload is too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const stripBoundaryCrlf = (body: Buffer) =>
  body.subarray(body.length - CRLF.length).equals(CRLF)
    ? body.subarray(0, body.length - CRLF.length)
    : body;

const splitMultipartBody = (body: Buffer, boundary: string) => {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = body.indexOf(delimiter);
  if (start === -1) return parts;

  start += delimiter.length;
  while (start < body.length) {
    if (body.subarray(start, start + 2).toString() === "--") break;
    if (body.subarray(start, start + CRLF.length).equals(CRLF)) {
      start += CRLF.length;
    }
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    parts.push(stripBoundaryCrlf(body.subarray(start, next)));
    start = next + delimiter.length;
  }

  return parts;
};

const parsePartHeaders = (headerBlock: Buffer) => {
  const headers = new Map<string, string>();
  for (const line of headerBlock.toString("utf8").split("\r\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    headers.set(
      line.slice(0, separatorIndex).trim().toLowerCase(),
      line.slice(separatorIndex + 1).trim(),
    );
  }
  return headers;
};

const parseContentDisposition = (value: string | undefined) => {
  const result: { name?: string; filename?: string } = {};
  for (const segment of value?.split(";") ?? []) {
    const [rawKey, rawValue] = segment.split("=");
    const key = rawKey?.trim().toLowerCase();
    if (key !== "name" && key !== "filename") continue;
    result[key] = rawValue?.trim().replace(/^"|"$/g, "");
  }
  return result;
};

const parseMultipartParts = (body: Buffer, boundary: string) =>
  splitMultipartBody(body, boundary).map((partBody) => {
    const headerEnd = partBody.indexOf(HEADER_SEPARATOR);
    if (headerEnd === -1) {
      throw new MockStorageUploadError("Malformed upload form.");
    }
    const headers = parsePartHeaders(partBody.subarray(0, headerEnd));
    const disposition = parseContentDisposition(
      headers.get("content-disposition"),
    );
    if (!disposition.name) {
      throw new MockStorageUploadError("Upload form field is missing a name.");
    }
    return {
      name: disposition.name,
      filename: disposition.filename,
      contentType: headers.get("content-type"),
      body: partBody.subarray(headerEnd + HEADER_SEPARATOR.length),
    } satisfies MultipartPart;
  });

const parseMockUpload = async (req: Request) => {
  const boundary = getMultipartBoundary(req);
  if (!boundary) {
    throw new MockStorageUploadError("Expected a multipart upload form.");
  }

  const parts = parseMultipartParts(await readRequestBody(req), boundary);
  const fields = new Map<string, string>();
  let file: MultipartPart | undefined;
  for (const part of parts) {
    if (part.name === "file") {
      file = part;
      continue;
    }
    fields.set(part.name, part.body.toString("utf8"));
  }

  const key = fields.get("key");
  if (!key || !ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    throw new MockStorageUploadError("Upload key is not allowed.");
  }
  if (!file) {
    throw new MockStorageUploadError("Upload form is missing a file.");
  }
  const maxBytes = Number.parseInt(
    fields.get("x-chronote-max-bytes") ?? "",
    10,
  );
  if (Number.isFinite(maxBytes) && file.body.byteLength > maxBytes) {
    throw new MockStorageUploadError("Upload is too large.", 413);
  }
  const expectedContentType = fields.get("Content-Type");
  if (
    expectedContentType &&
    file.contentType &&
    file.contentType !== expectedContentType
  ) {
    throw new MockStorageUploadError("Upload content type did not match.");
  }

  return { key, body: file.body };
};

export function registerMockStorageRoutes(app: Express) {
  if (!config.mock.enabled) return;

  app.post(MOCK_STORAGE_UPLOAD_PATH, async (req, res) => {
    try {
      const upload = await parseMockUpload(req);
      getMockStore().objectsByKey.set(upload.key, upload.body);
      res.status(204).end();
    } catch (error) {
      const uploadError =
        error instanceof MockStorageUploadError ? error : undefined;
      if (!uploadError) console.error("Unexpected mock storage error", error);
      res.status(uploadError?.status ?? 500).json({
        error: uploadError?.message ?? "Mock storage upload failed.",
      });
    }
  });
}
