// [BACKEND · Express] src/Storage/index.js
// Chooses where uploaded files live.
//   STORAGE_DRIVER=s3    AWS S3.  Needs AWS_S3_BUCKET and AWS_REGION (+ AWS credentials, see s3Storage.js)
//   STORAGE_DRIVER=disk  a local folder (LOCAL_UPLOAD_DIR, default ./uploads). Development only.
// Left unset: S3 if AWS_S3_BUCKET is set; otherwise disk, except in production where it refuses to start
// uploading rather than quietly writing to a disk that is wiped on every deploy.
const path = require('path');
const { createS3Storage } = require('./s3Storage');
const { createDiskStorage } = require('./diskStorage');

let instance = null;

function chooseDriver(env) {
  const wanted = (env.STORAGE_DRIVER || '').toLowerCase();
  if (wanted === 's3' || wanted === 'disk') return wanted;
  if (wanted) throw new Error('STORAGE_DRIVER must be "s3" or "disk".');
  if (env.AWS_S3_BUCKET) return 's3';
  if (env.NODE_ENV === 'production') {
    throw new Error('File storage is not configured. Set AWS_S3_BUCKET and AWS_REGION (or STORAGE_DRIVER=disk for a test server).');
  }
  return 'disk';
}

function buildStorage(env = process.env) {
  if (chooseDriver(env) === 's3') return createS3Storage({ bucket: env.AWS_S3_BUCKET, region: env.AWS_REGION });
  return createDiskStorage({ rootDir: env.LOCAL_UPLOAD_DIR || path.join(process.cwd(), 'uploads') });
}

/** Created on first use, so the app starts even before storage is configured. */
function getStorage() {
  if (!instance) instance = buildStorage();
  return instance;
}

module.exports = { getStorage, buildStorage, chooseDriver };
