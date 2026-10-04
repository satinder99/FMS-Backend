// [BACKEND · Express] src/Services/documentService.js
// Trip documents. The driver uploads a proof of delivery (a photo from the camera or gallery, or a PDF); the
// file is stored in S3 and its address is saved in the database. Dispatchers download one file, or every
// document of a trip as one ZIP. Every request is checked against the caller's organization (and, for
// drivers, their own trips) before a single byte is read from storage.
const crypto = require('crypto');
const pool = require('../config/dbConfig');
const { AppError } = require('../Errors/errors');
const { getStorage } = require('../Storage');
const { detectFileType, cleanFilename, extensionFor } = require('../Utils/fileType');
const { ZipWriter } = require('../Utils/zipWriter');
const { fetchTrips } = require('./tripService');
const { DOCUMENT_TYPES, MAX_FILE_BYTES, MAX_DOCS_PER_TYPE, driverUploadTypes, reference, downloadNameFor } = require('./documentTypes');

function isMissingFile(err) {
  return err && (err.code === 'ENOENT' || err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404));
}

async function openStored(doc) {
  const storage = getStorage();
  if (doc.storage_provider !== storage.provider) {
    throw new AppError('This file is stored somewhere the server is not set up to read.', 503, 'STORAGE_UNAVAILABLE');
  }
  try {
    return await storage.getStream(doc.storage_key);
  } catch (err) {
    if (isMissingFile(err)) throw new AppError('The file is missing from storage. Ask the driver to upload it again.', 404, 'FILE_MISSING');
    throw err;
  }
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ driver

/** `file` is what multer produced: { buffer, originalname, size }. */
async function uploadForDriver({ tripId, orgId, driverId, userId, docType, file }) {
  const type = DOCUMENT_TYPES[docType];
  if (!type || !type.driverCanUpload) throw new AppError('That kind of document cannot be uploaded here.', 400, 'INVALID_INPUT');
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new AppError('Choose a photo or a PDF to upload.', 400, 'NO_FILE');
  }
  if (file.buffer.length > MAX_FILE_BYTES) throw new AppError('That file is too large (15 MB maximum).', 413, 'FILE_TOO_LARGE');

  // What the file really is, from its contents, not from its name or what the browser says.
  const detected = detectFileType(file.buffer);
  if (!detected) {
    throw new AppError('Only photos (JPG, PNG, WebP, HEIC) and PDF files can be uploaded.', 400, 'UNSUPPORTED_FILE');
  }

  // The trip must be this driver's, the proof-of-delivery step must exist and be in progress.
  const row = (
    await pool.query(
      `SELECT t.id, c.id AS step_id, c.started_at, c.completed_at,
              (SELECT COUNT(*) FROM trip_documents d
                WHERE d.trip_id = t.id AND d.doc_type = $5 AND d.deleted_at IS NULL) AS doc_count
         FROM trips t
         LEFT JOIN trip_checkpoints c ON c.trip_id = t.id AND c.key = $4
        WHERE t.id = $1 AND t.org_id = $2 AND t.driver_id = $3 AND t.status <> 'cancelled'`,
      [tripId, orgId, driverId, type.stepKey, docType]
    )
  ).rows[0];
  if (!row) throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
  if (!row.step_id) throw new AppError('This trip has no proof-of-delivery step.', 409, 'NO_POD_STEP');
  if (!row.started_at) throw new AppError('Start the proof-of-delivery step first, then upload the file.', 409, 'STEP_NOT_STARTED');
  if (row.completed_at) {
    throw new AppError('This step is already complete. Undo it first if you need to add or replace a file.', 409, 'STEP_COMPLETED');
  }
  if (Number(row.doc_count) >= MAX_DOCS_PER_TYPE) {
    throw new AppError(`A trip can have at most ${MAX_DOCS_PER_TYPE} files of this kind. Remove one first.`, 409, 'TOO_MANY_FILES');
  }

  const storage = getStorage();
  // The key is made by the server. The driver's file name never becomes part of a path.
  const key = `orgs/${orgId}/trips/${tripId}/${docType}/${crypto.randomUUID()}.${detected.ext}`;
  await storage.put({ key, body: file.buffer, contentType: detected.mime });
  try {
    await pool.query(
      `INSERT INTO trip_documents
         (org_id, trip_id, doc_type, checkpoint_key, original_filename, content_type, size_bytes,
          storage_provider, storage_bucket, storage_key, url, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [orgId, tripId, docType, type.stepKey, cleanFilename(file.originalname, detected.ext), detected.mime, file.buffer.length,
       storage.provider, storage.bucket, key, storage.urlFor(key), userId]
    );
  } catch (err) {
    await storage.remove(key).catch(() => {}); // do not leave an orphan file behind
    throw err;
  }
  return (await fetchTrips(pool, { orgId, tripId }))[0];
}

/** A driver can remove a file only while the step is still open (before they complete it). */
async function deleteForDriver({ docId, orgId, driverId, userId }) {
  const doc = (
    await pool.query(
      `SELECT d.id, d.trip_id, d.storage_provider, d.storage_key, c.completed_at
         FROM trip_documents d
         JOIN trips t ON t.id = d.trip_id
         LEFT JOIN trip_checkpoints c ON c.trip_id = d.trip_id AND c.key = d.checkpoint_key
        WHERE d.id = $1 AND d.org_id = $2 AND t.driver_id = $3 AND d.deleted_at IS NULL AND d.doc_type = ANY($4)`,
      [docId, orgId, driverId, driverUploadTypes()]
    )
  ).rows[0];
  if (!doc) throw new AppError('File not found.', 404, 'NOT_FOUND');
  if (doc.completed_at) {
    throw new AppError('This step is already complete, so its files are locked. Undo the step first to change them.', 409, 'STEP_COMPLETED');
  }

  await pool.query(`UPDATE trip_documents SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [docId, userId]);
  try {
    const storage = getStorage();
    if (storage.provider === doc.storage_provider) await storage.remove(doc.storage_key);
  } catch (err) {
    console.error('Could not remove a deleted file from storage:', err.message); // the record is already marked deleted
  }
  return (await fetchTrips(pool, { orgId, tripId: Number(doc.trip_id) }))[0];
}

// ------------------------------------------------------------------ dispatcher downloads

/** A trip's files in a stable order, each with its position among files of the same kind. */
async function loadDocs(db, tripId, orgId) {
  const { rows } = await db.query(
    `SELECT d.id, d.doc_type, d.content_type, d.size_bytes, d.storage_provider, d.storage_key,
            ROW_NUMBER() OVER (PARTITION BY d.doc_type ORDER BY d.uploaded_at, d.id) AS n
       FROM trip_documents d
      WHERE d.trip_id = $1 AND d.org_id = $2 AND d.deleted_at IS NULL
      ORDER BY d.doc_type, d.uploaded_at, d.id`,
    [tripId, orgId]
  );
  return rows;
}

const downloadName = (tripId, doc) => downloadNameFor(tripId, doc.doc_type, doc.n, extensionFor(doc.content_type));

/** One document, for a dispatcher of the same organization. */
async function openDocument({ docId, orgId }) {
  const found = (
    await pool.query(`SELECT trip_id FROM trip_documents WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [docId, orgId])
  ).rows[0];
  if (!found) throw new AppError('File not found.', 404, 'NOT_FOUND');

  const tripId = Number(found.trip_id);
  const doc = (await loadDocs(pool, tripId, orgId)).find((d) => Number(d.id) === docId);
  if (!doc) throw new AppError('File not found.', 404, 'NOT_FOUND');

  const stream = await openStored(doc);
  return { stream, filename: downloadName(tripId, doc), contentType: doc.content_type, size: doc.size_bytes };
}

/**
 * Every document of one trip as a single ZIP: TRP-000012/POD/TRP-000012-POD-1.jpg ... (one folder per kind).
 * `res` is the HTTP response. Everything that can be checked is checked BEFORE the first byte is sent.
 */
async function streamTripZip({ tripId, orgId, res }) {
  const trip = (await pool.query(`SELECT id FROM trips WHERE id = $1 AND org_id = $2`, [tripId, orgId])).rows[0];
  if (!trip) throw new AppError('Trip not found.', 404, 'TRIP_NOT_FOUND');
  const docs = await loadDocs(pool, tripId, orgId);
  if (docs.length === 0) throw new AppError('This trip has no documents yet.', 404, 'NO_DOCUMENTS');

  const ref = reference(tripId);
  const first = await streamToBuffer(await openStored(docs[0])); // fail cleanly now if storage is unreachable

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${ref}-documents.zip"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const zip = new ZipWriter(res);
  try {
    for (let i = 0; i < docs.length; i++) {
      const data = i === 0 ? first : await streamToBuffer(await openStored(docs[i]));
      const folder = DOCUMENT_TYPES[docs[i].doc_type]?.folder ?? docs[i].doc_type.toUpperCase();
      await zip.addFile(`${ref}/${folder}/${downloadName(tripId, docs[i])}`, data);
    }
    await zip.finish();
  } catch (err) {
    res.destroy(err); // headers are already sent: end the download as failed rather than hand over a broken zip
  }
}

module.exports = { uploadForDriver, deleteForDriver, openDocument, streamTripZip, loadDocs, downloadName, reference };
