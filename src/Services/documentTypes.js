// [BACKEND · Express] src/Services/documentTypes.js
// The kinds of documents a trip can have. Today only the driver's proof of delivery (POD) can be uploaded.
// To add another (BOL, itinerary, immigration papers) add a line here, allow it in the database list
// (trip_documents.doc_type already does), and build its screen. Nothing else changes.

/** The step the proof of delivery belongs to. It must be completed only after a POD file is uploaded. */
const POD_STEP_KEY = 'pod_upload';

const DOCUMENT_TYPES = {
  pod: {
    label: 'Proof of delivery',
    folder: 'POD', // folder name inside the "download all" zip, and part of each file's download name
    stepKey: POD_STEP_KEY,
    driverCanUpload: true,
  },
};

const MAX_FILE_BYTES = 15 * 1024 * 1024; // a modern phone photo is 3-8 MB
const MAX_DOCS_PER_TYPE = 10; // files per trip for one document type (e.g. a multi-page POD)

/** TRP-000012 : the trip's reference, as shown everywhere. */
const reference = (tripId) => `TRP-${String(tripId).padStart(6, '0')}`;

/** TRP-000012-POD-1.jpg : meaningful, unlike the camera's IMG_0231.jpg. `n` = position among files of that kind. */
const downloadNameFor = (tripId, docType, n, ext) =>
  `${reference(tripId)}-${DOCUMENT_TYPES[docType]?.folder ?? String(docType).toUpperCase()}-${n}.${ext}`;

const driverUploadTypes = () => Object.keys(DOCUMENT_TYPES).filter((t) => DOCUMENT_TYPES[t].driverCanUpload);

module.exports = { POD_STEP_KEY, DOCUMENT_TYPES, MAX_FILE_BYTES, MAX_DOCS_PER_TYPE, driverUploadTypes, reference, downloadNameFor };
