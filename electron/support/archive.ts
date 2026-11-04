import AdmZip from 'adm-zip'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeSupportArchive(
  destination: string,
  files: Record<string, Buffer>,
): Promise<number> {
  await mkdir(dirname(destination), { recursive: true })
  const zip = new AdmZip()
  for (const [name, buffer] of Object.entries(files)) zip.addFile(name, buffer)

  const temp = `${destination}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    zip.writeZip(temp)
    try {
      await rename(temp, destination)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'EPERM') throw error
      await rm(destination, { force: true })
      await rename(temp, destination)
    }
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }

  return (await stat(destination)).size
}
