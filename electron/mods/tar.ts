import { exec } from 'node:child_process'

export interface TarRunner {
  (
    command: string,
    options: { encoding: 'utf8'; timeout: number },
    done: (error: Error | null) => void,
  ): void
}

const runTar: TarRunner = (command, options, done) => {
  exec(command, options, (error) => done(error))
}

export function extractMrpackWithTar(
  archive: string,
  destination: string,
  run: TarRunner = runTar,
): Promise<void> {
  return new Promise((resolve, reject) => {
    run(`tar -xf "${archive}" -C "${destination}"`, { encoding: 'utf8', timeout: 60000 }, (error) => {
      if (error) reject(new Error('mrpack konnte nicht entpackt werden'))
      else resolve()
    })
  })
}
