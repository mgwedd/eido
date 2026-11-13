"use client"

import * as React from "react"
import { Check, Copy, Download, TriangleAlert } from "lucide-react"

import { Alert, AlertDescription } from "@eido/ui/components/alert"
import { Button } from "@eido/ui/components/button"
import { Card, CardContent } from "@eido/ui/components/card"
import { Checkbox } from "@eido/ui/components/checkbox"
import {
  RECOVERY_KEY_FILE,
  keyLines,
  recoveryKeyFileText,
} from "@/lib/recovery"

const COPIED_MS = 2_000

type CopyState = "idle" | "copied" | "failed"

const COPY_MESSAGE: Record<CopyState, string> = {
  idle: "",
  copied: "Copied",
  failed: "This browser did not allow copying. Save the key as a file instead.",
}

/** Downloads the key as a text file, then frees the object URL. */
function saveAsFile(recoveryKey: string) {
  const url = URL.createObjectURL(
    new Blob([recoveryKeyFileText(recoveryKey)], { type: "text/plain" })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = RECOVERY_KEY_FILE
  link.click()
  URL.revokeObjectURL(url)
}

/**
 * The recovery key, shown once: after the first enrolment, after a recovery completes and
 * after a cancelled recovery. The key lives in this component's props and nowhere else; the
 * parent drops it on Continue. Continue stays disabled until the owner says they saved it.
 */
function RecoveryKeyCard({
  recoveryKey,
  overline,
  onContinue,
}: {
  recoveryKey: string
  overline: string
  onContinue: () => void
}) {
  const [saved, setSaved] = React.useState(false)
  const [copy, setCopy] = React.useState<CopyState>("idle")
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  React.useEffect(() => () => clearTimeout(timer.current), [])

  const copyKey = React.useCallback(async () => {
    clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(recoveryKey)
      setCopy("copied")
      timer.current = setTimeout(() => setCopy("idle"), COPIED_MS)
    } catch {
      setCopy("failed")
    }
  }, [recoveryKey])

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <p className="text-sm font-semibold tracking-wide">Eido</p>
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col gap-5">
          <header className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {overline}
            </p>
            <h1 className="text-xl font-semibold tracking-tight">
              Save your recovery key
            </h1>
          </header>

          <div
            role="group"
            aria-label="Recovery key"
            className="flex flex-col gap-2 rounded-xl border bg-background p-4"
          >
            <span className="text-xs text-muted-foreground">Recovery key</span>
            <span className="font-mono text-xl leading-normal tracking-wide break-all">
              {keyLines(recoveryKey).map((line, index) => (
                <React.Fragment key={line}>
                  {index > 0 ? <br /> : null}
                  {line}
                </React.Fragment>
              ))}
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <Button
              type="button"
              size="lg"
              onClick={() => void copyKey()}
              className="h-12 rounded-xl"
            >
              {copy === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
              Copy key
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              onClick={() => saveAsFile(recoveryKey)}
              className="h-12 rounded-xl"
            >
              <Download aria-hidden />
              Save as file
            </Button>
            <p role="status" className="min-h-4 text-xs text-muted-foreground">
              {COPY_MESSAGE[copy]}
            </p>
          </div>

          <Alert role="note">
            <TriangleAlert aria-hidden />
            <AlertDescription>
              Shown once. Eido keeps no copy it can show again.
            </AlertDescription>
          </Alert>

          <label className="flex min-h-11 items-center gap-2.5 text-sm">
            <Checkbox
              checked={saved}
              onCheckedChange={(checked) => setSaved(checked)}
            />
            I saved this key somewhere safe
          </label>

          <Button
            type="button"
            size="lg"
            disabled={!saved}
            onClick={onContinue}
            className="h-12 rounded-xl"
          >
            Continue
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export { RecoveryKeyCard }
