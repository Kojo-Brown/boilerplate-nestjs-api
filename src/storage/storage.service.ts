import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignedUrlResult {
  url: string;
  key: string;
  expiresAt: Date;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client | null = null;
  private readonly bucket: string | null = null;

  constructor(private readonly config: ConfigService) {
    const bucket = config.get<string>("S3_BUCKET");
    const accessKeyId = config.get<string>("S3_ACCESS_KEY_ID");
    const secretAccessKey = config.get<string>("S3_SECRET_ACCESS_KEY");

    if (bucket && accessKeyId && secretAccessKey) {
      const endpoint = config.get<string>("S3_ENDPOINT");
      this.bucket = bucket;
      this.client = new S3Client({
        region: config.get<string>("S3_REGION") ?? "us-east-1",
        credentials: { accessKeyId, secretAccessKey },
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      });
    }
  }

  private requireClient(): { client: S3Client; bucket: string } {
    if (!this.client || !this.bucket) {
      throw new ServiceUnavailableException(
        "S3 storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.",
      );
    }
    return { client: this.client, bucket: this.bucket };
  }

  async uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<string> {
    const { client, bucket } = this.requireClient();
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }),
    );
    return key;
  }

  async getPresignedPutUrl(key: string, contentType: string, expiresIn = 3600): Promise<PresignedUrlResult> {
    const { client, bucket } = this.requireClient();
    const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
    const url = await getSignedUrl(client, command, { expiresIn });
    return { url, key, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async getPresignedGetUrl(key: string, expiresIn = 3600): Promise<PresignedUrlResult> {
    const { client, bucket } = this.requireClient();
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const url = await getSignedUrl(client, command, { expiresIn });
    return { url, key, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }
}
