declare module 'unzipper' {
  import type { Readable } from 'node:stream'

  interface Entry {
    path: string
    type: string
    compressedSize: number
    uncompressedSize: number
    stream(password?: string): Readable
  }

  interface Directory {
    files: Entry[]
  }

  const unzipper: {
    Open: {
      file(path: string, options?: unknown): Promise<Directory>
    }
  }

  export default unzipper
}
