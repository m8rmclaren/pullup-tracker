import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { type ObjectStore, type PutCondition, PreconditionFailed } from './store';

export class S3Store implements ObjectStore {
  constructor(
    private s3: S3Client,
    private bucket: string,
  ) {}

  async get(key: string) {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { body: await res.Body!.transformToString(), etag: res.ETag! };
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  async put(key: string, body: string, cond: PutCondition) {
    try {
      const res = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          ...('ifMatch' in cond ? { IfMatch: cond.ifMatch } : { IfNoneMatch: '*' }),
        }),
      );
      return res.ETag!;
    } catch (err) {
      // 412: the ETag moved. 409: a concurrent conditional write to the same key is in flight.
      if (err instanceof S3ServiceException && (err.$metadata.httpStatusCode === 412 || err.$metadata.httpStatusCode === 409)) {
        throw new PreconditionFailed();
      }
      throw err;
    }
  }

  async list(prefix: string) {
    const out: { key: string; etag: string }[] = [];
    let token: string | undefined;
    do {
      const res = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) out.push({ key: o.Key!, etag: o.ETag! });
      token = res.NextContinuationToken;
    } while (token);
    return out;
  }
}
