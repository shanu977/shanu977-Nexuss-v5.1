import { useChatStore } from "@/store/chatStore";
import { useLocalModelStore } from "@/store/localModelStore";

/**
 * Select a local model (Ollama, LM Studio, vLLM, ...) as the active chat model.
 *
 * This is the single selection path shared by the composer's model menu and
 * Settings → Models. It reuses the existing chat-store selection semantics
 * (provider "local" + model id) and, when the model was only discovered but not
 * persisted yet, saves it as a LocalModel so the selection survives reloads.
 *
 * Persistence is best-effort: a selection still applies for the current session
 * even if the LocalModel row could not be written (e.g. not authenticated).
 */
export async function selectLocalModel(modelId: string): Promise<void> {
  const trimmed = modelId.trim();
  if (!trimmed) return;

  const local = useLocalModelStore.getState();
  const alreadyPersisted = local.models.some((m) => m.modelId === trimmed);

  if (!alreadyPersisted) {
    try {
      let provider = local.providers.find((p) => p.providerType === "ollama");
      if (!provider) {
        provider = await local.addProvider({
          name: "Ollama",
          providerType: "ollama",
          endpoint: "http://localhost:11434/v1",
        });
      }
      await local.addModel(provider.id, trimmed, trimmed);
    } catch {
      // Best-effort persistence — keep the in-session selection usable.
    }
  }

  const chat = useChatStore.getState();
  if (chat.provider !== "local") chat.setProvider("local");
  chat.setModel(trimmed);
}
