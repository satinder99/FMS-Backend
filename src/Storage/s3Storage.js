// [BACKEND · Express] src/Storage/s3Storage.js
// Files go to a PRIVATE AWS S3 bucket (encrypted at rest). Nothing here makes an object public: the API
// reads each object itself and sends it only to people who are allowed to have it.
//
// Credentials are NOT read here. The AWS SDK finds them the standard way: an IAM role on the server
// (best), or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment. Never commit them.

/**
 * `deps` lets tests pass a fake client; in the app it is left out and the real SDK is loaded.
 */
function createS3Storage({ bucket, region, deps }) {
  if (!bucket) throw new Error('AWS_S3_BUCKET is not set.');
  if (!region) throw new Error('AWS_REGION is not set.');

  const sdk = deps || require('@aws-sdk/client-s3');
  const client = deps && deps.client ? deps.client : new sdk.S3Client({ region });

  return {
    provider: 's3',
    bucket,
    async put({ key, body, contentType }) {
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
        })
      );
    },
    /** A readable stream of the object. Throws (before anything is sent to the browser) if it is missing. */
    async getStream(key) {
      const res = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
      return res.Body;
    },
    async remove(key) {
      await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    /** The object's address, saved in the database. The bucket is private, so it does not open in a browser. */
    urlFor(key) {
      return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
    },
  };
}

module.exports = { createS3Storage };
