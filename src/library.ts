/** Public, serializable notebook-library contracts shared by the editor and Home. */
export interface LibraryEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  pageCount: number;
  previewDataUrl?: string;
  sourcePath?: string;
  deletedAt?: string;
  /** The files remain on disk; reading the affected note reports the repair error. */
  error?: string;
}

export interface LibraryReadResult { entry: LibraryEntry; data: string }
export interface LibraryImportResult extends LibraryReadResult { imported: boolean }
