import React, { useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import changelogMarkdown from '../../../CHANGELOG.md?raw'
import { parseChangelog } from '../../lib/changelog'
import type { LanguageType } from '../../lib/translations'
import { Dialog } from '../Dialog'
import { dialogButton } from '../dialogSupport'
import { copyFor } from '../onboarding/onboardingCopy'

interface ChangelogDialogProps {
  open: boolean
  version: string
  lang: LanguageType
  onClose: () => void
}

export const ChangelogDialog: React.FC<ChangelogDialogProps> = ({ open, version, lang, onClose }) => {
  const copy = copyFor(lang)
  const entry = useMemo(() => parseChangelog(changelogMarkdown, version, lang), [version, lang])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={copy.changelogTitle(version)}
      titleId="changelog-dialog-title"
      closeLabel={copy.close}
      icon={<Sparkles className="h-4 w-4" />}
      tone="accent"
      widthClassName="w-[520px]"
      footer={
        <button onClick={onClose} className={dialogButton.accent} data-autofocus>
          {copy.close}
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        {entry?.groups.map((group) => (
          <section key={group.title}>
            <h3 className="flex items-center gap-2 text-small font-semibold text-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {group.title}
            </h3>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {group.items.map((item) => (
                <li key={item} className="flex gap-2 text-small leading-relaxed text-ink-secondary">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-stroke-strong" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="text-mini text-ink-tertiary">{copy.changelogFoot}</p>
      </div>
    </Dialog>
  )
}
