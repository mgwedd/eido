export { createFilesWriteFacade } from "./facade"
export type { FilesWriteDeps, FileIntentReceipt } from "./facade"
export { filesManifest } from "./manifest"
export { FileError } from "./path"
export { createFilesFacade, fileSourceRef } from "./reads"
export type { FilesDeps, FilesFacade } from "./reads"
export {
  DEFAULT_NOTE_ROOTS,
  NOTE_MIMES,
  readNotesCoverage,
  searchLocalNotes,
  sliceNoteExcerpt,
} from "./notes"
export type {
  FileRootSyncCursor,
  LocalNoteExcerpt,
  LocalNoteRecord,
  NoteMime,
  NotesAvailabilityStatus,
  NotesCoverage,
  ReadNotesCoverageOptions,
  SearchLocalNotesOptions,
} from "./notes"
