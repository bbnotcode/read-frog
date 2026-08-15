import { useEffect, useState } from "react"
import { Switch } from "@/components/ui/base-ui/switch"
import { sendMessage } from "@/utils/message"
import {
  getVocabularyHunterState,
  watchVocabularyHunterState,
} from "@/utils/vocabulary-hunter/storage"

export function VocabularyHunterToggle() {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    void getVocabularyHunterState().then((state) => setEnabled(state.enabled))
    return watchVocabularyHunterState((state) => setEnabled(state.enabled))
  }, [])

  const updateEnabled = async (nextEnabled: boolean) => {
    setEnabled(nextEnabled)
    await sendMessage("patchVocabularyPreferences", { enabled: nextEnabled })
  }

  return (
    <label className="flex items-center justify-between">
      <span className="text-[13px] font-medium">生词猎手</span>
      <Switch checked={enabled} onCheckedChange={(checked) => void updateEnabled(checked)} />
    </label>
  )
}
