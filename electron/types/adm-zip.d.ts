declare module 'adm-zip' {
  interface AdmZipEntry {
    entryName: string
    isDirectory: boolean
    getData(): Buffer
    header?: { size?: number }
  }

  class AdmZip {
    constructor(fileName?: string | Buffer, options?: { readEntries?: boolean })
    getEntries(): AdmZipEntry[]
    getEntry(name: string): AdmZipEntry | null
    addFile(entryName: string, content: Buffer, comment?: string, attr?: number): void
    toBuffer(): Buffer
    writeZip(targetFileName?: string, callback?: (error: Error | null) => void): void
  }

  export = AdmZip
}
