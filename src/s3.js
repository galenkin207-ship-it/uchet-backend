// Обёртка над S3-совместимым хранилищем (Beget Object Storage) для фото записей.
// Все функции принимают/возвращают "относительные пути" вида "<recordId>/<filename>"
// или "trash/<trashName>/<filename>" — как они хранятся в record_photos.file_path —
// и сами добавляют/убирают S3_PREFIX (окружение prod/staging делят один бакет).
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const S3_PREFIX = process.env.S3_PREFIX || "";
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PRESIGN_EXPIRY_SECONDS = Number(process.env.S3_PRESIGN_EXPIRY_SECONDS) || 900;

// forcePathStyle не задаём: Beget ожидает virtual-hosted стиль (бакет как
// поддомен эндпоинта), это поведение SDK по умолчанию.
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

export function buildKey(relativePath) {
  return `${S3_PREFIX}${relativePath}`;
}

function stripPrefix(key) {
  return key.startsWith(S3_PREFIX) ? key.slice(S3_PREFIX.length) : key;
}

export async function putPhoto(relativePath, buffer, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: buildKey(relativePath),
      Body: buffer,
      ContentType: contentType,
    }),
  );
}

export async function getPresignedUrl(relativePath) {
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: buildKey(relativePath) });
  return getSignedUrl(client, command, { expiresIn: S3_PRESIGN_EXPIRY_SECONDS });
}

export async function deleteObject(relativePath) {
  await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: buildKey(relativePath) }));
}

export async function objectExists(relativePath) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: buildKey(relativePath) }));
    return true;
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

export async function copyObject(fromRelativePath, toRelativePath) {
  await client.send(
    new CopyObjectCommand({
      Bucket: S3_BUCKET,
      Key: buildKey(toRelativePath),
      CopySource: `/${S3_BUCKET}/${encodeURIComponent(buildKey(fromRelativePath)).replace(/%2F/g, "/")}`,
    }),
  );
}

// Возвращает относительные пути (без S3_PREFIX), как и остальной код.
export async function listByPrefix(relativePrefix) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: buildKey(relativePrefix),
        ContinuationToken,
      }),
    );
    for (const obj of res.Contents || []) {
      keys.push(stripPrefix(obj.Key));
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

export async function deleteByPrefix(relativePrefix) {
  const keys = await listByPrefix(relativePrefix);
  if (!keys.length) return;
  // DeleteObjectsCommand принимает максимум 1000 объектов за раз.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: S3_BUCKET,
        Delete: { Objects: batch.map((key) => ({ Key: buildKey(key) })) },
      }),
    );
  }
}
